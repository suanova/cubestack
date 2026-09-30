package devenv

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"golang.org/x/crypto/ssh"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// The controller's own conventions, which a test has to know to find the objects
// the controller made. They are unexported in internal/controller, so they are
// restated here rather than exported: exporting them would make the controller's
// internals part of the suite's surface, and a rename in the controller ought to
// break this package only where it changes what the suite can find.
//
// Each one is here because some assertion reads it. Nothing else about the
// controller's naming belongs in this block.
const (
	// devEnvironmentLabelKey is on the environment's pod, Service, ListenerSet and
	// routes. It is how the controller finds its own objects, and how a case finds
	// the pod it is running against.
	devEnvironmentLabelKey = "ai.cubestack.io/dev-environment"

	// workspaceVolumeName is the claim the platform mounts for the workspace. The
	// container's HOME is set to where this is, so a case can ask the pod where
	// the workspace actually is instead of re-deriving it.
	workspaceVolumeName = "workspace"

	// sshEndpointName is the Name status.Endpoints gives the ssh address. The web
	// endpoint's Name is spec.type instead, which is why ServesJupyter is the
	// catalogue's question to answer.
	sshEndpointName = "ssh"

	// Secret data keys. The secrets themselves are named by status; these are what
	// is inside them.
	jupyterTokenKey  = "token"
	sshClientKeyKey  = "id_ed25519"
	sshHostPubKeyKey = "ssh_host_ed25519_key.pub"
)

// SSHEndpointName is the name status.Endpoints gives the ssh address, exported
// for the cases that assert on the endpoint set rather than on one endpoint.
const SSHEndpointName = sshEndpointName

// The reasons the controller records on the Accepted condition, restated for the
// cases that read them. They are the contract's whole vocabulary: two say the
// environment was applied (as written, or not) and two name what the user has to
// change. A case asserting on the reason is asserting which of those the
// controller answered, so a rename here has to be a deliberate change to it.
const (
	// ReasonAccepted is a spec applied as written, with nothing resolved.
	ReasonAccepted = "Accepted"
	// ReasonOverridden is a spec the controller applied partly as something
	// else. The environment runs; the message names each field it resolved.
	ReasonOverridden = "Overridden"
	// ReasonBrandMismatch and ReasonNotebookArgsUnusable are refusals: the
	// controller will not run the spec as it stands, and only the user can fix
	// it.
	ReasonBrandMismatch        = "BrandMismatch"
	ReasonNotebookArgsUnusable = "NotebookArgsUnusable"

	// ReasonStopped is the reason on Ready when the environment is stopped on
	// purpose, which is what tells it apart from one that stopped by failing.
	// The phase's reason is the same string — both come from reasonStopped.
	ReasonStopped = "Stopped"

	// ReasonDeleting is the phase reason while the environment is being torn
	// down. The phase name for that state is aiv1alpha1.PhaseTerminating.
	ReasonDeleting = "Deleting"
)

// The environment-variable names the controller owns, restated for the cases
// that declare one in a spec and then assert what became of it — which is the
// whole of family E. They are the controller's to name, and a case holding its
// own copy of "NOTEBOOK_ARGS" would go on passing after a rename while
// asserting nothing.
const (
	// EnvHome is the variable the controller states on the container so a
	// launcher serves the workspace without having to know what its image bakes.
	EnvHome = "HOME"

	// EnvNotebookArgs carries the flags a Jupyter launcher reads, and is the
	// entry the controller merges its own base_url into.
	EnvNotebookArgs = "NOTEBOOK_ARGS"

	// NotebookBaseURLFlag is the argument the controller owns within
	// EnvNotebookArgs: the route publishes the notebook under a prefix, so the
	// notebook has to serve it.
	NotebookBaseURLFlag = "--ServerApp.base_url="

	// EnvJupyterToken is the token the notebook server is told to require. The
	// controller generates it per environment and publishes it in the Secret
	// status names.
	EnvJupyterToken = "JUPYTER_TOKEN"

	// EnvNBUser, EnvNBUID and EnvNBGID name the account a docker-stacks launcher
	// serves and the identity it serves it as. On a root environment they are
	// the controller's to set.
	EnvNBUser = "NB_USER"
	EnvNBUID  = "NB_UID"
	EnvNBGID  = "NB_GID"
)

// The ports inside the container, which are the controller's conventions and not
// the pool's: 2222 is where every image's sshd listens and 8888 is where a
// notebook server does. Neither is an allocated port — the L4 pool is the
// Gateway's side of the same endpoints.
const (
	ContainerSSHPort     = 2222
	ContainerJupyterPort = 8888
)

// The names the controller gives the pieces of the workspace claim, restated for
// the cases that read them off a pod rather than through status. None of them is
// published anywhere a user could read, so a case asserting one is asserting
// this file's copy of the convention — which is why they are here, in one block,
// rather than inline in a spec.
const (
	// WorkspaceVolumeName is the volume and mount the workspace claim is under.
	WorkspaceVolumeName = "workspace"

	// InitContainerName is the container that establishes the claim's ownership
	// before the environment's own container starts.
	InitContainerName = "initialize-managed-volume"

	// InitContainerClaimMount is where that container mounts the claim — the
	// path it chowns, which is not the path the environment sees it at.
	InitContainerClaimMount = "/managed"

	// InitWorkspacePathEnv, InitWorkspaceUIDEnv and InitWorkspaceGIDEnv are what
	// the container is told: which path to make writable, and by which identity.
	InitWorkspacePathEnv = "WORKSPACE_PATH"
	InitWorkspaceUIDEnv  = "WORKSPACE_UID"
	InitWorkspaceGIDEnv  = "WORKSPACE_GID"

	// DevEnvFinalizer is the controller's own finalizer. A case that has to know
	// whether the controller has looked at an environment at all — the ones about
	// a spec it refuses, where nothing else about the object changes — can wait on
	// this rather than on a clock: it is added on the first pass, before anything
	// is provisioned.
	DevEnvFinalizer = "ai.cubestack.io/dev-env-finalizer"
)

const (
	envRunID           = "DEVENV_E2E_RUN_ID"
	envNamespace       = "DEVENV_E2E_NAMESPACE"
	envPlatformNS      = "DEVENV_E2E_PLATFORM_NAMESPACE"
	envPullSecret      = "DEVENV_E2E_PULL_SECRET"
	envProxy           = "DEVENV_E2E_PROXY"
	envUpTimeout       = "DEVENV_E2E_UP_TIMEOUT"
	defaultPlatformNS  = "cubestack-system"
	defaultPullSecret  = "harbor-credentials"
	defaultUpTimeout   = 20 * time.Minute
	upPollInterval     = 10 * time.Second
	namespaceRunLabel  = "e2e.cubestack.io/run"
	namespaceRunLabelV = "devenv-conformance"
)

// UpTimeout is how long an environment gets to reach Running. It is generous
// because the vendor images are tens of gigabytes and `imagePullPolicy: Always`
// under a `:latest` tag means every run pulls them again.
func UpTimeout() time.Duration {
	if v := os.Getenv(envUpTimeout); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return defaultUpTimeout
}

// Suite is one run against one cluster: the client, the transport, and the
// namespace every environment in the run lives in.
type Suite struct {
	Client client.Client
	Dialer Dialer

	// Namespace is this run's own. One per run rather than one per environment,
	// because the L4 pool is cluster-wide and a namespace is what scopes the
	// cleanup when a run dies halfway.
	Namespace string
	// PlatformNamespace and PullSecret are where the pull credential lives. The
	// controller sets no imagePullSecrets on an environment's pod, so copying this
	// into the run's namespace and naming it on the default ServiceAccount is the
	// only way the kubelet gets it.
	PlatformNamespace string
	PullSecret        string

	// Cluster is what the preflight established about the cluster this run is
	// against: the Gateway, the L4 pool, the dataplane Service. Assigned by the
	// suite's setup, and only read by the cases that ask a question about the
	// cluster rather than about the environment.
	Cluster Cluster

	// digests is what each environment's image resolved to, appended as the
	// environments come up. Only ever read after the run, by the report.
	digests []ImageDigest
}

// ImageDigest is one environment's image as it was actually delivered.
//
// Key is the catalogue's, because that is what a case names and what a report
// has to group by; Repo is the reference that was asked for, so a reader can see
// which `:latest` is behind a digest.
type ImageDigest struct {
	Key    string
	Repo   string
	Digest string
}

// RecordImage notes what one environment's image resolved to.
func (s *Suite) RecordImage(key, repo, digest string) {
	s.digests = append(s.digests, ImageDigest{Key: key, Repo: repo, Digest: digest})
}

// ImageDigests is everything the run observed, sorted by key and then digest.
func (s *Suite) ImageDigests() []ImageDigest {
	out := slices.Clone(s.digests)
	slices.SortFunc(out, func(a, b ImageDigest) int {
		if c := strings.Compare(a.Key, b.Key); c != 0 {
			return c
		}
		return strings.Compare(a.Digest, b.Digest)
	})
	return out
}

// NewSuite builds a run from the ambient kubeconfig and environment.
func NewSuite() (*Suite, error) {
	c, err := NewClient()
	if err != nil {
		return nil, err
	}
	s := &Suite{
		Client:            c,
		Dialer:            Dialer{Proxy: os.Getenv(envProxy)},
		PlatformNamespace: envOr(envPlatformNS, defaultPlatformNS),
		PullSecret:        envOr(envPullSecret, defaultPullSecret),
	}
	s.Namespace = os.Getenv(envNamespace)
	if s.Namespace == "" {
		runID := os.Getenv(envRunID)
		if runID == "" {
			runID = time.Now().Format("0102-150405")
		}
		s.Namespace = "devenv-e2e-" + runID
	}
	return s, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// Setup creates the run's namespace and gives it the pull credential.
//
// Idempotent: the namespace is created if absent, and the credential is copied
// and referenced again whether or not it was there. A run that died and is being
// re-run against the same namespace should not need a manual cleanup first.
func (s *Suite) Setup(ctx context.Context) error {
	return s.PrepareNamespace(ctx, s.Namespace)
}

// PrepareNamespace creates a namespace and gives it the pull credential, which
// is everything an environment needs from its namespace.
//
// Separate from Setup because one case needs a namespace that is not the run's:
// the L4 pool is cluster-wide, so "two environments get distinct ports" can only
// be asked of two environments that are not in the same namespace. Nothing else
// about a run changes, and the case owns the cleanup.
func (s *Suite) PrepareNamespace(ctx context.Context, name string) error {
	ns := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name:   name,
			Labels: map[string]string{namespaceRunLabel: namespaceRunLabelV},
		},
	}
	if err := s.Client.Create(ctx, ns); err != nil && !apierrors.IsAlreadyExists(err) {
		return fmt.Errorf("creating namespace %s: %w", name, err)
	}
	return s.providePullCredential(ctx, name)
}

// RemoveNamespace deletes a namespace PrepareNamespace made.
//
// The counterpart of PrepareNamespace, and separate from TearDown for the same
// reason: only one case makes a namespace of its own, and that namespace is not
// the run's, so nothing else would remove it.
func (s *Suite) RemoveNamespace(ctx context.Context, name string) error {
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}}
	return client.IgnoreNotFound(s.Client.Delete(ctx, ns))
}

// providePullCredential copies the platform's pull credential into a namespace
// and names it on that namespace's default ServiceAccount.
//
// The ServiceAccount and not just the Secret, because the Secret alone does
// nothing: the controller sets no imagePullSecrets on an environment's pod, so
// the namespace default is the only path the credential has to the kubelet. A
// run that skips this fails as ImagePullBackOff, which reads as an image finding
// rather than a setup one.
func (s *Suite) providePullCredential(ctx context.Context, namespace string) error {
	var src corev1.Secret
	key := client.ObjectKey{Namespace: s.PlatformNamespace, Name: s.PullSecret}
	if err := s.Client.Get(ctx, key, &src); err != nil {
		return fmt.Errorf("reading the pull credential %s/%s: %w", s.PlatformNamespace, s.PullSecret, err)
	}

	dst := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: s.PullSecret, Namespace: namespace},
		Type:       src.Type,
		Data:       src.Data,
	}
	if err := s.Client.Create(ctx, dst); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return fmt.Errorf("copying the pull credential into %s: %w", namespace, err)
		}
		if err := s.Client.Update(ctx, dst); err != nil {
			return fmt.Errorf("refreshing the pull credential in %s: %w", namespace, err)
		}
	}

	var sa corev1.ServiceAccount
	saKey := client.ObjectKey{Namespace: namespace, Name: "default"}
	if err := s.Client.Get(ctx, saKey, &sa); err != nil {
		return fmt.Errorf("reading the default ServiceAccount in %s: %w", namespace, err)
	}
	for _, ref := range sa.ImagePullSecrets {
		if ref.Name == s.PullSecret {
			return nil
		}
	}
	sa.ImagePullSecrets = append(sa.ImagePullSecrets, corev1.LocalObjectReference{Name: s.PullSecret})
	if err := s.Client.Update(ctx, &sa); err != nil {
		return fmt.Errorf("naming the pull credential on %s/default: %w", namespace, err)
	}
	return nil
}

// TearDown removes what this run created.
//
// Environments first, and not just the namespace: deleting the namespace takes
// the DevEnvironment with it, so the controller's withdrawal path — the
// ListenerSet removal and the L4 port release — never runs. That path is what
// several cases assert on, so a run that stopped halfway should still exercise
// it.
func (s *Suite) TearDown(ctx context.Context) {
	var envs aiv1alpha1.DevEnvironmentList
	if err := s.Client.List(ctx, &envs, client.InNamespace(s.Namespace)); err == nil {
		for i := range envs.Items {
			_ = s.Client.Delete(ctx, &envs.Items[i])
		}
		// Give the controller a moment to see the deletions before the namespace
		// goes, so the withdrawal is observed rather than raced.
		if len(envs.Items) > 0 {
			time.Sleep(5 * time.Second)
		}
	}
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: s.Namespace}}
	_ = s.Client.Delete(ctx, ns)
}

// EnvName is the name of the environment one (image, identity) pair runs in.
//
// It names the image by its catalogue key rather than its repo, because the key
// is label-safe and the repo is not — a Kubernetes object name may not carry a
// slash, and the registry's naming is not this suite's to constrain.
//
// The dots go too. A DevEnvironment's name is a DNS-1123 subdomain, which allows
// them, but the controller names a Service after the environment and a Service
// name is DNS-1035, which does not — so an environment called after
// ssh-ubuntu22.04 fails every reconcile with "a DNS-1035 label must consist of
// lower case alphanumeric characters or '-'". Measured, not read: the jupyter
// case, whose key has no dot, came up first try.
func EnvName(img Image, id Identity) string {
	return fmt.Sprintf("e2e-%s-%s", strings.ReplaceAll(img.Key, ".", "-"), id)
}

// Environment is one DevEnvironment and the assertions' handle on it.
type Environment struct {
	Suite    *Suite
	Image    Image
	Identity Identity
	Name     string

	// Namespace is where the environment lives, and is the run's own unless a
	// case said otherwise. Only the case about the L4 pool being cluster-wide
	// says otherwise, because it is the one claim that cannot be made of two
	// environments sharing a namespace.
	//
	// Filled in by BringUp and Draft rather than left empty for the run's: a
	// case that has to name the namespace — the address an endpoint is
	// published under carries it — would otherwise read an empty string and
	// have to know the fallback rule this type exists to hold.
	Namespace string

	obj *aiv1alpha1.DevEnvironment
}

// ns is the environment's namespace, which is the run's unless a case said
// otherwise. Every read and write goes through it, so an environment placed
// elsewhere is not half in the run's namespace.
func (e *Environment) ns() string {
	if e.Namespace != "" {
		return e.Namespace
	}
	return e.Suite.Namespace
}

// BringUp creates the environment and waits for it to be running with its
// endpoints published.
//
// It returns the environment even on failure, because the failure is the
// interesting part: every case on it reports the same reason rather than
// inventing its own, and the dump is written once.
func (s *Suite) BringUp(ctx context.Context, img Image, id Identity) (*Environment, error) {
	e := &Environment{
		Suite: s, Image: img, Identity: id,
		Name: EnvName(img, id), Namespace: s.Namespace,
	}

	desired := e.manifest()
	if err := s.Client.Create(ctx, desired); err != nil && !apierrors.IsAlreadyExists(err) {
		return e, fmt.Errorf("creating %s: %w", e.Name, err)
	}

	deadline := time.Now().Add(UpTimeout())
	var last error
	for {
		last = e.Ready(ctx)
		if last == nil {
			return e, nil
		}
		if time.Now().After(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			return e, ctx.Err()
		case <-time.After(upPollInterval):
		}
	}
	return e, fmt.Errorf("not running after %s: %w", UpTimeout(), last)
}

// manifest is the DevEnvironment this (image, identity) pair asks for.
//
// Typed rather than a template, which is the point of the whole exercise: a
// renamed or removed spec field is a compile error here, not a manifest that
// silently asks for something else and a case that quietly asserts nothing.
func (e *Environment) manifest() *aiv1alpha1.DevEnvironment {
	img, id := e.Image, e.Identity

	env := &aiv1alpha1.DevEnvironment{
		ObjectMeta: metav1.ObjectMeta{Name: e.Name, Namespace: e.ns()},
		Spec: aiv1alpha1.DevEnvironmentSpec{
			Type:      img.Type,
			Image:     img.Ref(),
			Running:   true,
			Resources: aiv1alpha1.ResourcesSpec{},
			// An explicit retention and size: the case is about whether the
			// workspace mounts and where, so the claim is small, and `delete`
			// keeps a failed run from leaving one behind for someone to sweep.
			Storage: &aiv1alpha1.StorageSpec{Size: "1Gi", PVCRetention: aiv1alpha1.PVCRetentionDelete},
		},
	}

	// A "ssh" environment is exposed by its type alone; a jupyter one has to ask.
	// Stating it for the ssh type as well would be noise the controller ignores.
	if img.ServesJupyter() {
		env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
	}

	// The identity axis. A non-root environment states the account and lets the
	// platform derive the numbers; a root one states only runAsUser 0 and the
	// controller supplies the launcher's own account, uid and gid.
	switch id {
	case Root:
		env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{
			SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: id.RunAsUser()},
		}
	default:
		env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{User: img.Account}
		if img.GroupOnlyWorkaround {
			// The stock docker-stacks account is 1000:100 while the platform's
			// default group is 1000, so the group has to be stated or the process
			// cannot write its own home. Which images need it is the catalogue's
			// field, not a rule this function infers.
			gid := img.GID
			env.Spec.Runtime.SecurityContext = &aiv1alpha1.RuntimeSecurityContext{RunAsGroup: &gid}
		}
	}
	return env
}

// Draft is an Environment whose manifest a case shapes before it is created.
//
// The matrix's environments are the catalogue's: BringUp renders one from an
// (image, identity) and waits for it to run. A case about the Accepted condition
// wants the other direction — a spec the catalogue would never build, either
// because the controller refuses it or because part of it is applied as
// something else — so it needs the same manifest without the wait, and without
// the assumption that a running environment is what comes out.
//
// Only the mutation is the case's. Everything else is what the matrix would have
// asked for, which is what keeps a case about one field a case about one field.
func (s *Suite) Draft(name string, img Image, id Identity) *Environment {
	return s.DraftIn(s.Namespace, name, img, id)
}

// DraftIn is Draft in a namespace other than the run's own.
//
// The one thing that makes an environment not-the-run's is where it lives, and
// the only case that wants one is about the pool being cluster-wide — so the
// namespace is a parameter here and nothing else is.
//
// An empty namespace means the run's, and is filled in here rather than left for
// the first read to resolve: the cases that name the namespace — the path an
// exposure is published under, the owner of a ListenerSet — read the field
// itself, and a case that left it empty would build its expectation around an
// empty string instead of around the environment's address.
func (s *Suite) DraftIn(namespace, name string, img Image, id Identity) *Environment {
	if namespace == "" {
		namespace = s.Namespace
	}
	return &Environment{Suite: s, Image: img, Identity: id, Name: name, Namespace: namespace}
}

// Apply creates the environment from the catalogue's manifest for this (image,
// identity) with mutate applied to it, and reads the environment back once.
//
// It waits for nothing. What an environment is expected to become — running,
// refused, or stuck unschedulable — is the case's question, and the conditions
// it is answered from are the case's to wait for.
func (e *Environment) Apply(ctx context.Context, mutate func(*aiv1alpha1.DevEnvironment)) error {
	desired := e.manifest()
	// A nil mutate is the catalogue's own manifest, which is what a case that
	// takes an environment as the platform would build it asks for — and what a
	// case that recreates one after deleting it has to ask for, since the shape
	// it was created with is not kept anywhere it could be reapplied from.
	if mutate != nil {
		mutate(desired)
	}
	if err := e.Suite.Client.Create(ctx, desired); err != nil {
		return fmt.Errorf("creating %s: %w", e.Name, err)
	}
	// Read back straight away, before the controller has looked at it: an
	// environment whose very creation failed is worth distinguishing from one
	// that exists and is simply not reconciled yet, and only a read can tell.
	got := &aiv1alpha1.DevEnvironment{}
	key := client.ObjectKey{Namespace: e.ns(), Name: e.Name}
	if err := e.Suite.Client.Get(ctx, key, got); err != nil {
		return fmt.Errorf("reading %s back: %w", e.Name, err)
	}
	e.obj = got
	return nil
}

// Refresh re-reads the environment from the cluster.
func (e *Environment) Refresh(ctx context.Context) error {
	got := &aiv1alpha1.DevEnvironment{}
	key := client.ObjectKey{Namespace: e.ns(), Name: e.Name}
	if err := e.Suite.Client.Get(ctx, key, got); err != nil {
		return err
	}
	e.obj = got
	return nil
}

// Object is the last-read DevEnvironment. Nil before the first successful
// Refresh, which is what a dump has to tolerate.
func (e *Environment) Object() *aiv1alpha1.DevEnvironment { return e.obj }

// Condition is one of the environment's conditions as last read, and nil when
// the controller has not recorded it.
//
// Nil and False are deliberately different answers — "the controller has not
// said" and "the controller said no" are different findings, and a caller
// asking about a condition the platform never writes would otherwise read the
// first as the second.
func (e *Environment) Condition(t string) *metav1.Condition {
	if e.obj == nil {
		return nil
	}
	return meta.FindStatusCondition(e.obj.Status.Conditions, t)
}

// Annotate sets an annotation on the environment.
//
// An annotation is the one write that makes the controller look at an
// environment again without changing anything about it: the spec is untouched,
// so nothing is re-resolved and nothing rolls, which is what a case wants when
// it is asking what a reconcile does *not* do.
func (e *Environment) Annotate(ctx context.Context, key, value string) error {
	got := &aiv1alpha1.DevEnvironment{}
	objKey := client.ObjectKey{Namespace: e.ns(), Name: e.Name}
	if err := e.Suite.Client.Get(ctx, objKey, got); err != nil {
		return fmt.Errorf("reading %s: %w", e.Name, err)
	}
	patch := client.MergeFrom(got.DeepCopy())
	if got.Annotations == nil {
		got.Annotations = map[string]string{}
	}
	got.Annotations[key] = value
	if err := e.Suite.Client.Patch(ctx, got, patch); err != nil {
		return fmt.Errorf("annotating %s: %w", e.Name, err)
	}
	return nil
}

// SetRunning stops or starts the environment, which is the user-facing form of
// taking the workload away and giving it back.
func (e *Environment) SetRunning(ctx context.Context, running bool) error {
	return e.Patch(ctx, func(want *aiv1alpha1.DevEnvironment) { want.Spec.Running = running })
}

// Patch edits the environment's spec in place, which is what a user's edit is as
// far as the controller is concerned.
//
// Read-modify-write rather than a typed patch, because the mutation is a
// function over the whole object: a case that wants to change one field still
// has to start from the spec as it stands, or the fields it did not touch are
// the ones the last writer wrote.
func (e *Environment) Patch(ctx context.Context, mutate func(*aiv1alpha1.DevEnvironment)) error {
	got := &aiv1alpha1.DevEnvironment{}
	objKey := client.ObjectKey{Namespace: e.ns(), Name: e.Name}
	if err := e.Suite.Client.Get(ctx, objKey, got); err != nil {
		return fmt.Errorf("reading %s: %w", e.Name, err)
	}
	patch := client.MergeFrom(got.DeepCopy())
	mutate(got)
	if err := e.Suite.Client.Patch(ctx, got, patch); err != nil {
		return fmt.Errorf("editing %s: %w", e.Name, err)
	}
	return nil
}

// PodUID is the running pod's identity, which is how a case tells a replaced pod
// from the one it replaced.
//
// The name does not: a StatefulSet recreates the pod under the same name, so
// "the pod is back" is true throughout a restart and only the uid changes.
func (e *Environment) PodUID(ctx context.Context) (types.UID, error) {
	pod, err := e.Pod(ctx)
	if err != nil {
		return "", err
	}
	return pod.UID, nil
}

// PodUIDs are the identities of every pod the environment's label selects.
//
// The plural, where PodUID is the singular, because "the environment is on a
// different pod" is a statement about a set: a restart replaces a pod rather
// than emptying the namespace first, so a caller that asked only for the first
// pod it found would be reading whichever one the API server happened to list
// first during the handover.
func (e *Environment) PodUIDs(ctx context.Context) ([]types.UID, error) {
	pods, err := e.Pods(ctx)
	if err != nil {
		return nil, err
	}
	uids := make([]types.UID, 0, len(pods))
	for i := range pods {
		uids = append(uids, pods[i].UID)
	}
	return uids, nil
}

// RestartPod removes the environment's pod and lets the StatefulSet replace it.
//
// Zero grace, because the question is whether the workspace survived and not how
// long the container took to exit: a graceful stop would put the assertion
// behind whatever shutdown handling the image happens to have.
func (e *Environment) RestartPod(ctx context.Context) error {
	pod, err := e.Pod(ctx)
	if err != nil {
		return err
	}
	if err := e.Suite.Client.Delete(ctx, pod, client.GracePeriodSeconds(0)); err != nil {
		return fmt.Errorf("deleting pod %s: %w", pod.Name, err)
	}
	return nil
}

// requiredConditions are the four the controller sets on a DevEnvironment, each
// of which has to hold before a case can mean anything.
//
// Accepted is in the list because it is the condition that says the spec written
// here is the spec that took effect — the controller's whole job is to resolve
// what the user asked for, and Accepted=False is how it says it could not.
// RouteReady is in it because an environment with no published route reads
// healthy while nothing answers.
var requiredConditions = []string{
	aiv1alpha1.ConditionAccepted,
	aiv1alpha1.ConditionPodScheduled,
	aiv1alpha1.ConditionRouteReady,
	aiv1alpha1.ConditionReady,
}

// Ready reports nil once the environment is running with everything published,
// and otherwise what is standing in the way.
//
// It returns the obstacle rather than a bool so that it can be the predicate of
// a poll: the last error before the deadline is the failure message, and it says
// which condition is false and why rather than "timed out".
func (e *Environment) Ready(ctx context.Context) error {
	if err := e.Refresh(ctx); err != nil {
		return err
	}
	st := e.obj.Status
	if st.Phase == nil {
		return errors.New("no phase recorded yet")
	}
	if st.Phase.Name != aiv1alpha1.PhaseRunning {
		return fmt.Errorf("phase %s (%s)", st.Phase.Name, st.Phase.Reason)
	}
	for _, t := range requiredConditions {
		c := meta.FindStatusCondition(st.Conditions, t)
		if c == nil {
			return fmt.Errorf("%s not recorded", t)
		}
		if c.Status != metav1.ConditionTrue {
			return fmt.Errorf("%s=%s (%s: %s)", t, c.Status, c.Reason, c.Message)
		}
	}
	if len(st.Endpoints) == 0 {
		return errors.New("running with no endpoints published")
	}
	return nil
}

// Stopped reports nil once the platform has recorded the environment as stopped,
// which is the state a stop is a transition into and not a precondition of.
func (e *Environment) Stopped(ctx context.Context) error {
	if err := e.Refresh(ctx); err != nil {
		return err
	}
	st := e.obj.Status
	if st.Phase == nil {
		return errors.New("no phase recorded yet")
	}
	if st.Phase.Name != aiv1alpha1.PhaseStopped {
		return fmt.Errorf("phase %s (%s)", st.Phase.Name, st.Phase.Reason)
	}
	return nil
}

// Endpoint finds an entry of status.Endpoints by name.
//
// Every address a case dials comes from here and is never assembled. What is
// under test is precisely that what the platform tells a user to connect to is
// what answers, so a case that built the address itself would be asserting its
// own arithmetic.
func (e *Environment) Endpoint(name string) (aiv1alpha1.Endpoint, bool) {
	if e.obj == nil {
		return aiv1alpha1.Endpoint{}, false
	}
	for _, ep := range e.obj.Status.Endpoints {
		if ep.Name == name {
			return ep, true
		}
	}
	return aiv1alpha1.Endpoint{}, false
}

// EndpointNames lists the published endpoint names, sorted, for a failure
// message that says what was there instead.
func (e *Environment) EndpointNames() []string {
	if e.obj == nil {
		return nil
	}
	names := make([]string, 0, len(e.obj.Status.Endpoints))
	for _, ep := range e.obj.Status.Endpoints {
		names = append(names, ep.Name)
	}
	slices.Sort(names)
	return names
}

// WebEndpoint is the http endpoint, named by the environment's type.
func (e *Environment) WebEndpoint() (aiv1alpha1.Endpoint, bool) {
	return e.Endpoint(string(e.Image.Type))
}

// SSHEndpoint is the ssh endpoint.
func (e *Environment) SSHEndpoint() (aiv1alpha1.Endpoint, bool) {
	return e.Endpoint(sshEndpointName)
}

// secretData reads one entry of a Secret the environment's status names.
func (e *Environment) secretData(ctx context.Context, ref *corev1.SecretReference, key string) ([]byte, error) {
	if ref == nil {
		return nil, errors.New("status names no such Secret")
	}
	var s corev1.Secret
	if err := e.Suite.Client.Get(ctx, client.ObjectKey{Namespace: ref.Namespace, Name: ref.Name}, &s); err != nil {
		return nil, fmt.Errorf("reading secret %s/%s: %w", ref.Namespace, ref.Name, err)
	}
	data, ok := s.Data[key]
	if !ok {
		return nil, fmt.Errorf("secret %s/%s has no %q entry", ref.Namespace, ref.Name, key)
	}
	return data, nil
}

// JupyterToken is the token the platform minted for this environment's Jupyter
// server, read from the Secret status names rather than guessed at.
func (e *Environment) JupyterToken(ctx context.Context) (string, error) {
	if e.obj == nil || e.obj.Status.JupyterTokenSecret == nil {
		return "", errors.New("status names no Jupyter token Secret")
	}
	b, err := e.secretData(ctx, e.obj.Status.JupyterTokenSecret, jupyterTokenKey)
	if err != nil {
		return "", err
	}
	if len(b) == 0 {
		return "", fmt.Errorf("the Jupyter token Secret %s is empty", e.obj.Status.JupyterTokenSecret.Name)
	}
	return strings.TrimSpace(string(b)), nil
}

// EmptyJupyterToken deletes the token the platform minted, leaving the Secret in
// place.
//
// It is what losing the credential is, from the platform's side: the controller
// replaces a token that is gone rather than restoring the one it had, so a case
// that empties the entry is asking for a new one — which is the only path by
// which a user who never saved the token gets back in.
func (e *Environment) EmptyJupyterToken(ctx context.Context) error {
	if e.obj == nil || e.obj.Status.JupyterTokenSecret == nil {
		return errors.New("status names no Jupyter token Secret")
	}
	ref := e.obj.Status.JupyterTokenSecret
	var s corev1.Secret
	key := client.ObjectKey{Namespace: ref.Namespace, Name: ref.Name}
	if err := e.Suite.Client.Get(ctx, key, &s); err != nil {
		return fmt.Errorf("reading secret %s/%s: %w", key.Namespace, key.Name, err)
	}
	if _, ok := s.Data[jupyterTokenKey]; !ok {
		return fmt.Errorf("secret %s/%s has no %q entry to empty", key.Namespace, key.Name, jupyterTokenKey)
	}
	patch := client.MergeFrom(s.DeepCopy())
	delete(s.Data, jupyterTokenKey)
	if err := e.Suite.Client.Patch(ctx, &s, patch); err != nil {
		return fmt.Errorf("emptying %s/%s: %w", key.Namespace, key.Name, err)
	}
	return nil
}

// SSHClientKey is the private key the platform minted for logging in.
func (e *Environment) SSHClientKey(ctx context.Context) ([]byte, error) {
	if e.obj == nil || e.obj.Status.SSHClientKeySecret == nil {
		return nil, errors.New("status names no SSH client key Secret")
	}
	return e.secretData(ctx, e.obj.Status.SSHClientKeySecret, sshClientKeyKey)
}

// SSHHostKeySecretName is where the sshd's host key lives.
//
// A name this suite assembles rather than reads, because the controller does not
// publish it: only the client key and the Jupyter token are in status. The naming
// is <env>-ssh-host-key, and it is a test's guess about the controller's
// convention in exactly the way the rest of this file is not.
func (e *Environment) SSHHostKeySecretName() string {
	return e.Name + "-ssh-host-key"
}

// SSHClientKeySecretName is the name the platform gives the login key it mints.
//
// Assembled for the same reason as the host key's, with the difference that this
// one *is* in status when it exists — so the name is only needed by the cases
// asking whether the platform minted one it should not have, which is exactly
// when there is no status field to read it from.
func (e *Environment) SSHClientKeySecretName() string {
	return e.Name + "-ssh-client-key"
}

// SSHHostKey is the public half of the host key the platform minted for this
// environment.
//
// Pinning it is what makes an ssh case an assertion about the platform's
// endpoint rather than about whatever answered on the port: the key is minted per
// environment and published nowhere a client could have got it, so a session
// that verifies against it reached the server the platform described.
func (e *Environment) SSHHostKey(ctx context.Context) (ssh.PublicKey, error) {
	ref := &corev1.SecretReference{Namespace: e.ns(), Name: e.SSHHostKeySecretName()}
	b, err := e.secretData(ctx, ref, sshHostPubKeyKey)
	if err != nil {
		return nil, err
	}
	pub, _, _, _, err := ssh.ParseAuthorizedKey(b)
	if err != nil {
		return nil, fmt.Errorf("parsing the host key in %s: %w", ref.Name, err)
	}
	return pub, nil
}

// WorkspaceMountPath is where the platform mounted the workspace claim, read
// from the pod the platform actually created.
//
// Read from the pod and not re-derived from the spec: the platform decides where
// the claim goes, and the interesting assertion is that the session's HOME is
// that place. A case that computed the path itself would be comparing the
// controller to a second implementation of the controller.
func (e *Environment) WorkspaceMountPath(ctx context.Context) (string, error) {
	pod, err := e.Pod(ctx)
	if err != nil {
		return "", err
	}
	for _, c := range pod.Spec.Containers {
		for _, m := range c.VolumeMounts {
			if m.Name == workspaceVolumeName {
				return m.MountPath, nil
			}
		}
	}
	return "", fmt.Errorf("pod %s mounts no %q volume", pod.Name, workspaceVolumeName)
}

// WorkspaceClaim is the PersistentVolumeClaim the workspace mount comes from.
//
// The mount path alone does not say the workspace is durable: the same path
// backed by an emptyDir is writable and lost with the pod. What makes the
// workspace survive a restart is that the mount is a claim, so the assertion
// that it does survive is worth pairing with a reading that it is one.
func (e *Environment) WorkspaceClaim(ctx context.Context) (string, error) {
	pod, err := e.Pod(ctx)
	if err != nil {
		return "", err
	}
	for _, v := range pod.Spec.Volumes {
		if v.Name != workspaceVolumeName {
			continue
		}
		if v.PersistentVolumeClaim == nil {
			return "", fmt.Errorf("pod %s backs %q with %s rather than a claim",
				pod.Name, workspaceVolumeName, volumeSourceString(v))
		}
		return v.PersistentVolumeClaim.ClaimName, nil
	}
	return "", fmt.Errorf("pod %s has no %q volume", pod.Name, workspaceVolumeName)
}

// WorkspaceClaimObject is the claim itself, for the cases that ask the cluster
// rather than the pod: what size it was created at, whether anything provisioned
// it, and what access mode it carries.
func (e *Environment) WorkspaceClaimObject(ctx context.Context) (*corev1.PersistentVolumeClaim, error) {
	name, err := e.WorkspaceClaim(ctx)
	if err != nil {
		return nil, err
	}
	var pvc corev1.PersistentVolumeClaim
	key := client.ObjectKey{Namespace: e.ns(), Name: name}
	if err := e.Suite.Client.Get(ctx, key, &pvc); err != nil {
		return nil, fmt.Errorf("reading the workspace claim %s/%s: %w", key.Namespace, key.Name, err)
	}
	return &pvc, nil
}

func volumeSourceString(v corev1.Volume) string {
	// Only ever used in a failure message, so the names of the alternatives are
	// enough; which one it is is what the reader needs in order to look it up.
	switch {
	case v.EmptyDir != nil:
		return "an emptyDir"
	case v.HostPath != nil:
		return "a hostPath"
	case v.ConfigMap != nil:
		return "a configMap"
	case v.Secret != nil:
		return "a secret"
	}
	return "no source this suite knows"
}

// Delete removes the environment and returns without waiting.
//
// What the deletion does to everything around it is what the cases assert, and
// an environment that has been asked for and not yet gone is exactly the state
// they read, so waiting here would hide the subject.
func (e *Environment) Delete(ctx context.Context) error {
	obj := e.obj
	if obj == nil {
		obj = &aiv1alpha1.DevEnvironment{
			ObjectMeta: metav1.ObjectMeta{Name: e.Name, Namespace: e.ns()},
		}
	}
	return client.IgnoreNotFound(e.Suite.Client.Delete(ctx, obj))
}

// Gone reports nil once the environment is no longer in the cluster.
func (e *Environment) Gone(ctx context.Context) error {
	var got aiv1alpha1.DevEnvironment
	err := e.Suite.Client.Get(ctx, client.ObjectKey{Namespace: e.ns(), Name: e.Name}, &got)
	switch {
	case apierrors.IsNotFound(err):
		return nil
	case err != nil:
		return err
	}
	return fmt.Errorf("%s is still there", e.Name)
}

// ClaimExists reports whether a workspace claim is in the namespace, by name.
//
// By name and not through WorkspaceClaim, which reads the mount off the pod: the
// cases that ask this do so after the environment — and so the pod — is gone,
// and the claim is the thing that outlives it.
func (e *Environment) ClaimExists(ctx context.Context, name string) (bool, error) {
	var pvc corev1.PersistentVolumeClaim
	err := e.Suite.Client.Get(ctx, client.ObjectKey{Namespace: e.ns(), Name: name}, &pvc)
	switch {
	case apierrors.IsNotFound(err):
		return false, nil
	case err != nil:
		return false, err
	}
	return true, nil
}

// ClaimObject is one workspace claim by name, for the cases that compare a
// retained claim against the one a recreated environment is using.
func (e *Environment) ClaimObject(ctx context.Context, name string) (*corev1.PersistentVolumeClaim, error) {
	var pvc corev1.PersistentVolumeClaim
	key := client.ObjectKey{Namespace: e.ns(), Name: name}
	if err := e.Suite.Client.Get(ctx, key, &pvc); err != nil {
		return nil, fmt.Errorf("reading %s/%s: %w", key.Namespace, key.Name, err)
	}
	return &pvc, nil
}

// Service is the environment's own Service, which is what the Gateway's routes
// name as their backend.
//
// One Service per environment, named after it, with one entry per published
// port. A route that names it and forwards to a port it does not carry is
// accepted and answers nothing, so the two are checked together.
func (e *Environment) Service(ctx context.Context) (*corev1.Service, error) {
	var svc corev1.Service
	key := client.ObjectKey{Namespace: e.ns(), Name: e.Name}
	if err := e.Suite.Client.Get(ctx, key, &svc); err != nil {
		return nil, fmt.Errorf("reading %s/%s: %w", key.Namespace, key.Name, err)
	}
	return &svc, nil
}

// TearDown deletes the environment.
//
// A plain delete and not a cascade with the namespace: the withdrawal the
// controller performs on a deleted environment — removing its ListenerSet and
// releasing its L4 port — is what several cases assert on, so it has to be
// allowed to run.
func (e *Environment) TearDown(ctx context.Context) error {
	if e.obj == nil {
		// Nothing was read back, so this is an environment whose creation is the
		// thing that failed — and a create that failed at the API server may still
		// have made the object. Deleting by name covers it either way, which
		// matters most for a draft, whose object the case never saw.
		stub := &aiv1alpha1.DevEnvironment{
			ObjectMeta: metav1.ObjectMeta{Name: e.Name, Namespace: e.ns()},
		}
		return client.IgnoreNotFound(e.Suite.Client.Delete(ctx, stub))
	}
	return client.IgnoreNotFound(e.Suite.Client.Delete(ctx, e.obj))
}

// PodRunning reports nil once the environment's pod is Running with every
// container ready.
//
// Separate from Ready, which reads the environment's conditions: a condition is
// only as true as the process behind it, and a pod that has just gone away is
// still described by conditions written before it did.
func (e *Environment) PodRunning(ctx context.Context) error {
	pod, err := e.Pod(ctx)
	if err != nil {
		return err
	}
	if pod.Status.Phase != corev1.PodRunning {
		return fmt.Errorf("pod %s is %s", pod.Name, pod.Status.Phase)
	}
	for _, cs := range pod.Status.ContainerStatuses {
		if !cs.Ready {
			return fmt.Errorf("container %s is not ready (%s)", cs.Name, containerStateString(cs.State))
		}
	}
	return nil
}

// PulledImageID is the digest of the image the kubelet actually ran.
//
// The manifest says what was asked for; this is what was delivered, and under
// `imagePullPolicy: Always` with a `:latest` tag the two can differ from one
// pull to the next. The container is found by name because the controller names
// it for the spec type, which is also the catalogue's type.
func (e *Environment) PulledImageID(ctx context.Context) (string, error) {
	pod, err := e.Pod(ctx)
	if err != nil {
		return "", err
	}
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.Name != string(e.Image.Type) {
			continue
		}
		if cs.ImageID == "" {
			return "", fmt.Errorf("container %s records no image id", cs.Name)
		}
		return cs.ImageID, nil
	}
	return "", fmt.Errorf("pod %s has no %s container", pod.Name, e.Image.Type)
}

// Pod is the running pod the controller made for this environment.
func (e *Environment) Pod(ctx context.Context) (*corev1.Pod, error) {
	pods, err := e.Pods(ctx)
	if err != nil {
		return nil, err
	}
	if len(pods) == 0 {
		return nil, fmt.Errorf("no pod carries %s=%s", devEnvironmentLabelKey, e.Name)
	}
	return &pods[0], nil
}

// Pods are the pods the environment's label selects.
//
// Separate from Pod because "none" and "one this suite cannot use" are different
// findings and only a caller knows which it is looking at: a refused
// environment has no pod at all, which is an assertion, while a running one that
// has lost its pod is a failure.
func (e *Environment) Pods(ctx context.Context) ([]corev1.Pod, error) {
	var pods corev1.PodList
	err := e.Suite.Client.List(ctx, &pods,
		client.InNamespace(e.ns()),
		client.MatchingLabels{devEnvironmentLabelKey: e.Name},
	)
	if err != nil {
		return nil, fmt.Errorf("listing pods for %s: %w", e.Name, err)
	}
	return pods.Items, nil
}

// Events returns the namespace events about this environment, oldest first.
func (e *Environment) Events(ctx context.Context) []corev1.Event {
	var events corev1.EventList
	if err := e.Suite.Client.List(ctx, &events, client.InNamespace(e.ns())); err != nil {
		return nil
	}
	var mine []corev1.Event
	for _, ev := range events.Items {
		if ev.InvolvedObject.Name == e.Name {
			mine = append(mine, ev)
		}
	}
	slices.SortFunc(mine, func(a, b corev1.Event) int {
		return a.LastTimestamp.Compare(b.LastTimestamp.Time)
	})
	return mine
}

// Dump writes what a failure needs to be readable, and returns the path.
//
// It is a string rather than a file so the spec can attach it to the failure
// message: a dump nobody looks at is the same as no dump.
func (e *Environment) Dump(ctx context.Context) string {
	var b strings.Builder
	fmt.Fprintf(&b, "environment %s/%s\n  image:    %s\n  identity: %s\n",
		e.ns(), e.Name, e.Image.Ref(), e.Identity)

	if e.obj == nil {
		b.WriteString("\n(never read back from the cluster)\n")
		return b.String()
	}

	fmt.Fprintf(&b, "\nphase: %s\n", phaseString(e.obj.Status.Phase))
	b.WriteString("conditions:\n")
	for _, c := range e.obj.Status.Conditions {
		fmt.Fprintf(&b, "  %-14s %-5s %-24s %s\n", c.Type, c.Status, c.Reason, c.Message)
	}
	b.WriteString("endpoints:\n")
	if len(e.obj.Status.Endpoints) == 0 {
		b.WriteString("  (none)\n")
	}
	for _, ep := range e.obj.Status.Endpoints {
		fmt.Fprintf(&b, "  %-14s %s (listener %d)\n", ep.Name, ep.Address, ep.ListenerPort)
	}

	if pod, err := e.Pod(ctx); err == nil {
		fmt.Fprintf(&b, "\npod %s: phase=%s node=%s\n", pod.Name, pod.Status.Phase, pod.Spec.NodeName)
		for _, cs := range pod.Status.ContainerStatuses {
			fmt.Fprintf(&b, "  container %s: ready=%v restarts=%d state=%s\n",
				cs.Name, cs.Ready, cs.RestartCount, containerStateString(cs.State))
		}
		for _, cond := range pod.Status.Conditions {
			if cond.Status != corev1.ConditionTrue {
				fmt.Fprintf(&b, "  %s=%s (%s: %s)\n", cond.Type, cond.Status, cond.Reason, cond.Message)
			}
		}
	} else {
		fmt.Fprintf(&b, "\nno pod: %v\n", err)
	}

	if events := e.Events(ctx); len(events) > 0 {
		b.WriteString("\nevents:\n")
		for _, ev := range events {
			fmt.Fprintf(&b, "  %-8s %-24s %s\n", ev.Type, ev.Reason, ev.Message)
		}
	}
	return b.String()
}

func phaseString(p *aiv1alpha1.Phase) string {
	if p == nil {
		return "(none)"
	}
	return fmt.Sprintf("%s (%s)", p.Name, p.Reason)
}

func containerStateString(s corev1.ContainerState) string {
	switch {
	case s.Running != nil:
		return "running"
	case s.Waiting != nil:
		return fmt.Sprintf("waiting: %s: %s", s.Waiting.Reason, s.Waiting.Message)
	case s.Terminated != nil:
		return fmt.Sprintf("terminated: %s (%d)", s.Terminated.Reason, s.Terminated.ExitCode)
	}
	return "unknown"
}
