/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// +kubebuilder:rbac:groups=ai.cubestack.io,resources=devenvironments,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=ai.cubestack.io,resources=devenvironments/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=ai.cubestack.io,resources=devenvironments/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=statefulsets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=events.k8s.io,resources=events,verbs=create;patch
// patch is here for the grant, not for the controller: an idle-enabled
// environment's activity agent is given get+patch on its own pod
// (::desiredActivityAgentRBAC), and RBAC privilege-escalation prevention
// refuses a Role whose rules the creator does not itself hold. The manager
// never patches a pod — the Role it renders is the narrow one, scoped by
// resourceNames to a single pod.
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch;patch
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=list;patch
// +kubebuilder:rbac:groups=networking.k8s.io,resources=networkpolicies,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=httproutes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=tcproutes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=udproutes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gateways,verbs=get;list;watch
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=listenersets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=roles,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=rolebindings,verbs=get;list;watch;create;update;patch;delete

package controller

import (
	"cmp"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"maps"
	"net"
	"net/netip"
	"slices"
	"strconv"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/tools/events"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlc "sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// DevEnvironmentControllerConfig configures the DevEnvironment controller's
// gateway integration. Zero values fall back to the defaults in
// defaultedConfig.
type DevEnvironmentControllerConfig struct {
	// GatewayName is the name of the shared Envoy Gateway the routes attach to.
	GatewayName string
	// GatewayNamespace is the namespace of the shared Gateway.
	GatewayNamespace string
	// GatewayDataplaneNamespace is the namespace the shared Gateway's dataplane
	// Service and pods run in, which is where its traffic to an environment
	// originates. It is not GatewayNamespace: the Gateway object and its Envoy
	// dataplane are separate deployments and Envoy Gateway places the latter in
	// its own namespace. Empty disables the ingress allowance in
	// desiredNetworkPolicy, leaving environments at the default-deny floor, and
	// stops externalPorts reading the dataplane Service: published addresses then
	// assume the listener port is the reachable one.
	GatewayDataplaneNamespace string
	// GatewayIP is a static fallback address used when the Gateway has no
	// status address yet.
	GatewayIP string
	// HTTPPort is the Gateway's HTTP listener port used in published URLs.
	HTTPPort int32
	// L4PortRangeStart is the first port of the external L4 port pool allocated
	// per environment (design §6.2). The pool serves ssh and every
	// spec.ports[].type: tcp or udp exposure, the two sharing its numbering
	// (design §8.3).
	L4PortRangeStart int32
	// L4PortRangeEnd is the last port of the external L4 port pool. An allocated
	// port becomes a listener the environment's own ListenerSet declares on the
	// shared Gateway, so nothing has to pre-create listeners in this range.
	L4PortRangeEnd int32
	// RDMAIBResource is the extended resource an InfiniBand environment requests
	// from the cluster's shared device plugin. It is a cluster property, not a
	// platform one: the device plugin declares the name in its own
	// configuration, so a deployment whose plugin uses another name sets this
	// rather than waiting for a platform release. Empty falls back to
	// defaultRDMAIBResource.
	RDMAIBResource string
	// RDMARoCEResource is the equivalent for a RoCE environment. The two are
	// separate flags because the conventional device-plugin configuration
	// publishes the two fabrics as distinct resources, selected by interface
	// name; a cluster that advertises a single combined resource points both
	// flags at it. Empty falls back to defaultRDMARoCEResource.
	RDMARoCEResource string
}

// Reason constants for DevEnvironment conditions and status.phase. Several
// values double as both a phase name and a condition reason. A phase reason is
// not only a failure reason: it is also what tells two ways of reaching the same
// phase apart — reasonStopped from a user's stop, reasonIdleTimeout from the
// idle timeout stopping the environment on its own — and the lifecycle Event for
// a transition is recorded under it (::emitLifecycleTransition).
const (
	reasonPending                = "Pending"
	reasonRunning                = "Running"
	reasonStopped                = "Stopped"
	reasonFailed                 = "Failed"
	reasonDeleting               = "Deleting"
	reasonIdleTimeout            = "IdleTimeout"
	reasonScheduled              = "Scheduled"
	reasonNotScheduled           = "NotScheduled"
	reasonNotCreated             = "PodNotCreated"
	reasonAccepted               = "Accepted"
	reasonOverridden             = "Overridden"
	reasonBrandMismatch          = "BrandMismatch"
	reasonNotebookArgsUnusable   = "NotebookArgsUnusable"
	reasonPortCollision          = "PortCollision"
	reasonPublished              = "Published"
	reasonGatewayNotFound        = "GatewayNotFound"
	reasonGatewayNotReady        = "GatewayNotReady"
	reasonGatewayAPINotInstalled = "GatewayAPINotInstalled"
	reasonGatewayNotAccepted     = "GatewayNotAccepted"
	reasonListenerNotAccepted    = "ListenerNotAccepted"
	reasonRouteCreateFailed      = "RouteCreateFailed"

	// Pod waiting reasons that fail the environment (design §4.2: image and
	// crash failures surface as Failed rather than Pending).
	imagePullBackOff = "ImagePullBackOff"
	errImagePull     = "ErrImagePull"
	crashLoopBackOff = "CrashLoopBackOff"

	// Defaults for the shared Envoy Gateway the routes attach to when neither
	// flag is configured. The namespace is the platform convention — where Envoy
	// Gateway and its `eg` class are installed, which is where the platform
	// creates the Gateway for an install that is not told otherwise — rather
	// than this manager's release namespace, which is where the chart used to
	// create it and no longer does.
	defaultGatewayName      = "cubestack-gateway"
	defaultGatewayNamespace = "envoy-gateway-system"

	// Default RDMA extended resource names. These are the defaults for the
	// operator's flags, not constants of the platform: the names are declared by
	// the cluster's own device-plugin configuration, which the platform does not
	// own, so a cluster that names them differently points the flags at its own.
	//
	// Two choices here are deliberate and easy to mistake for accidents.
	//
	// The rdma/ prefix is the device plugin's own default (resourcePrefix, whose
	// default is literally "rdma"), so leaving it alone means the plugin's
	// ConfigMap needs no resourcePrefix key to advertise these names.
	//
	// The rest of the name is this platform's, because nothing upstream names an
	// RDMA resource after its fabric. The plugin's own several-pools example
	// distinguishes them by instance instead ("hca_shared_devices_a" and "_b"),
	// and neither NVIDIA's network operator ("rdma_shared_device_a") nor
	// Spiderpool ("hca_shared_devices") encodes a fabric either; no "roce"
	// resource name ships anywhere. This platform does encode it, because the
	// fabric — not the pool — is what the user selects, and what decides whether
	// the environment runs on the host network (::rdmaResource). The pair is
	// symmetric for the same reason: the two names are read side by side.
	defaultRDMAIBResource   = "rdma/ib_shared_devices"
	defaultRDMARoCEResource = "rdma/roce_shared_devices"

	// stsSpecHashAnnotationKey tracks the desired pod template so the
	// StatefulSet is updated only when the template or replicas change.
	stsSpecHashAnnotationKey = "ai.cubestack.io/sts-spec-hash"

	// Gateway API well-known names used in route specs. listenerSetKind is the
	// parent an L4 route attaches to: the environment contributes its own L4
	// listeners through a ListenerSet rather than a Gateway listener someone
	// pre-created, which is what lets the controller allocate a port end to end
	// without write access to the shared Gateway (design §5).
	gatewayAPIGroup = "gateway.networking.k8s.io"
	gatewayKind     = "Gateway"
	httpRouteKind   = "HTTPRoute"
	listenerSetKind = "ListenerSet"
	tcpRouteKind    = "TCPRoute"
	udpRouteKind    = "UDPRoute"
	serviceKind     = "Service"

	// Labels Envoy Gateway puts on the dataplane pods it creates for a Gateway.
	// They identify which Gateway a proxy pod belongs to, which is what lets a
	// NetworkPolicy admit that dataplane specifically rather than every pod that
	// happens to share its namespace.
	gatewayDataplaneNameLabel      = "gateway.envoyproxy.io/owning-gateway-name"
	gatewayDataplaneNamespaceLabel = "gateway.envoyproxy.io/owning-gateway-namespace"

	// namespaceNameLabel carries a Namespace's own name; it is what a
	// NetworkPolicy peer uses to select a namespace by name.
	namespaceNameLabel = "kubernetes.io/metadata.name"

	// sshPortName names the SSH Service port and the "ssh" endpoint; the ssh
	// endpoint address carries the environment's login account, which is
	// spec.runtime.user or defaultRuntimeUser when the spec names none, and root
	// when the environment runs as root (see runtimeUser).
	sshPortName  = "ssh"
	mainPortName = "main"
	// The ssh material arrives as two Secrets — the host identity and the
	// authorized keys — so it is two volumes and one mount each.
	sshHostKeyVolumeName        = "ssh-host-key"
	sshAuthorizedKeysVolumeName = "ssh-authorized-keys"

	// l4ListenerSetSuffix makes the per-environment ListenerSet's name; the
	// environment's L4 listeners all live in that one object.
	l4ListenerSetSuffix = "-l4"

	// sshServicePort is the port the platform publishes ssh on — the Service
	// port, the TCPRoute backendRef and the endpoint address — while
	// sshContainerPort is where the base images' sshd actually listens. sshd
	// runs as the container account and cannot bind a privileged port, so it
	// chooses the unprivileged one and the Service maps the two (design Gap B).
	sshServicePort   = 22
	sshContainerPort = 2222

	// Where the images read the mounted ssh material: sshd's host identity (its
	// presence gates ssh) and the platform keys. Both are absolute paths outside
	// any home. The platform keys cannot live in $HOME: the workspace claim is
	// mounted there, its root is not writable by the account, and the mount target
	// for a file beneath it is created root-owned by the runtime — which would both
	// hide and break the ~/.ssh the images bake. Under /run the platform keys stay
	// out of the user's way and the account keeps ~/.ssh for its own files
	// (images/README.md).
	sshHostKeyPath = "/etc/ssh/ssh_host_ed25519_key"
	// The authorized keys are mounted as a whole Secret at this directory, with
	// the selected data key renamed to sshAuthorizedKeysFile by the volume's
	// items. The images read the same absolute path either way, but a directory
	// mount is an ordinary Secret volume — kubelet keeps it in sync — where a
	// subPath file is frozen at container start.
	sshAuthorizedKeysDir  = "/run/ssh"
	sshAuthorizedKeysFile = "authorized_keys"

	// sshMountContractVersion names the shape of that mount (see desiredPodSpec).
	// stsSpecHash is assembled by hand and does not see the ssh volumes, so
	// changing the shape has to carry a version the hash can see — otherwise
	// applyStatefulSet matches the old hash and every existing environment keeps
	// the template it was rolled onto.
	sshMountContractVersion = "dir-items-1"

	// podSecurityContextVersion names the shape of the pod-level security context
	// (see desiredPodSpec) for the same reason: the seccomp profile is a constant
	// that stsSpecHash's hand-assembled input cannot see, and a pod only acquires
	// it at creation. Without a version the hash can see, adding the profile
	// leaves every environment created before it running unprofiled, and nothing
	// else in the template changes, so no later reconcile would roll them.
	podSecurityContextVersion = "seccomp-runtime-default-1"

	// rootLauncherEnvVersion names the shape of the launcher environment the
	// controller injects into a root Jupyter environment (see withRootLauncherEnv),
	// for the same reason again: what it injects is a constant, so nothing else in
	// the hash input moves when the injection is added and an environment created
	// before it would keep a template whose launcher never starts. An environment
	// that cannot receive the injection contributes nothing (::stsSpecHash), so only
	// the ones that can are rolled.
	rootLauncherEnvVersion = "root-launcher-env-1"

	// workspaceHomeVersion names the shape of the home the controller states on a
	// container that has a workspace claim (see withWorkspaceHome), for the same
	// reason once more: the value is the mount path, which the hash input already
	// carries through Storage and Runtime, so an environment whose spec has not
	// changed would digest exactly as it did before the injection and keep the
	// template it was rolled onto. An environment with no claim states no home
	// and contributes nothing (::stsSpecHash), so only the others are rolled.
	workspaceHomeVersion = "workspace-home-1"

	// defaultRuntimeUser is the account an environment logs in as when
	// spec.runtime.user names none; it is also the account the platform's base
	// images conventionally use.
	defaultRuntimeUser = "user"

	// rootRuntimeUser is the account a root environment logs in as, and what its
	// endpoint advertises whatever the spec names (see runtimeUser).
	rootRuntimeUser = "root"

	// defaultWorkspacePath is where the workspace PVC mounts when neither
	// spec.storage.mountPath nor a declared HOME nor the runtime identity implies
	// another home.
	defaultWorkspacePath = "/workspace"

	// homeEnv is the variable spec.runtime.env declares the account's home
	// through. It is the second input to the workspace mount path
	// (::resolveMountPath) and the name the controller states that path under
	// (::withWorkspaceHome).
	homeEnv = "HOME"

	// Jupyter token: the managed Secret <env>-jupyter-token holds the random token under
	// the data key jupyterTokenKey, and the workload reads it through the
	// JUPYTER_TOKEN env var (design §6.3). The token guards the web path; only
	// the owner (via the Secret) and the pod know it.
	jupyterTokenKey = "token"
	jupyterTokenEnv = "JUPYTER_TOKEN"

	// notebookArgsEnv is the variable the stock Jupyter launcher appends to the
	// notebook command line, and notebookBaseURLFlag the launcher flag that makes
	// Jupyter serve under a URL prefix. The web route forwards its path prefix
	// unchanged — there is no URLRewrite filter — so Jupyter has to serve under
	// webPath, and the controller hands it the prefix rather than having the
	// gateway strip it (::withNotebookBaseURL).
	notebookArgsEnv     = "NOTEBOOK_ARGS"
	notebookBaseURLFlag = "--ServerApp.base_url="

	// The launcher settings a Jupyter environment running as root needs, which
	// the controller supplies rather than the spec (::withRootLauncherEnv):
	// docker-stacks' start.sh reads the account it should serve from NB_USER and
	// the uid/gid to serve it as from NB_UID/NB_GID, and Jupyter Server refuses
	// to start as root without --allow-root.
	nbUserEnv = "NB_USER"
	nbUIDEnv  = "NB_UID"
	nbGIDEnv  = "NB_GID"

	// rootAccountUID and rootAccountGID are root's identity in the image's own
	// passwd database, and are what NB_UID and NB_GID name. They are deliberately
	// not the identity the pod runs as, which spec.runtime.securityContext decides
	// (::withRootLauncherEnv).
	rootAccountUID = "0"
	rootAccountGID = "0"

	notebookAllowRootFlag = "--allow-root"

	// jupyterTokenRevisionAnnotationKey records a non-sensitive sha256 digest of
	// the managed Jupyter token on the StatefulSet pod template. JUPYTER_TOKEN
	// is read from the Secret at container start, so a refilled token must roll
	// the pod; the digest makes the template (and stsSpecHash) change when the
	// token is created or refilled without ever putting the plaintext on the pod.
	jupyterTokenRevisionAnnotationKey = "ai.cubestack.io/jupyter-token-revision"

	// sshKeysRevisionAnnotationKey records a non-sensitive digest of the
	// environment's host identity on the StatefulSet pod template. Unlike the
	// authorized keys, which are a directory mount kubelet keeps in sync, the host
	// key is a subPath file Kubernetes never updates in place, so a repaired key
	// only reaches the pod through a roll; the digest makes the template (and
	// stsSpecHash) change when it does.
	sshKeysRevisionAnnotationKey = "ai.cubestack.io/ssh-keys-revision"

	sshEd25519Algorithm = "ssh-ed25519"
	sshHostKeyPEMType   = "OPENSSH PRIVATE KEY"

	// Kubernetes Event reasons emitted on lifecycle transitions (design §11.2):
	// Created on adoption, Started/Stopped on phase transitions into
	// Running/Stopped, and Failed (Warning) on transitions into Failed. A
	// transition into Stopped is recorded under the phase's own reason, so an
	// idle auto-stop is eventReasonIdleTimeout rather than eventReasonStopped;
	// the other transitions have one reason each.
	eventReasonCreated     = "Created"
	eventReasonStarted     = "Started"
	eventReasonStopped     = "Stopped"
	eventReasonFailed      = "Failed"
	eventReasonIdleTimeout = "IdleTimeout"

	// legacyStorageReadyCondition is the workspace condition the pre-delegation
	// controller reported while it managed the claim itself. The claim's
	// lifecycle belongs to the StatefulSet now, so nothing can set or clear it
	// any more; an environment created by that manager still carries it, and it
	// is dropped during reconcile rather than left on status forever.
	legacyStorageReadyCondition = "StorageReady"

	// legacyBrandMatchValidCondition is the brand gate's own condition before it
	// was folded into Accepted (::specFindings). It covers one of the findings
	// Accepted now reports, so it can no longer be set or cleared; an environment
	// reconciled before the fold still carries it, and it is dropped the same way.
	legacyBrandMatchValidCondition = "BrandMatchValid"
)

// DevEnvironmentReconciler provisions the managed StatefulSet (scale 0/1),
// Service, NetworkPolicy, SSH Secret and Gateway routes for a DevEnvironment,
// and aggregates phase, conditions and access endpoints in status. Startup
// and stop map to StatefulSet replicas 1/0 while the workspace PVC survives
// (design §4).
type DevEnvironmentReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	Config DevEnvironmentControllerConfig
	// Recorder emits lifecycle Events (Created/Started/Stopped/Failed, design
	// §11.2). When nil it is wired from the manager in SetupWithManager; the
	// guard keeps helper-only constructions safe.
	Recorder events.EventRecorder
	// APIReader reads straight from the API server instead of the manager's
	// cache. Port allocation depends on it: usedPorts has to observe a port
	// another reconcile just reserved, and a cached List serves whatever the
	// informer last saw (see usedPorts). When nil it is wired from the manager in
	// SetupWithManager, like Recorder.
	APIReader client.Reader
}

// Reconcile runs the DevEnvironment pipeline: spec gate, SSH secret, core
// resources, gateway routes (best-effort), then pod/PVC observation and
// status aggregation.
func (r *DevEnvironmentReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var env aiv1alpha1.DevEnvironment
	if err := r.Get(ctx, req.NamespacedName, &env); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	if env.DeletionTimestamp != nil {
		return ctrl.Result{}, r.cleanup(ctx, &env)
	}

	if !slices.Contains(env.Finalizers, devEnvFinalizer) {
		// Patch, not Update: Update sends the whole object and carries the
		// resourceVersion we read, so any write landing in between 409-conflicts
		// and forces a retry reconcile. A merge patch has no such precondition,
		// and the finalizer is the only field this call means to change.
		patch := client.MergeFrom(env.DeepCopy())
		env.Finalizers = append(env.Finalizers, devEnvFinalizer)
		if err := r.Patch(ctx, &env, patch); err != nil {
			return ctrl.Result{}, err
		}
		if r.Recorder != nil {
			r.Recorder.Eventf(&env, nil, corev1.EventTypeNormal, eventReasonCreated, eventReasonCreated,
				"DevEnvironment %s/%s created", env.Namespace, env.Name)
		}
		return ctrl.Result{Requeue: true}, nil
	}

	desired := env.DeepCopy()
	desired.Status.ObservedGeneration = env.Generation
	// StorageReady is no longer part of the API (the workspace claim's lifecycle
	// moved to the StatefulSet), so a condition left on status by the manager
	// that still reported it would never be updated again. Drop it here, before
	// any path below writes status. BrandMatchValid is retired the same way: the
	// gate it reported is one of the findings Accepted now carries
	// (::specFindings), and nothing can set or clear it any more either.
	meta.RemoveStatusCondition(&desired.Status.Conditions, legacyStorageReadyCondition)
	meta.RemoveStatusCondition(&desired.Status.Conditions, legacyBrandMatchValidCondition)

	// An auto-stop mark the user has superseded is dropped before the
	// StatefulSet and the phase below are derived from it, so one pass sees one
	// state (::clearSupersededAutoStop).
	if err := r.clearSupersededAutoStop(ctx, &env); err != nil {
		return ctrl.Result{}, err
	}

	// 1. Spec gate: every place the controller resolves a field itself rather
	// than applying the spec as written (::specFindings). A finding only the user
	// can clear is a hard failure — nothing is provisioned (design §4.2), and an
	// environment that was running before its spec changed is withdrawn so the
	// Failed phase reflects reality: the workload is stopped and the routes
	// removed. A finding the controller resolved is reported on the same condition
	// without blocking, because the environment runs with the controller's value.
	findings := specFindings(&env)
	if blocking := mustUpdateFindings(findings); len(blocking) > 0 {
		if err := r.stopCompute(ctx, &env); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.deleteRoutes(ctx, &env); err != nil {
			return ctrl.Result{}, err
		}
		// The phase and Ready name the first finding, as each gate did on its own
		// before they were folded together; Accepted carries every one of them.
		setAcceptedCondition(&desired.Status.Conditions, metav1.ConditionFalse, blocking[0].reason, findingsMessage(blocking))
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionPodScheduled)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionRouteReady)
		desired.Status.Endpoints = nil
		setPhase(&desired.Status, aiv1alpha1.PhaseFailed, blocking[0].reason)
		setDevEnvironmentReadyCondition(&desired.Status.Conditions, metav1.ConditionFalse, blocking[0].reason, blocking[0].detail)
		if err := r.updateStatusIfChanged(ctx, &env, desired); err != nil {
			return ctrl.Result{}, err
		}
		r.emitLifecycleTransition(&env, desired)
		return ctrl.Result{}, nil
	}
	if len(findings) == 0 {
		setAcceptedCondition(&desired.Status.Conditions, metav1.ConditionTrue, reasonAccepted, "every spec field is applied as written")
	} else {
		setAcceptedCondition(&desired.Status.Conditions, metav1.ConditionTrue, reasonOverridden, findingsMessage(findings))
	}

	// 2. SSH secrets: a managed host keypair and the authorized_keys source when
	// SSH is exposed (design §6.3).
	if sshExposed(&env) {
		keysSecret, digest, err := r.reconcileSSHSecrets(ctx, &env)
		if err != nil {
			return ctrl.Result{}, err
		}
		desired.Status.SSHClientKeySecret = keysSecret
		// Carry the key revision to applyStatefulSet below, like the jupyter
		// token: the host key is a subPath mount, so only a roll picks up changed
		// Secret bytes. env is re-fetched every reconcile and only its status is
		// persisted, so this in-memory annotation never lands on the
		// DevEnvironment object; it only drives the pod template and stsSpecHash
		// (see desiredStatefulSet).
		if env.Annotations == nil {
			env.Annotations = map[string]string{}
		}
		env.Annotations[sshKeysRevisionAnnotationKey] = digest
	} else {
		desired.Status.SSHClientKeySecret = nil
	}

	// 2b. Jupyter token secret: a random per-environment token guarding the web
	// path, injected into the workload as JUPYTER_TOKEN (design §6.3). It is
	// reconciled before the core resources so a pod never references a missing
	// Secret.
	if env.Spec.Type == aiv1alpha1.DevEnvironmentTypeJupyter {
		digest, err := r.reconcileJupyterTokenSecret(ctx, &env)
		if err != nil {
			return ctrl.Result{}, err
		}
		// Named through the same helper the workload's SecretKeyRef uses, so the
		// status and the injected JUPYTER_TOKEN cannot point at different Secrets.
		desired.Status.JupyterTokenSecret = &corev1.SecretReference{Name: jupyterTokenSecretName(&env), Namespace: env.Namespace}
		// Carry the token revision to applyStatefulSet below. env is re-fetched
		// every reconcile and only its status is persisted, so this in-memory
		// annotation never lands on the DevEnvironment object; it only drives the
		// pod-template annotation and stsSpecHash (see desiredStatefulSet).
		if env.Annotations == nil {
			env.Annotations = map[string]string{}
		}
		env.Annotations[jupyterTokenRevisionAnnotationKey] = digest
	} else {
		desired.Status.JupyterTokenSecret = nil
	}

	// 3. Core resources. The sidecar's authorization comes first: a pod naming a
	// ServiceAccount that does not exist yet never schedules, and the StatefulSet
	// below names one for every idle-enabled environment.
	if err := r.reconcileActivityAgentRBAC(ctx, &env); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.applyService(ctx, &env); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.applyNetworkPolicy(ctx, &env); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.applyStatefulSet(ctx, &env); err != nil {
		return ctrl.Result{}, err
	}

	// 4. Gateway routes: best-effort, never fails the reconcile (design §6.2).
	if err := r.reconcileGatewayRoutes(ctx, &env, &desired.Status); err != nil {
		return ctrl.Result{}, err
	}

	// 5. Observe the pod, aggregate conditions and phase.
	pod, err := r.environmentPod(ctx, &env)
	if err != nil {
		return ctrl.Result{}, err
	}
	setPodScheduledCondition(&desired.Status.Conditions, pod)
	r.setPhaseAndReady(&env, &desired.Status, pod)
	// The phase is the one statement of what state the environment is in, so what
	// an address means follows from it rather than being decided again here.
	withdrawStoppedEndpoints(&desired.Status)

	// 6. Idle auto-stop (design §4.2 step 4). The mark is written here and only
	// here, from the phase just derived and the pod just observed; the replicas
	// and the phase that follow from it belong to the pass that reads it back.
	// So this pass's status still reports Running, which is what is true at this
	// instant: the mark stops the environment, it does not report it stopped.
	decision, err := r.reconcileIdleStop(ctx, &env, &desired.Status, pod)
	if err != nil {
		return ctrl.Result{}, err
	}

	if err := r.updateStatusIfChanged(ctx, &env, desired); err != nil {
		return ctrl.Result{}, err
	}
	r.emitLifecycleTransition(&env, desired)
	if decision.Stop {
		// The write to the environment is itself a watched update, so this
		// requeue is belt and braces rather than the mechanism.
		return ctrl.Result{Requeue: true}, nil
	}
	// RequeueAfter is the idle deadline — the one thing here that no watch can
	// wake the controller for, since an idle environment emits nothing to watch
	// (see idleCheckPeriod). Zero, the case for every environment with no timeout
	// and for one that is not running, is the zero Result, so those reconcile
	// exactly as they did before the timer existed.
	return ctrl.Result{RequeueAfter: decision.RequeueAfter}, nil
}

// updateStatusIfChanged writes the desired status only when it differs from
// the observed one.
func (r *DevEnvironmentReconciler) updateStatusIfChanged(ctx context.Context, env *aiv1alpha1.DevEnvironment, desired *aiv1alpha1.DevEnvironment) error {
	if !apiequality.Semantic.DeepEqual(env.Status, desired.Status) {
		// Patch, not Update: Update carries the resourceVersion of the object we
		// read, and that read is served by the informer cache, which lags the API
		// server — most visibly right after the finalizer patch above requeues
		// immediately, so the very next reconcile describes a version the server
		// has already moved past. It then 409-conflicts and forces a retry
		// reconcile. Status is this controller's own observed state, so it needs
		// no compare-and-swap; a merge patch drops the precondition.
		return r.Status().Patch(ctx, desired, client.MergeFrom(env))
	}
	return nil
}

// stopCompute scales the environment's StatefulSet to zero so a Failed
// environment no longer runs a workload while the workspace PVC survives. A
// missing or foreign StatefulSet is left alone.
func (r *DevEnvironmentReconciler) stopCompute(ctx context.Context, env *aiv1alpha1.DevEnvironment) error {
	sts := &appsv1.StatefulSet{}
	if err := r.Get(ctx, client.ObjectKey{Name: env.Name, Namespace: env.Namespace}, sts); err != nil {
		return client.IgnoreNotFound(err)
	}
	if err := ensureDevEnvOwned(sts, env); err != nil {
		return nil
	}
	if sts.Spec.Replicas != nil && *sts.Spec.Replicas == 0 {
		return nil
	}
	sts.Spec.Replicas = ptr(int32(0))
	return r.Update(ctx, sts)
}

// cleanup runs when the environment is being deleted: it reports the
// Terminating phase, deletes the managed resources (the StatefulSet deletion
// carries the workspace PVC's own retention policy, design §7), and drops the
// finalizer.
func (r *DevEnvironmentReconciler) cleanup(ctx context.Context, env *aiv1alpha1.DevEnvironment) error {
	desired := env.DeepCopy()
	setPhase(&desired.Status, aiv1alpha1.PhaseTerminating, reasonDeleting)
	if err := r.updateStatusIfChanged(ctx, env, desired); err != nil {
		return err
	}

	if err := r.deleteStatefulSet(ctx, env); err != nil {
		return err
	}
	for _, obj := range []client.Object{
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: env.Name, Namespace: env.Namespace}},
		&networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: env.Name, Namespace: env.Namespace}},
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: sshHostKeySecretName(env), Namespace: env.Namespace}},
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: sshClientKeySecretName(env), Namespace: env.Namespace}},
		// The pre-split bundled Secret: nothing creates it any more, but an
		// environment created before the split still has one.
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: sshLegacySecretName(env), Namespace: env.Namespace}},
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: jupyterTokenSecretName(env), Namespace: env.Namespace}},
	} {
		if err := r.Get(ctx, client.ObjectKeyFromObject(obj), obj); err != nil {
			if apierrors.IsNotFound(err) {
				continue
			}
			return err
		}
		// A same-name resource owned by someone else must never be deleted.
		if err := ensureDevEnvOwned(obj, env); err != nil {
			continue
		}
		if err := r.Delete(ctx, obj); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	if err := r.deleteRoutes(ctx, env); err != nil {
		return err
	}

	// Re-fetch for a fresh resourceVersion before mutating finalizers: the
	// status update above bumped it, so a stale Update would 409-conflict and
	// force a retry reconcile.
	fresh := &aiv1alpha1.DevEnvironment{}
	if err := r.Get(ctx, types.NamespacedName{Namespace: env.Namespace, Name: env.Name}, fresh); err != nil {
		return client.IgnoreNotFound(err)
	}
	fresh.Finalizers = slices.DeleteFunc(fresh.Finalizers, func(f string) bool { return f == devEnvFinalizer })
	return r.Update(ctx, fresh)
}

// deleteStatefulSet deletes the environment's StatefulSet, which is what ends
// the workload and, per its retention policy, disposes of the workspace claim. A
// missing or foreign StatefulSet is left alone.
func (r *DevEnvironmentReconciler) deleteStatefulSet(ctx context.Context, env *aiv1alpha1.DevEnvironment) error {
	sts := &appsv1.StatefulSet{}
	if err := r.Get(ctx, client.ObjectKey{Name: env.Name, Namespace: env.Namespace}, sts); err != nil {
		return client.IgnoreNotFound(err)
	}
	if err := ensureDevEnvOwned(sts, env); err != nil {
		return nil
	}
	if desiredWhenDeleted(env) == appsv1.RetainPersistentVolumeClaimRetentionPolicyType {
		if err := r.detachWorkspaceClaims(ctx, env, sts); err != nil {
			return err
		}
	}
	return client.IgnoreNotFound(r.Delete(ctx, sts))
}

// detachWorkspaceClaims makes the environment's workspace claims independent of
// the StatefulSet, so that deleting the set cannot take the workspace with it.
//
// cleanup runs straight off the deletion timestamp, which is what makes this
// necessary: an environment deleted right after pvcRetention was set to retain
// is deleted before the policy reaches the StatefulSet, whose whenDeleted still
// says delete. The claim then carries a controller reference to the set and is
// garbage-collected with it — the retain request loses exactly the data it asked
// to keep. The policy is converged onto the set first, so the StatefulSet
// controller stops treating the claims as deletable, and the reference is then
// removed here rather than waited for: a set stopped before the policy changed
// (replicas 0, no pod) is never revisited by that controller, which only fixes
// claims for pods it can see, so waiting on it would leave the environment stuck
// in Terminating.
func (r *DevEnvironmentReconciler) detachWorkspaceClaims(ctx context.Context, env *aiv1alpha1.DevEnvironment, sts *appsv1.StatefulSet) error {
	if policy := sts.Spec.PersistentVolumeClaimRetentionPolicy; policy == nil ||
		policy.WhenDeleted != appsv1.RetainPersistentVolumeClaimRetentionPolicyType {
		original := sts.DeepCopy()
		sts.Spec.PersistentVolumeClaimRetentionPolicy = &appsv1.StatefulSetPersistentVolumeClaimRetentionPolicy{
			WhenDeleted: appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
			WhenScaled:  appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
		}
		if err := r.Patch(ctx, sts, client.MergeFrom(original)); err != nil {
			return err
		}
	}

	// Looked up by label, not by the claim's name: the name is the StatefulSet
	// controller's to derive (<claim>-<set>-<ordinal>) and it is the one that
	// provisions the claim, so matching what it created beats recomputing it.
	var claims corev1.PersistentVolumeClaimList
	if err := r.List(ctx, &claims, client.InNamespace(env.Namespace),
		client.MatchingLabels{devEnvironmentLabelKey: env.Name}); err != nil {
		return err
	}
	for i := range claims.Items {
		claim := &claims.Items[i]
		original := claim.DeepCopy()
		claim.OwnerReferences = slices.DeleteFunc(claim.OwnerReferences, func(ref metav1.OwnerReference) bool {
			return ref.UID == sts.UID
		})
		if len(claim.OwnerReferences) == len(original.OwnerReferences) {
			continue
		}
		if err := r.Patch(ctx, claim, client.MergeFrom(original)); err != nil {
			return err
		}
	}
	return nil
}

// deleteRoutes removes the HTTPRoute, TCPRoutes, UDPRoutes and ListenerSet
// created for the environment, looked up by label because the route names embed
// allocated ports.
// A kind whose CRD is not served is skipped — the failed List leaves it with
// nothing to delete — rather than returning from the function: the Gateway API
// kinds arrive with separate CRDs, so stopping at the first miss would leak the
// objects of the kinds that are installed.
func (r *DevEnvironmentReconciler) deleteRoutes(ctx context.Context, env *aiv1alpha1.DevEnvironment) error {
	opts := []client.ListOption{client.InNamespace(env.Namespace), client.MatchingLabels{devEnvironmentLabelKey: env.Name}}
	var hrs gatewayv1.HTTPRouteList
	if err := r.List(ctx, &hrs, opts...); err != nil && !meta.IsNoMatchError(err) {
		return err
	}
	for i := range hrs.Items {
		if err := ensureDevEnvOwned(&hrs.Items[i], env); err != nil {
			continue
		}
		if err := r.Delete(ctx, &hrs.Items[i]); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	var trs gatewayv1.TCPRouteList
	if err := r.List(ctx, &trs, opts...); err != nil && !meta.IsNoMatchError(err) {
		return err
	}
	for i := range trs.Items {
		if err := ensureDevEnvOwned(&trs.Items[i], env); err != nil {
			continue
		}
		if err := r.Delete(ctx, &trs.Items[i]); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	var urs gatewayv1.UDPRouteList
	if err := r.List(ctx, &urs, opts...); err != nil && !meta.IsNoMatchError(err) {
		return err
	}
	for i := range urs.Items {
		if err := ensureDevEnvOwned(&urs.Items[i], env); err != nil {
			continue
		}
		if err := r.Delete(ctx, &urs.Items[i]); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	var lss gatewayv1.ListenerSetList
	if err := r.List(ctx, &lss, opts...); err != nil && !meta.IsNoMatchError(err) {
		return err
	}
	for i := range lss.Items {
		if err := ensureDevEnvOwned(&lss.Items[i], env); err != nil {
			continue
		}
		if err := r.Delete(ctx, &lss.Items[i]); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}

// SetupWithManager registers the DevEnvironment watch, the owned resources,
// and the label-based Pod/PVC watches (the pod and workspace PVC are owned by
// the StatefulSet, not the environment). Gateway watches are added only when
// the Gateway API CRDs are installed, since a missing CRD would fail the cache.
// It also validates the controller config, so a misconfiguration fails at
// startup rather than on every environment it touches.
func (r *DevEnvironmentReconciler) SetupWithManager(mgr ctrl.Manager) error {
	// A range with no ports in it is a configuration error, not an empty pool.
	// Left unchecked it surfaces per environment as allocatePort finding no
	// port, which reconcileGatewayRoutes reports as "no free port in the L4
	// port range 30000-20000" — a message that reads as exhaustion and sends
	// the reader looking for environments that are not there. Validated on the
	// defaulted config so an unset end is compared as its default, not as zero.
	//
	// The bounds are checked here too, because this is the last point before a
	// port reaches a listener: allocatePort would hand out a number the
	// dataplane cannot listen on, one environment at a time, for a mistake that
	// is one value on the command line.
	cfg := r.defaultedConfig()
	if cfg.L4PortRangeStart < 1 || cfg.L4PortRangeEnd > 65535 {
		return fmt.Errorf("the L4 port range %d-%d is outside the usable ports 1-65535",
			cfg.L4PortRangeStart, cfg.L4PortRangeEnd)
	}
	if cfg.L4PortRangeStart > cfg.L4PortRangeEnd {
		return fmt.Errorf("the L4 port range is empty: start %d is greater than end %d",
			cfg.L4PortRangeStart, cfg.L4PortRangeEnd)
	}
	if r.Recorder == nil {
		r.Recorder = mgr.GetEventRecorder(devEnvManagedByValue)
	}
	if r.APIReader == nil {
		r.APIReader = mgr.GetAPIReader()
	}
	builder := ctrl.NewControllerManagedBy(mgr).
		For(&aiv1alpha1.DevEnvironment{}).
		Owns(&appsv1.StatefulSet{}).
		Owns(&corev1.Service{}).
		Owns(&networkingv1.NetworkPolicy{}).
		Owns(&corev1.Secret{}).
		Watches(&corev1.Pod{}, handler.EnqueueRequestsFromMapFunc(r.enqueueForDevEnv)).
		Watches(&corev1.Secret{}, handler.EnqueueRequestsFromMapFunc(r.enqueueForDevEnvAuthorizedKeysSecret)).
		Watches(&corev1.Service{}, handler.EnqueueRequestsFromMapFunc(r.enqueueForDataplaneService)).
		Watches(&aiv1alpha1.DevEnvironment{}, handler.EnqueueRequestsFromMapFunc(r.enqueueAllDevEnvironments))
	// Each Gateway API kind is probed for itself before it is watched: they
	// arrive with separate CRDs — TCPRoute ships in the Gateway API's
	// experimental channel, ListenerSet is separate again — so an install can
	// carry the Gateway and the HTTPRoute without either, and a watch on a kind
	// the server does not serve fails the manager at startup. A probe that fails
	// for any reason other than an absent kind fails setup here instead of
	// silently dropping that watch for the manager's lifetime: see
	// gatewayAPICRDInstalled.
	watches := []struct {
		kind string
		add  func()
	}{
		{gatewayKind, func() {
			builder.Watches(&gatewayv1.Gateway{}, handler.EnqueueRequestsFromMapFunc(r.enqueueAllDevEnvironments))
		}},
		{httpRouteKind, func() { builder.Owns(&gatewayv1.HTTPRoute{}) }},
		{tcpRouteKind, func() { builder.Owns(&gatewayv1.TCPRoute{}) }},
		{udpRouteKind, func() { builder.Owns(&gatewayv1.UDPRoute{}) }},
		{listenerSetKind, func() { builder.Owns(&gatewayv1.ListenerSet{}) }},
	}
	for _, watch := range watches {
		installed, err := gatewayAPICRDInstalled(mgr, watch.kind)
		if err != nil {
			return fmt.Errorf("probing whether the %s kind is served: %w", watch.kind, err)
		}
		if installed {
			watch.add()
		}
	}
	// MaxConcurrentReconciles is pinned to 1 rather than left to default to it.
	// Port allocation reads the pool and then creates a TCPRoute, and nothing
	// reserves the port in between: it is safe only because this single worker
	// serializes the pair (see usedPorts). Raising this reopens that race and
	// needs a real reservation primitive first, so making it explicit is what
	// keeps the dependency from being broken by an unrelated tuning change.
	return builder.WithOptions(ctrlc.Options{MaxConcurrentReconciles: 1}).Complete(r)
}

// enqueueForDevEnv maps a labeled Pod or PVC to its DevEnvironment.
func (r *DevEnvironmentReconciler) enqueueForDevEnv(_ context.Context, obj client.Object) []reconcile.Request {
	envName := obj.GetLabels()[devEnvironmentLabelKey]
	if envName == "" {
		return nil
	}
	return []reconcile.Request{{NamespacedName: types.NamespacedName{Namespace: obj.GetNamespace(), Name: envName}}}
}

// enqueueAllDevEnvironments maps any change (e.g. a Gateway address update, or
// another environment's allocated port) to every DevEnvironment so ports can
// be released and reallocated.
func (r *DevEnvironmentReconciler) enqueueAllDevEnvironments(ctx context.Context, _ client.Object) []reconcile.Request {
	list := &aiv1alpha1.DevEnvironmentList{}
	if err := r.List(ctx, list); err != nil {
		return nil
	}
	reqs := make([]reconcile.Request, 0, len(list.Items))
	for _, env := range list.Items {
		reqs = append(reqs, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: env.Namespace, Name: env.Name}})
	}
	return reqs
}

// enqueueForDevEnvAuthorizedKeysSecret maps a Secret to the DevEnvironments that
// reference it as their authorized_keys source (spec.ssh.authorizedKeysSecret),
// so editing it re-reconciles them: the pod's volume is an ordinary Secret mount
// and kubelet delivers the new bytes on its own, but the reconcile is what
// re-checks the reference (the Secret may have been undelegated or had the entry
// removed since) and reports it. The reference is same-namespace
// (corev1.SecretKeySelector), so Secrets in other namespaces short-circuit
// cheaply.
func (r *DevEnvironmentReconciler) enqueueForDevEnvAuthorizedKeysSecret(ctx context.Context, obj client.Object) []reconcile.Request {
	secret := obj.(*corev1.Secret)
	list := &aiv1alpha1.DevEnvironmentList{}
	if err := r.List(ctx, list, client.InNamespace(secret.Namespace)); err != nil {
		return nil
	}
	reqs := make([]reconcile.Request, 0)
	for i := range list.Items {
		env := &list.Items[i]
		if env.Spec.SSH == nil || env.Spec.SSH.AuthorizedKeysSecret == nil || env.Spec.SSH.AuthorizedKeysSecret.Name != secret.Name {
			continue
		}
		reqs = append(reqs, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: env.Namespace, Name: env.Name}})
	}
	return reqs
}

// enqueueForDataplaneService maps the Gateway's dataplane Service to every
// DevEnvironment, because that Service is what says which port each listener is
// reachable on (see externalPorts).
//
// It needs its own watch: the Service is owned by Envoy Gateway, so the
// owner-based Service watch above passes it over, and the Gateway API status
// writes that re-enqueue environments only coincide with a dataplane change by
// Envoy Gateway's ordering. A nodePort is that controller's assignment, not
// ours — a dataplane recreated with different ones renumbers every listener
// without touching this environment's spec or allocation, and without this the
// address published in status.endpoints would name a port that is no longer
// open. It reuses the Service informer Owns already starts, so the watch itself
// costs no extra memory.
func (r *DevEnvironmentReconciler) enqueueForDataplaneService(ctx context.Context, obj client.Object) []reconcile.Request {
	cfg := r.defaultedConfig()
	if cfg.GatewayDataplaneNamespace == "" || obj.GetNamespace() != cfg.GatewayDataplaneNamespace {
		return nil
	}
	labels := obj.GetLabels()
	if labels[gatewayDataplaneNameLabel] != cfg.GatewayName ||
		labels[gatewayDataplaneNamespaceLabel] != cfg.GatewayNamespace {
		return nil
	}
	return r.enqueueAllDevEnvironments(ctx, obj)
}

// gatewayAPICRDInstalled reports whether one Gateway API kind is served, so the
// manager only watches the Gateway API objects this cluster actually has. The
// kinds arrive with separate CRDs, so each is probed for itself.
//
// Only "no such kind" means absent. Every other discovery failure is returned:
// the probe runs once, at startup, and a watch skipped here is skipped for the
// manager's lifetime — there is no periodic resync to notice later. Reading a
// transient discovery error or a missing RBAC grant on the CRDs as "not
// installed" would leave the manager running happily with objects it never
// watches, publishing addresses it never learns have gone stale.
func gatewayAPICRDInstalled(mgr ctrl.Manager, kind string) (bool, error) {
	_, err := mgr.GetRESTMapper().RESTMapping(
		schema.GroupKind{Group: gatewayv1.GroupName, Kind: kind}, gatewayv1.GroupVersion.Version)
	if err == nil {
		return true, nil
	}
	if meta.IsNoMatchError(err) {
		return false, nil
	}
	return false, err
}

// brandRule is vendor's image-naming rule (design §4.2): the predicate an image
// reference has to satisfy, and the phrase naming it in a mismatch message.
//
// The rule is the vendor's own token — "cuda" for nvidia, "maca" for metax —
// anywhere in the reference. nvidia products are self-built and spell it out in
// "base-cuda"; metax products are mirrored from the upstream Metax library under
// each package's own name: maca, maca-pytorch, maca-tensorflow. The two rules are
// deliberately the same shape, so the gate reads as one question — does the image
// name its vendor? — rather than a different check per vendor.
//
// Like vendorResource it is total, and for the same reason: an unresolvable
// vendor resolves to the metax rule rather than falling out of the switch and
// disabling the gate. Along the DevEnvironment path desiredGPU has already
// resolved the vendor, so only the two literals reach here; the default covers
// a half-filled or hand-built spec, as vendorResource's does.
func brandRule(vendor aiv1alpha1.AcceleratorVendor) (matches func(image string) bool, want string) {
	switch vendor {
	case aiv1alpha1.AcceleratorVendorNvidia:
		return func(image string) bool { return strings.Contains(image, "cuda") },
			`an image containing "cuda"`
	default:
		return func(image string) bool { return strings.Contains(image, "maca") },
			`an image containing "maca"`
	}
}

// brandMismatchReason returns a non-empty message when the requested GPU vendor
// does not match the image brand (design §4.2). Custom images must satisfy
// their vendor's naming rule. An environment that requests no GPU has no brand
// to match, so it is exempt — which is what lets a CPU-only environment run a
// CPU image.
func brandMismatchReason(env *aiv1alpha1.DevEnvironment) string {
	vendor, _, ok := desiredGPU(env)
	if !ok {
		return ""
	}
	matches, want := brandRule(vendor)
	if matches(strings.ToLower(env.Spec.Image)) {
		return ""
	}
	return fmt.Sprintf("image %q does not match gpu.vendor %s (expected %s); omit spec.resources.gpu for a CPU-only environment", env.Spec.Image, vendor, want)
}

// sshExposed reports whether SSH access is exposed: the ssh container type is
// always SSH; other types only when spec.ssh.enabled (design §6.1).
func sshExposed(env *aiv1alpha1.DevEnvironment) bool {
	if env.Spec.Type == aiv1alpha1.DevEnvironmentTypeSSH {
		return true
	}
	return env.Spec.SSH != nil && env.Spec.SSH.Enabled
}

// l4PortNames is the endpoint names this environment draws a port from the pool
// for: ssh when it is exposed, then every entry of spec.ports that is tcp or
// udp. It is the one list the allocation loop, the guard below and the
// recovered-allocation fallback read, so the three cannot disagree on what
// counts as L4 exposure — which is what the allocation loop used to spell a
// second time.
func l4PortNames(env *aiv1alpha1.DevEnvironment) []string {
	var names []string
	if sshExposed(env) {
		names = append(names, sshPortName)
	}
	for _, p := range env.Spec.Ports {
		// tcp and udp are the pool's two protocols and share its numbering: the
		// allocator keys on the port alone, so one number serves one protocol
		// for one environment (design §8.3).
		if p.Type == aiv1alpha1.PortTypeTCP || p.Type == aiv1alpha1.PortTypeUDP {
			names = append(names, p.Name)
		}
	}
	return names
}

// l4Exposed reports whether the environment declares any L4 exposure, i.e.
// whether it draws a port from the pool. It is the guard for every use of the
// TCPRoute, UDPRoute and ListenerSet kinds: each arrives with its own CRD, and
// an environment that exposes nothing on L4 must still publish its HTTPRoute in
// an install that carries none of them.
func l4Exposed(env *aiv1alpha1.DevEnvironment) bool {
	return len(l4PortNames(env)) > 0
}

// portProtocol is the transport an extra port is exposed over. http rides the
// Gateway's HTTP listener and is TCP underneath, so only udp differs.
func portProtocol(p aiv1alpha1.PortSpec) corev1.Protocol {
	if p.Type == aiv1alpha1.PortTypeUDP {
		return corev1.ProtocolUDP
	}
	return corev1.ProtocolTCP
}

// l4Protocol is the transport an allocated endpoint speaks, looked up by
// endpoint name the way servicePortFor resolves a Service port — the allocation
// map is keyed by name and built from the same spec, so every name it holds has
// an answer. The SSH endpoint is not one of spec.ports and is TCP, which is
// also what an unrecognised name falls back to.
func l4Protocol(env *aiv1alpha1.DevEnvironment, name string) corev1.Protocol {
	for _, p := range env.Spec.Ports {
		if p.Name == name {
			return portProtocol(p)
		}
	}
	return corev1.ProtocolTCP
}

// l4ListenerFor is a transport as the two spellings a listener needs it in: the
// ListenerSet listener's protocol, and the single route kind that listener
// admits. A listener accepts routes of its own protocol and nothing else, so
// the pair is decided in one place rather than two switches that could drift.
func l4ListenerFor(protocol corev1.Protocol) (gatewayv1.ProtocolType, string) {
	if protocol == corev1.ProtocolUDP {
		return gatewayv1.UDPProtocolType, udpRouteKind
	}
	return gatewayv1.TCPProtocolType, tcpRouteKind
}

// sshUserKeysRef is the delegated Secret the environment takes its authorized
// keys from, or nil when the controller generates them instead.
func sshUserKeysRef(env *aiv1alpha1.DevEnvironment) *corev1.SecretKeySelector {
	if env.Spec.SSH == nil {
		return nil
	}
	return env.Spec.SSH.AuthorizedKeysSecret
}

// sshAuthorizedKeysSource is the name and data key of the Secret the pod mounts
// as /run/ssh/authorized_keys: the user's delegated Secret when the spec names
// one, at the data key its selector names, else the controller-generated
// <env>-ssh-client-key at sshClientPubKeyKey — the client keypair's public half,
// which is the key that actually logs in.
//
// The delegated key is always non-empty: the CRD requires the field and rejects
// an empty one, so there is nothing here to fall back to — substituting an entry
// of our own would mount a file the spec never named.
//
// The reconciler and desiredPodSpec both call this, so the entry the pod mounts
// can never disagree with the entry the reconciler validates.
func sshAuthorizedKeysSource(env *aiv1alpha1.DevEnvironment) (name, key string) {
	if ks := sshUserKeysRef(env); ks != nil {
		return ks.Name, ks.Key
	}
	return sshClientKeySecretName(env), sshClientPubKeyKey
}

// sshMountKey renders the ssh mount contract for the pod-template hash: the
// version of the mount shape plus the source of the authorized keys, which is
// the part a hand-assembled hash cannot otherwise see (see stsSpecHash).
func sshMountKey(env *aiv1alpha1.DevEnvironment) string {
	name, key := sshAuthorizedKeysSource(env)
	return sshMountContractVersion + "/" + name + "/" + key
}

// mainContainerPort is the primary container port by type: jupyter 8888,
// vscode 8080, ssh the unprivileged port the base images' sshd binds
// (design §6.1, Gap B). It is the port the container listens on, which is what
// the readiness probe targets; the Service publishes ssh on sshServicePort
// instead, since only the container side had to move.
func mainContainerPort(t aiv1alpha1.DevEnvironmentType) int32 {
	switch t {
	case aiv1alpha1.DevEnvironmentTypeJupyter:
		return 8888
	case aiv1alpha1.DevEnvironmentTypeVSCode:
		return 8080
	default:
		return sshContainerPort
	}
}

// desiredGPU resolves the requested accelerator: its vendor, its count, and
// whether one is requested at all. An absent block is the only way to ask for no
// accelerator — it is deliberately not defaulted into existence — so there is no
// count-is-zero special case to remember. This is the single place that applies
// the GPUSpec defaults a Go-constructed object never went through, matching what
// the API server would have written: a nil count is 1, a count below the
// minimum is 1, and an unset vendor is nvidia.
//
// The two resolutions are total on purpose: every caller gets one of exactly two
// vendors and a count of at least one, so the readers of this block cannot
// disagree about what was asked for. That is what the block buys over two flat
// fields, where the vendor→resource mapping fell through to nvidia while the
// vendor→brand mapping fell through to "no constraint at all".
func desiredGPU(env *aiv1alpha1.DevEnvironment) (aiv1alpha1.AcceleratorVendor, int32, bool) {
	gpu := env.Spec.Resources.GPU
	if gpu == nil {
		return "", 0, false
	}
	count := int32(1)
	if gpu.Count != nil && *gpu.Count > 0 {
		count = *gpu.Count
	}
	vendor := aiv1alpha1.AcceleratorVendorNvidia
	if gpu.Vendor == aiv1alpha1.AcceleratorVendorMetax {
		vendor = aiv1alpha1.AcceleratorVendorMetax
	}
	return vendor, count, true
}

// desiredContainerPorts declares the ports the environment's container listens
// on, in the order desiredService publishes them: the type's main port, ssh
// when it is exposed and is not already the main port, then each spec.ports
// entry.
//
// The list exists for the host network, and only a host-network environment
// declares it. Such an environment binds these ports on the node rather than in
// a namespace of its own, and the scheduler counts a host-network pod's
// declared container ports as host ports. Declaring them is therefore what
// keeps a second environment wanting the same fixed port off the node —
// mainContainerPort is 8888, 8080 or 2222 by type — and turns a runtime bind
// failure into a pod that stays Pending/NotScheduled. hostPort is set to match,
// as podspec.go does for InferenceService, though kubelet does not forward it
// for a host-network pod: the declaration is what the scheduler reads. On the
// pod network the list would say nothing the Service does not already say, so
// it is left off rather than added for everyone.
//
// The seen set is keyed by port and protocol because the list need not be
// distinct. The ssh type's main port *is* sshContainerPort, which is why the
// ssh entry is guarded by type rather than added outright, and spec.ports is
// free to repeat a port the platform already declared or one it declares twice
// — the schema bounds a port's range but reserves none of the platform's own
// numbers.
func desiredContainerPorts(env *aiv1alpha1.DevEnvironment) []corev1.ContainerPort {
	var ports []corev1.ContainerPort
	seen := map[string]bool{}
	add := func(name string, port int32, protocol corev1.Protocol) {
		key := fmt.Sprintf("%d/%s", port, protocol)
		if seen[key] {
			return
		}
		seen[key] = true
		ports = append(ports, corev1.ContainerPort{
			Name: name, ContainerPort: port, Protocol: protocol, HostPort: port,
		})
	}
	add(mainPortName, mainContainerPort(env.Spec.Type), corev1.ProtocolTCP)
	if sshExposed(env) && env.Spec.Type != aiv1alpha1.DevEnvironmentTypeSSH {
		add(sshPortName, sshContainerPort, corev1.ProtocolTCP)
	}
	for _, p := range env.Spec.Ports {
		add(p.Name, p.ContainerPort, portProtocol(p))
	}
	return ports
}

// rdmaResource resolves the environment's RDMA request: the extended resource
// to claim, and whether the environment must share the host network namespace
// to reach it. Both are empty when spec.network asks for no RDMA.
//
// The enabled flag alone decides. rdmaType carries an API default of "roce", so
// it reads "roce" on every environment in the cluster, including the ones that
// never asked for RDMA — branching on the type without the flag would put every
// environment on the host network. spec.network is a pointer with no default of
// its own either, so a spec that omits the block leaves it nil.
//
// RoCE needs the host namespace for the fabric itself, not for routing: RoCEv2
// derives its GIDs from the IPs of the interfaces inside the network namespace,
// so a pod with a namespace of its own has an empty GID table and can bring up
// no queue pair at all. InfiniBand addresses from the port GUID and the subnet
// manager's LID instead, neither of which depends on the namespace.
func (r *DevEnvironmentReconciler) rdmaResource(env *aiv1alpha1.DevEnvironment) (corev1.ResourceName, bool) {
	if env.Spec.Network == nil || !env.Spec.Network.RDMAEnabled {
		return "", false
	}
	cfg := r.defaultedConfig()
	if env.Spec.Network.RDMAType == aiv1alpha1.RDMATypeInfiniBand {
		return corev1.ResourceName(cfg.RDMAIBResource), false
	}
	return corev1.ResourceName(cfg.RDMARoCEResource), true
}

// desiredResources maps the requested compute to container resources: the GPU
// is both requested and limited; CPU/memory are limits only (design §3.2.2).
// An environment that requests no accelerator leaves the vendor resource out
// entirely rather than requesting zero — a zero request would still pin the
// pod to a node advertising that resource.
//
// rdma names the fabric's extended resource, or is empty when the environment
// asked for none. It takes the GPU's shape for the same reason, and one more
// the GPU does not have: extended resources cannot be overcommitted, so the
// API server rejects a request with no matching limit. One device is requested,
// which is one verbs device — the plugin's rdmaHcaMax caps how many pods may
// share the HCA set, it is not a per-pod device count.
func desiredResources(env *aiv1alpha1.DevEnvironment, rdma corev1.ResourceName) corev1.ResourceRequirements {
	limits := corev1.ResourceList{}
	requests := corev1.ResourceList{}
	if vendor, count, ok := desiredGPU(env); ok {
		gpuName := corev1.ResourceName(vendorResource(vendor))
		gpu := resource.NewQuantity(int64(count), resource.DecimalSI)
		limits[gpuName] = *gpu
		requests[gpuName] = *gpu
	}
	if rdma != "" {
		device := resource.NewQuantity(1, resource.DecimalSI)
		limits[rdma] = *device
		requests[rdma] = *device
	}
	if env.Spec.Resources.CPU != "" {
		limits[corev1.ResourceCPU] = resource.MustParse(env.Spec.Resources.CPU)
	}
	if env.Spec.Resources.Memory != "" {
		limits[corev1.ResourceMemory] = resource.MustParse(env.Spec.Resources.Memory)
	}
	return corev1.ResourceRequirements{Limits: limits, Requests: requests}
}

// withRDMACapabilities adds IPC_LOCK to the RDMA-enabled container's security
// context. Registering an RDMA memory region (ibv_reg_mr) pins pages in memory,
// which the default capability set does not permit, so the call fails on a
// container that cannot lock them.
//
// It adds and never drops: dropping ALL would strip the runtime's own default
// set, which the images' entrypoints rely on for setuid and chown — a change
// with reach well beyond RDMA. The capability does not grant the container
// access to the device; the device plugin does that through the device cgroup,
// and a node file crafted by hand opens EPERM regardless.
func withRDMACapabilities(sc *corev1.SecurityContext) *corev1.SecurityContext {
	if sc.Capabilities == nil {
		sc.Capabilities = &corev1.Capabilities{}
	}
	sc.Capabilities.Add = append(sc.Capabilities.Add, "IPC_LOCK")
	return sc
}

// desiredSecurityContext enforces the non-root default: runAsUser=1000 unless
// the user explicitly requests root (runAsUser=0), which disables runAsNonRoot
// (design §9.2).
func desiredSecurityContext(rt *aiv1alpha1.RuntimeSpec) *corev1.SecurityContext {
	runAsNonRoot := ptr(true)
	runAsUser := int64(1000)
	runAsGroup := int64(1000)
	if rt != nil && rt.SecurityContext != nil {
		if rt.SecurityContext.RunAsUser != nil {
			runAsUser = *rt.SecurityContext.RunAsUser
			if runAsUser == 0 {
				runAsNonRoot = ptr(false)
			}
		}
		if rt.SecurityContext.RunAsGroup != nil {
			runAsGroup = *rt.SecurityContext.RunAsGroup
		}
	}
	return &corev1.SecurityContext{
		RunAsNonRoot: runAsNonRoot,
		RunAsUser:    ptr(runAsUser),
		RunAsGroup:   ptr(runAsGroup),
	}
}

// desiredPermissionInitContainer returns the init container that makes the
// workspace claim writable by the account the environment runs as. A claim is
// mounted root:root, and a non-root account can neither write it nor create the
// ~/.ssh it keeps there, so something has to establish the ownership on the way
// in.
//
// It is the workspace claim, and only the workspace claim. The pod-level fsGroup
// this replaces was the alternative, and it is Pod-scoped: it chowns every volume
// in the pod mounted read-write, including a PVC shared through spec.volumes that
// this platform does not own. Kubernetes has no per-mount fsGroup, so the only
// way to scope the operation to the storage the platform provisions for the
// environment is to perform it here — and an init container that does not mount a
// volume has no path through which it could modify one.
//
// The privilege is correspondingly narrow: root, with every capability dropped
// and three added back. CAP_CHOWN is what changing the owner of a file the
// process does not own requires. CAP_FOWNER and CAP_FSETID are what setting the
// mode on a claim root that belongs to a *previous* identity requires: a claim
// outlives the identity it was initialized for, so editing
// spec.runtime.securityContext leaves one owned by a uid the container is
// neither the owner nor grouped with. Without CAP_FOWNER the chmod is EPERM and
// the environment never starts; without CAP_FSETID it succeeds and silently
// drops the setgid bit. It is not privileged, cannot escalate, and reaches no
// host path. Note that a namespace enforcing the Restricted Pod Security
// Standard rejects exactly this — root and any capability beyond
// NET_BIND_SERVICE — so a namespace hosting an environment with spec.storage
// has to be at Baseline, where these three are among the capabilities that
// remain allowed. Dropping the init container would not buy Restricted: an
// environment without storage is refused there too, for what the main container
// leaves undeclared (README).
// An RDMA environment raises that floor to Privileged: IPC_LOCK is outside
// Baseline's allowed set, and a RoCE one adds hostNetwork, which both Baseline
// and Restricted forbid outright (spec.network.rdmaEnabled).
// What the container actually runs is ::permissionInitScript.
func desiredPermissionInitContainer(env *aiv1alpha1.DevEnvironment) corev1.Container {
	// Both pointers are always set by desiredSecurityContext, which defaults them
	// to the platform's 1000/1000 when the spec names neither.
	sc := desiredSecurityContext(env.Spec.Runtime)
	return corev1.Container{
		Name:    permissionInitContainerName,
		Image:   permissionInitImage,
		Command: []string{"/bin/sh", "-c", permissionInitScript},
		Env: []corev1.EnvVar{
			{Name: permissionInitPathEnv, Value: permissionInitMountPath},
			{Name: permissionInitUIDEnv, Value: strconv.FormatInt(*sc.RunAsUser, 10)},
			{Name: permissionInitGIDEnv, Value: strconv.FormatInt(*sc.RunAsGroup, 10)},
		},
		SecurityContext: &corev1.SecurityContext{
			RunAsUser:                ptr(int64(0)),
			RunAsGroup:               ptr(int64(0)),
			RunAsNonRoot:             ptr(false),
			Privileged:               ptr(false),
			AllowPrivilegeEscalation: ptr(false),
			Capabilities: &corev1.Capabilities{
				Drop: []corev1.Capability{allCapabilities},
				Add:  []corev1.Capability{"CHOWN", "FOWNER", "FSETID"},
			},
		},
		VolumeMounts: []corev1.VolumeMount{
			{Name: workspaceClaimName, MountPath: permissionInitMountPath},
		},
	}
}

// jupyterTokenPodAnnotations returns the pod-template annotations derived from
// env for a jupyter environment: a non-sensitive sha256 digest of the managed
// token carried from reconcileJupyterTokenSecret via env.Annotations (in-memory
// only, never persisted on the DevEnvironment). Because JUPYTER_TOKEN is read
// from the Secret at container start, putting the digest on the pod template
// changes the template (and stsSpecHash) when the token is created or refilled,
// so applyStatefulSet rolls the workload onto the new token. The digest reveals
// nothing about the token itself, so no plaintext ever reaches the pod.
func jupyterTokenPodAnnotations(env *aiv1alpha1.DevEnvironment) map[string]string {
	if env.Spec.Type != aiv1alpha1.DevEnvironmentTypeJupyter {
		return nil
	}
	rev := env.Annotations[jupyterTokenRevisionAnnotationKey]
	if rev == "" {
		return nil
	}
	return map[string]string{jupyterTokenRevisionAnnotationKey: rev}
}

// sshKeysPodAnnotations is jupyterTokenPodAnnotations for the host identity: the
// digest carried from reconcileSSHSecrets via env.Annotations (in-memory only,
// never persisted on the DevEnvironment) changes the pod template — and so
// stsSpecHash — whenever the host key does, which is the only way its subPath
// mount ever picks that up. It also rolls the workload once on upgrade from a
// controller that stamped no revision at all.
func sshKeysPodAnnotations(env *aiv1alpha1.DevEnvironment) map[string]string {
	if !sshExposed(env) {
		return nil
	}
	rev := env.Annotations[sshKeysRevisionAnnotationKey]
	if rev == "" {
		return nil
	}
	return map[string]string{sshKeysRevisionAnnotationKey: rev}
}

// podTemplateAnnotations merges the annotations that roll the workload when
// controller-managed secret material changes.
func podTemplateAnnotations(env *aiv1alpha1.DevEnvironment) map[string]string {
	ann := map[string]string{}
	maps.Copy(ann, jupyterTokenPodAnnotations(env))
	maps.Copy(ann, sshKeysPodAnnotations(env))
	if len(ann) == 0 {
		return nil
	}
	return ann
}

// runtimeUser is the account the environment's sshd serves: spec.runtime.user,
// else the platform default. A root environment serves root whatever the spec
// names. The address is where a user reads which account to log in as, and root
// is the only account the platform can promise there: it is the one whose uid
// the sshd runs as, where which family account a root sshd admits beside it is
// the image's to decide rather than the spec's.
func runtimeUser(env *aiv1alpha1.DevEnvironment) string {
	if sc := env.Spec.Runtime; sc != nil && sc.SecurityContext != nil &&
		sc.SecurityContext.RunAsUser != nil && *sc.SecurityContext.RunAsUser == 0 {
		return rootRuntimeUser
	}
	if env.Spec.Runtime != nil && env.Spec.Runtime.User != "" {
		return env.Spec.Runtime.User
	}
	return defaultRuntimeUser
}

// resolveMountPath is where the workspace PVC mounts: an explicit
// spec.storage.mountPath wins, then the home the environment declares through
// HOME in spec.runtime.env, then the home the runtime identity implies — /root
// for root, /home/<user> for a named account — else the platform default. A
// container account is constrained by the CRD pattern to
// ^[a-z_][a-z0-9_-]*$, so it cannot inject a path separator.
//
// The answer is also the home the controller states on the container, so where
// the claim mounts and what the container is told are one decision rather than
// two that happen to agree (::resolvedHome, ::withWorkspaceHome). A launcher that
// serves HOME therefore serves the workspace with nothing of its own to infer,
// and an explicit mountPath moves a declared HOME with it rather than leaving the
// container pointed at a directory the claim is not mounted at.
//
// A declared HOME precedes the home the identity implies because it is the more
// specific statement about where the container will look: an image whose
// launcher relocates the account's home — stock docker-stacks moves root's to
// /home/root — says so in HOME, and any other mount leaves the claim unused
// while the workload writes to the container filesystem.
//
// The identity cases read the spec rather than runtimeUser: an environment that
// names no account gets /workspace, not /home/user.
func resolveMountPath(env *aiv1alpha1.DevEnvironment) string {
	if env.Spec.Storage != nil && env.Spec.Storage.MountPath != "" {
		return env.Spec.Storage.MountPath
	}
	if home := declaredHome(env); home != "" {
		return home
	}
	if sc := env.Spec.Runtime; sc != nil && sc.SecurityContext != nil &&
		sc.SecurityContext.RunAsUser != nil && *sc.SecurityContext.RunAsUser == 0 {
		return "/root"
	}
	if env.Spec.Runtime != nil && env.Spec.Runtime.User != "" {
		return "/home/" + env.Spec.Runtime.User
	}
	return defaultWorkspacePath
}

// declaredHome is the home an environment declares through HOME in
// spec.runtime.env, empty when it declares none. The last entry named HOME is
// the one the container applies, so a final entry that is not usable leaves the
// environment declaring no home rather than reviving an earlier one the
// container overrides.
//
// An absolute path written out is the only usable form. A valueFrom source
// cannot be read while reconciling without watching whatever it reads, a
// relative value does not name a mount path, and the kubelet expands $(VAR) —
// the claim would be mounted at the unexpanded text while the container's home
// is the expanded one, which is the mismatch this whole derivation exists to
// avoid.
func declaredHome(env *aiv1alpha1.DevEnvironment) string {
	if env.Spec.Runtime == nil {
		return ""
	}
	home := ""
	for _, v := range env.Spec.Runtime.Env {
		if v.Name != homeEnv {
			continue
		}
		if v.ValueFrom != nil || !strings.HasPrefix(v.Value, "/") || strings.Contains(v.Value, "$(") {
			home = ""
			continue
		}
		home = v.Value
	}
	return home
}

// isNotebookBaseURLArg reports whether one whitespace-separated NOTEBOOK_ARGS
// argument carries the prefix flag the controller owns. The render path and the
// report of what it dropped share it, so the two cannot disagree about which
// arguments the controller replaces (::withNotebookBaseURL, ::specFindings).
func isNotebookBaseURLArg(arg string) bool {
	return strings.HasPrefix(arg, notebookBaseURLFlag)
}

// withNotebookBaseURL merges notebookBaseURLFlag+path into the environment's
// NOTEBOOK_ARGS, adding the variable when the environment declares none.
//
// The route forwards webPath(env) unchanged, so a container serving anywhere
// else 404s on every published URL: a base_url the environment declares of its
// own is therefore dropped, not kept. Every other flag is preserved, and
// JUPYTER_TOKEN sets the same precedent for a value the controller owns
// (::desiredPodSpec). Dropping rather than appending a second flag keeps a
// contradictory value out of the container's own environment.
//
// Splitting the value into whitespace-separated arguments is what makes the
// drop safe: Jupyter's launcher splits the same way, and a flag whose value
// contains a space is written quoted, so it stays one argument across
// strings.Fields and the join that follows.
//
// An entry fed by valueFrom never reaches here — its value cannot be read while
// reconciling, so the reconcile refuses the environment instead
// (::unsupportedNotebookArgsReason).
func withNotebookBaseURL(envVars []corev1.EnvVar, path string) []corev1.EnvVar {
	for i, v := range envVars {
		if v.Name != notebookArgsEnv {
			continue
		}
		kept := slices.DeleteFunc(strings.Fields(v.Value), isNotebookBaseURLArg)
		envVars[i].Value = strings.TrimSpace(strings.Join(append(kept, notebookBaseURLFlag+path), " "))
		return envVars
	}
	return append(envVars, corev1.EnvVar{Name: notebookArgsEnv, Value: notebookBaseURLFlag + path})
}

// withWorkspaceHome states the environment's home on the container. The claim
// the platform mounts is the environment's workspace, so the path it mounts at
// is what HOME has to name (::resolveMountPath, ::resolvedHome): a launcher that
// reads HOME then serves the workspace without having to know what its own image
// bakes.
//
// Every declared HOME entry is dropped rather than the last one replaced. Only
// the last of several ever applies, so the others are dead entries already, and
// which one a container takes is not something the render path should have to
// reproduce to be right.
//
// The stated home goes first, ahead of every declared entry. The kubelet
// expands $(VAR) in a single pass down the list, so a value naming HOME
// resolves only against a home it has already passed (::declaredHome reads the
// same expansion the other way, which is why an unexpanded reference is not a
// usable mount path). Appending would leave a spec's `PROJECT=$(HOME)/project`
// naming the literal text, while the home itself reads no variable and so is
// resolved the same wherever it sits. Nothing downstream keeps this order — the
// kubelet hands the runtime its variables from a map — so this is the only pass
// it matters to.
//
// That same expansion applies to every EnvVar.Value, and the claim's mount path
// is not expanded with it: a doubled dollar is reduced to one, and a $(NAME)
// reference is resolved against the variables already passed. Either one written
// into a path is therefore stated escaped, so that what the container reads is
// the path the claim is mounted at rather than an expansion of it. An explicit
// spec.storage.mountPath needs this most, since ::declaredHome's refusal of a
// $(NAME) does not reach a path the spec pins directly.
func withWorkspaceHome(envVars []corev1.EnvVar, path string) []corev1.EnvVar {
	envVars = slices.DeleteFunc(envVars, func(v corev1.EnvVar) bool { return v.Name == homeEnv })
	return append([]corev1.EnvVar{{Name: homeEnv, Value: strings.ReplaceAll(path, "$", "$$")}}, envVars...)
}

// resolvedHome is the home the controller states on the container — the path the
// workspace claim mounts at — and whether it states one at all. Without a claim
// there is no workspace to name and the controller states nothing, so the
// container keeps whatever the spec's own env list leaves it: the home the spec
// declares, and only failing that the one its image bakes. A claim-less root
// environment is the case both jupyter launchers still guard for.
//
// The value is the whole derivation rather than its home term, so an explicit
// spec.storage.mountPath moves HOME with the claim: the claim is the workspace,
// and a container told otherwise writes to its filesystem while the claim sits
// unused — the failure the derivation exists to prevent.
//
// The render path and specFindings share it, so a declared HOME the controller
// replaces is reported by the same predicate that replaces it.
func resolvedHome(env *aiv1alpha1.DevEnvironment) (string, bool) {
	if env.Spec.Storage == nil {
		return "", false
	}
	return resolveMountPath(env), true
}

// rootLauncherEnvNeeded reports whether the environment is one the controller
// supplies the launcher's own root settings for (::withRootLauncherEnv). The
// render path and stsSpecHash share it, so the digest that rolls an environment
// onto the injected shape covers exactly the environments that receive it.
func rootLauncherEnvNeeded(env *aiv1alpha1.DevEnvironment) bool {
	return env.Spec.Type == aiv1alpha1.DevEnvironmentTypeJupyter &&
		*desiredSecurityContext(env.Spec.Runtime).RunAsUser == 0
}

// isRootLauncherEnvName reports whether a spec.runtime.env entry names one of
// the launcher settings the controller supplies on a root environment. The
// render path and the report of what it dropped share it, so the two cannot
// disagree about which names the controller owns (::withRootLauncherEnv,
// ::specFindings).
func isRootLauncherEnvName(name string) bool {
	switch name {
	case nbUserEnv, nbUIDEnv, nbGIDEnv:
		return true
	}
	return false
}

// withRootLauncherEnv supplies what a Jupyter launcher needs when the container
// runs as root, so that spec.runtime.securityContext alone decides whether an
// environment runs as root.
//
// docker-stacks' start.sh treats uid 0 as a startup mode: it reads the account to
// serve from NB_USER and the identity to serve it as from NB_UID/NB_GID, and with
// the three unset it drops back to the image's stock account — an environment the
// platform runs as, and advertises as, root would serve jovyan instead. Jupyter
// Server refuses to start as root without --allow-root, and a launcher that exits
// takes the sshd the entrypoint started with it, so the environment would never
// become reachable at all.
//
// The three names describe the *account* in the image's passwd database, which for
// root is 0:0, and not the identity the pod runs as — spec.runtime.securityContext
// names that one, and the two are deliberately different numbers. start.sh rewrites
// the account whenever the two disagree, and that rewrite cannot complete for root:
// the launcher dies there ("userdel: user root is currently used by process 1") and
// takes the container with it. Measured on jupyter-minimal: a pod running as 0:1000
// with NB_GID=1000 exits before the notebook is up, and the same pod with NB_GID=0
// starts. So the pod's group is not a value these may be derived from.
//
// The shipped images no longer read them: a root container on the CPU image leaves
// start.sh out of the chain entirely (images/jupyter/start-jupyter.sh), and the MACA
// launcher expands NOTEBOOK_ARGS alone. They are supplied all the same, because the
// controller sees only spec.image: a stock docker-stacks image, which is what a
// bring-your-own jupyter environment is, is served by that launcher and nothing else.
//
// An entry the spec declares under one of these names is dropped rather than
// merged: a value the controller owns is not one the spec may contradict
// (::withNotebookBaseURL, JUPYTER_TOKEN). --allow-root is appended only when the
// environment does not carry it already, so a flag list the user maintains keeps
// the flags it has.
//
// An image whose launcher reads none of this is unaffected: the variables are
// inert where nothing reads them, and the controller sees only spec.image, so it
// cannot tell a stock Jupyter image from a vendor one.
func withRootLauncherEnv(envVars []corev1.EnvVar) []corev1.EnvVar {
	envVars = slices.DeleteFunc(envVars, func(v corev1.EnvVar) bool {
		return isRootLauncherEnvName(v.Name)
	})
	envVars = append(envVars,
		corev1.EnvVar{Name: nbUserEnv, Value: rootRuntimeUser},
		corev1.EnvVar{Name: nbUIDEnv, Value: rootAccountUID},
		corev1.EnvVar{Name: nbGIDEnv, Value: rootAccountGID},
	)
	// Into the entry withNotebookBaseURL rewrites and adds when absent, so the
	// launcher reads one NOTEBOOK_ARGS carrying both the prefix and this flag.
	for i, v := range envVars {
		if v.Name != notebookArgsEnv {
			continue
		}
		if !slices.Contains(strings.Fields(v.Value), notebookAllowRootFlag) {
			envVars[i].Value = strings.TrimSpace(v.Value + " " + notebookAllowRootFlag)
		}
		return envVars
	}
	return append(envVars, corev1.EnvVar{Name: notebookArgsEnv, Value: notebookAllowRootFlag})
}

// unsupportedNotebookArgsReason reports a jupyter environment whose
// NOTEBOOK_ARGS the controller cannot bring in line with the published path.
//
// Only a valueFrom source qualifies. A plain value is not refused: the
// controller reads it, drops any base_url it carries and appends its own
// (::withNotebookBaseURL). A valueFrom source is unreadable while reconciling —
// reading it would mean watching whatever it reads — so whether it hides a
// conflicting base_url is unknowable, and the environment would be published
// with an address that 404s.
func unsupportedNotebookArgsReason(env *aiv1alpha1.DevEnvironment) string {
	if env.Spec.Type != aiv1alpha1.DevEnvironmentTypeJupyter || env.Spec.Runtime == nil {
		return ""
	}
	for _, v := range env.Spec.Runtime.Env {
		if v.Name == notebookArgsEnv && v.ValueFrom != nil {
			return fmt.Sprintf("%s cannot come from valueFrom: the controller injects %s%s into it so the notebook serves the prefix its route publishes, which it cannot do for a value it cannot read", notebookArgsEnv, notebookBaseURLFlag, webPath(env))
		}
	}
	return ""
}

// specFinding is one place where the controller resolves an environment's spec
// itself rather than applying it as written.
type specFinding struct {
	// reason names the cause, and becomes the Accepted condition's reason when
	// this is the first finding that must be updated.
	reason string
	// field is the spec field the finding is about, without the "spec." prefix
	// findingsMessage adds.
	field string
	// detail says what the controller applies instead, and what the user can do
	// about it.
	detail string
	// mustUpdate separates the two dispositions: true when the controller refuses
	// to run the spec until the user changes it, false when the controller has
	// resolved the field and the environment runs anyway.
	mustUpdate bool
}

// specFindings reports every disagreement between what an environment's spec
// states and what the controller applies. The Accepted condition is its only
// reader (::Reconcile): the findings that must be updated fail the environment,
// and the rest are reported without blocking.
//
// Every check asks the same question the render path asks, through the same
// predicate, so this can neither describe a substitution that does not happen
// nor miss one that does. The render path stays the authority on what is
// applied; read a check as a report on it, not as a second implementation.
//
// What is out of scope is as deliberate as what is in it: an environment whose
// only symptom is cluster state — a storage class nothing provisions, a gateway
// that is not ready — has not disagreed with the controller about anything, and
// the conditions that observe that state report it (PodScheduled, RouteReady).
func specFindings(env *aiv1alpha1.DevEnvironment) []specFinding {
	var findings []specFinding
	// The two refusals come first: a finding that fails the environment decides
	// the phase and the Accepted reason, so it has to precede the ones that only
	// report a value the controller resolved.
	if reason := brandMismatchReason(env); reason != "" {
		findings = append(findings, specFinding{
			reason: reasonBrandMismatch, field: "resources.gpu.vendor", detail: reason, mustUpdate: true,
		})
	}
	if reason := unsupportedNotebookArgsReason(env); reason != "" {
		findings = append(findings, specFinding{
			reason: reasonNotebookArgsUnusable, field: "runtime.env[" + notebookArgsEnv + "]", detail: reason, mustUpdate: true,
		})
	}
	findings = append(findings, portCollisionFindings(env)...)
	if env.Spec.Runtime == nil {
		return findings
	}
	for _, v := range env.Spec.Runtime.Env {
		switch {
		case env.Spec.Type == aiv1alpha1.DevEnvironmentTypeJupyter && v.Name == jupyterTokenEnv:
			findings = append(findings, specFinding{
				field:  "runtime.env[" + jupyterTokenEnv + "]",
				detail: "the token is generated per environment rather than read from the spec: the controller publishes the one the workload reads in status.jupyterTokenSecret",
			})
		case rootLauncherEnvNeeded(env) && isRootLauncherEnvName(v.Name):
			findings = append(findings, specFinding{
				field: "runtime.env[" + v.Name + "]",
				detail: fmt.Sprintf("the environment runs as root, so the launcher account is root's own: the controller sets %s=%s, %s=%s, %s=%s (a launcher told to serve another account rewrites it, and cannot while the container is running as root)",
					nbUserEnv, rootRuntimeUser, nbUIDEnv, rootAccountUID, nbGIDEnv, rootAccountGID),
			})
		case v.Name == homeEnv:
			// A declared home is not outranked here: the claim is the workspace,
			// and the container is told where it is (::withWorkspaceHome). So a
			// value that differs from the resolved path is one the container does
			// not run with, whether the derivation could not use it at all — a
			// valueFrom source, a relative path, an unexpanded reference — or an
			// explicit storage.mountPath outranked it.
			if home, ok := resolvedHome(env); ok && v.Value != home {
				findings = append(findings, specFinding{
					field:  "runtime.env[" + homeEnv + "]",
					detail: fmt.Sprintf("the environment's workspace is mounted at %s, which is the home the controller states on the container, so a launcher that reads HOME serves the workspace from there either way", home),
				})
			}
		}
	}
	// Only a jupyter environment goes through withNotebookBaseURL at all, and only
	// its first NOTEBOOK_ARGS entry — the one that call rewrites, and the one it
	// adds when the spec declares none. A second entry is left as it is, and is
	// therefore not reported either.
	if env.Spec.Type == aiv1alpha1.DevEnvironmentTypeJupyter {
		for _, v := range env.Spec.Runtime.Env {
			if v.Name != notebookArgsEnv {
				continue
			}
			for arg := range strings.FieldsSeq(v.Value) {
				if isNotebookBaseURLArg(arg) {
					findings = append(findings, specFinding{
						field:  "runtime.env[" + notebookArgsEnv + "]",
						detail: fmt.Sprintf("%s is replaced by %s%s: the route publishes the notebook under that prefix, so Jupyter has to serve it (every other flag is kept)", arg, notebookBaseURLFlag, webPath(env)),
					})
				}
			}
			break
		}
	}
	// Derived from runtimeUser rather than re-reading the security context, so the
	// account the platform advertises and the account this reports as ignored are
	// decided in one place.
	if env.Spec.Runtime.User != "" && runtimeUser(env) != env.Spec.Runtime.User {
		findings = append(findings, specFinding{
			field:  "runtime.user",
			detail: fmt.Sprintf("the environment runs as root, and root is the account the controller serves and publishes; a non-root spec.runtime.securityContext.runAsUser serves %s instead", env.Spec.Runtime.User),
		})
	}
	return findings
}

// mustUpdateFindings returns the findings only the user can clear. They are what
// makes an environment Failed (::Reconcile); the rest are reported on a passing
// Accepted condition.
func mustUpdateFindings(findings []specFinding) []specFinding {
	var blocking []specFinding
	for _, f := range findings {
		if f.mustUpdate {
			blocking = append(blocking, f)
		}
	}
	return blocking
}

// findingsMessage renders findings as the Accepted condition's message, one
// clause per finding, each naming the field it is about and what became of it.
func findingsMessage(findings []specFinding) string {
	lines := make([]string, 0, len(findings))
	for _, f := range findings {
		disposition := "ignored"
		if f.mustUpdate {
			disposition = "must be updated"
		}
		lines = append(lines, fmt.Sprintf("spec.%s: %s — %s", f.field, disposition, f.detail))
	}
	return strings.Join(lines, "; ")
}

// desiredStatefulSet renders the environment StatefulSet: replicas 1/0 from
// spec.running, the workspace volumeClaimTemplate, and PVC retention. Replicas
// are zero for the idle auto-stop as well, which overrides the spec without
// changing it (::autoStoppedAnnotationKey): both are read on every pass, so the
// pass that writes the mark still renders 1 and the pass after it renders 0.
// The workspace PVC's lifecycle belongs to the StatefulSet: it creates the claim
// from the template and, per whenDeleted, removes it when the StatefulSet is
// deleted — so the controller neither creates nor deletes workspace claims.
func (r *DevEnvironmentReconciler) desiredStatefulSet(env *aiv1alpha1.DevEnvironment) *appsv1.StatefulSet {
	replicas := int32(0)
	if env.Spec.Running && !autoStopped(env) {
		replicas = 1
	}
	// spec.storage.pvcRetention is carried by the StatefulSet rather than acted
	// on by the controller: whenDeleted is the field that expresses it, and the
	// StatefulSet controller removes the claim it created. Stopping must never
	// discard the workspace, so whenScaled stays Retain regardless.
	return &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: env.Name, Namespace: env.Namespace, Labels: r.envLabels(env.Name)},
		Spec: appsv1.StatefulSetSpec{
			ServiceName: env.Name,
			Replicas:    &replicas,
			Selector:    &metav1.LabelSelector{MatchLabels: map[string]string{devEnvironmentLabelKey: env.Name}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: r.envLabels(env.Name), Annotations: podTemplateAnnotations(env)},
				Spec:       r.desiredPodSpec(env),
			},
			VolumeClaimTemplates: r.desiredVolumeClaimTemplates(env),
			PersistentVolumeClaimRetentionPolicy: &appsv1.StatefulSetPersistentVolumeClaimRetentionPolicy{
				WhenDeleted: desiredWhenDeleted(env),
				WhenScaled:  appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
			},
		},
	}
}

// desiredWhenDeleted is the StatefulSet claim-deletion policy that carries
// spec.storage.pvcRetention. The fallback mirrors the schema default (delete), so
// an object that reached the controller without the field defaulted behaves as
// the API server would have made it. Rendering reads it, and so does cleanup,
// which has to know the environment's policy even before it has been reconciled
// onto the StatefulSet.
func desiredWhenDeleted(env *aiv1alpha1.DevEnvironment) appsv1.PersistentVolumeClaimRetentionPolicyType {
	if env.Spec.Storage != nil && env.Spec.Storage.PVCRetention == aiv1alpha1.PVCRetentionRetain {
		return appsv1.RetainPersistentVolumeClaimRetentionPolicyType
	}
	return appsv1.DeletePersistentVolumeClaimRetentionPolicyType
}

// activityAgentEnabled reports whether this environment carries the idle-timeout
// sidecar. It is the whole of the condition: the annotation the agent writes is
// read only to stop an environment that asked to be stopped, so an environment
// that never asked must not be given an agent to write one — and, because
// spec.lifecycle defaults to absent and idleTimeout to 0, that is every
// environment that existed before this feature did, which is what keeps them
// from rolling when it lands.
func activityAgentEnabled(env *aiv1alpha1.DevEnvironment) bool {
	return env.Spec.Lifecycle != nil && env.Spec.Lifecycle.IdleTimeout > 0
}

// activityAgentServiceAccountName is the account an environment that carries the
// sidecar runs under, and names the Role and RoleBinding that go with it. It is
// the name of an object that exists only while the environment asks for one, so
// the pod template and stsSpecHash ask ::activityAgentEnabled before using it:
// an environment that carries no sidecar must name no account, or it would
// reference one that is never created and never schedule.
func activityAgentServiceAccountName(env *aiv1alpha1.DevEnvironment) string {
	return env.Name + activityAgentNameSuffix
}

// desiredPodSpec renders the pod spec: compute-pool nodeSelector, the main
// container with the workspace and data volume mounts, the SSH keys volume, and —
// when the environment has its own storage — the init container that makes that
// storage writable (::desiredPermissionInitContainer). An environment that asks
// for an idle timeout carries the activity agent as a second container
// (::desiredActivityAgent).
func (r *DevEnvironmentReconciler) desiredPodSpec(env *aiv1alpha1.DevEnvironment) corev1.PodSpec {
	mainPort := mainContainerPort(env.Spec.Type)
	rdma, hostNetwork := r.rdmaResource(env)
	securityContext := desiredSecurityContext(env.Spec.Runtime)
	if rdma != "" {
		securityContext = withRDMACapabilities(securityContext)
	}
	container := corev1.Container{
		Name:            string(env.Spec.Type),
		Image:           env.Spec.Image,
		Resources:       desiredResources(env, rdma),
		SecurityContext: securityContext,
		ReadinessProbe: &corev1.Probe{
			ProbeHandler: corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromInt32(mainPort)}},
		},
	}
	var envVars []corev1.EnvVar
	if env.Spec.Runtime != nil {
		container.Command = env.Spec.Runtime.Command
		container.Args = env.Spec.Runtime.Args
		// Copy the user env list: the token injection below must not alias (and
		// thereby mutate) the env list stored on the cached spec.
		envVars = append(envVars, env.Spec.Runtime.Env...)
	}
	if env.Spec.Type == aiv1alpha1.DevEnvironmentTypeJupyter {
		// JUPYTER_TOKEN is controller-managed: the random token lives in the
		// <env>-jupyter-token Secret surfaced to the owner, so a user-supplied entry is
		// dropped and the injected secretKeyRef always wins (a user override
		// would bypass the token the owner is told about).
		envVars = slices.DeleteFunc(envVars, func(v corev1.EnvVar) bool { return v.Name == jupyterTokenEnv })
		envVars = append(envVars, corev1.EnvVar{
			Name: jupyterTokenEnv,
			ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: jupyterTokenSecretName(env)},
					Key:                  jupyterTokenKey,
				},
			},
		})
		// Jupyter has to serve under the prefix its route publishes, and the
		// launcher only learns the prefix from NOTEBOOK_ARGS (design §6.4).
		envVars = withNotebookBaseURL(envVars, webPath(env))
		// A root environment needs the launcher's own settings too, and which
		// ones those are is the platform's to resolve rather than the spec's
		// (::withRootLauncherEnv).
		if rootLauncherEnvNeeded(env) {
			envVars = withRootLauncherEnv(envVars)
		}
	}
	// The claim the platform mounts is the environment's home, so the container is
	// told where it is: a launcher that reads HOME serves the workspace whatever
	// its image bakes (::resolvedHome). It applies to every type — a claim's path
	// is no jupyter notion — while an environment with no claim is told nothing
	// and keeps what its env list leaves: the spec's own home, or the image's
	// where it declares none.
	if home, ok := resolvedHome(env); ok {
		envVars = withWorkspaceHome(envVars, home)
	}
	container.Env = envVars
	if env.Spec.Storage != nil {
		container.VolumeMounts = append(container.VolumeMounts, corev1.VolumeMount{
			Name: workspaceClaimName, MountPath: resolveMountPath(env),
		})
	}
	for _, v := range env.Spec.Volumes {
		mount := corev1.VolumeMount{Name: v.Name, MountPath: v.MountPath, ReadOnly: v.ReadOnly}
		if v.SubPath != "" {
			mount.SubPath = v.SubPath
		}
		container.VolumeMounts = append(container.VolumeMounts, mount)
	}
	if sshExposed(env) {
		// The images read the ssh material in place — no staging, no copy, no
		// chmod (images/README.md). The host key is one file at a path sshd fixes,
		// so it is mounted as a file with subPath. The authorized keys are a
		// whole-Secret mount of their directory instead: items renames the selected
		// entry to the filename the images' AuthorizedKeysFile names, which keeps
		// that path and — unlike a subPath file — lets kubelet update the file in
		// place when the Secret changes, so rotating a key needs no pod restart.
		// Only the mapped entry is materialised, so the generated login private key
		// — which shares its Secret with the authorized_keys entry it signs for —
		// never enters the container. The mode both volumes carry is the reading
		// uid's to decide rather than the file's, which is why it is set below
		// beside the volumes instead of here.
		container.VolumeMounts = append(container.VolumeMounts,
			corev1.VolumeMount{
				Name: sshHostKeyVolumeName, MountPath: sshHostKeyPath, SubPath: sshHostKeyKey, ReadOnly: true,
			},
			corev1.VolumeMount{
				Name: sshAuthorizedKeysVolumeName, MountPath: sshAuthorizedKeysDir, ReadOnly: true,
			},
		)
	}

	if hostNetwork {
		// A host-network environment binds whatever it listens on on the node
		// itself, where the scheduler counts the container's declared ports as
		// host ports (::desiredContainerPorts).
		container.Ports = desiredContainerPorts(env)
	}

	podSpec := corev1.PodSpec{
		Containers: []corev1.Container{container},
		// Pod-level, so the profile reaches the init container below too. An unset
		// profile is Unconfined, which the Restricted Pod Security Standard refuses
		// outright: this is that level's seccomp requirement met, and no more —
		// a namespace enforcing Restricted refuses the pod anyway (README). The
		// vendor stacks tolerate it: a MACA kernel launch is unaffected.
		SecurityContext: &corev1.PodSecurityContext{
			SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		},
	}
	if hostNetwork {
		// RoCE GIDs are derived from the interfaces inside the network
		// namespace, so the environment runs in the node's rather than one of
		// its own (see rdmaResource). dnsPolicy moves with it: ClusterFirst
		// silently falls back to the node's own resolver for a host-network pod,
		// which stops cluster service names and search domains resolving, so the
		// environment would lose the Services it can otherwise reach. The
		// NetworkPolicy written for every environment is inert here
		// (::desiredNetworkPolicy).
		podSpec.HostNetwork = true
		podSpec.DNSPolicy = corev1.DNSClusterFirstWithHostNet
	}
	if env.Spec.Storage != nil {
		// The workspace claim is the platform's storage for this environment; a
		// referenced PVC is not, and is never mounted into the init container.
		podSpec.InitContainers = []corev1.Container{desiredPermissionInitContainer(env)}
	}
	for _, v := range env.Spec.Volumes {
		podSpec.Volumes = append(podSpec.Volumes, corev1.Volume{
			Name: v.Name,
			VolumeSource: corev1.VolumeSource{
				PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: v.PVCName, ReadOnly: v.ReadOnly},
			},
		})
	}
	if sshExposed(env) {
		// A Secret volume materialises its files root-owned, and OpenSSH's
		// private-key check fires only on a file owned by the uid reading it
		// (sshkey_perm_ok). The mode a reader tolerates therefore follows the
		// reader's identity rather than the file's sensitivity, and the two
		// identities the platform runs an environment under want opposite modes:
		//
		//   - A non-root sshd is not the owner, so it is never checked — and it
		//     cannot read a file it does not own, so 0600 leaves it exiting with
		//     "no hostkeys available". 0644 is what keeps the key readable.
		//   - A root sshd (runAsUser 0) *is* the owner, so the check applies and
		//     0644 is refused outright: "Permissions 0644 ... are too open". The
		//     images' entrypoint turns that into a failed start, so an environment
		//     that should be serving ssh does not come up at all.
		//
		// The authorized keys take the same mode: the same sshd reads them under
		// the same ownership, and 0600 is as readable to the root that owns them.
		mode := int32(0o644)
		if rt := env.Spec.Runtime; rt != nil && rt.SecurityContext != nil &&
			rt.SecurityContext.RunAsUser != nil && *rt.SecurityContext.RunAsUser == 0 {
			mode = 0o600
		}
		authorizedName, authorizedKey := sshAuthorizedKeysSource(env)
		podSpec.Volumes = append(podSpec.Volumes,
			corev1.Volume{
				Name: sshHostKeyVolumeName,
				VolumeSource: corev1.VolumeSource{
					Secret: &corev1.SecretVolumeSource{SecretName: sshHostKeySecretName(env), DefaultMode: &mode},
				},
			},
			corev1.Volume{
				Name: sshAuthorizedKeysVolumeName,
				VolumeSource: corev1.VolumeSource{
					Secret: &corev1.SecretVolumeSource{
						SecretName:  authorizedName,
						DefaultMode: &mode,
						// The selected data key is what the mount exposes under the
						// filename the images read. A key absent from the Secret
						// leaves the file out rather than failing the mount, which
						// sshd reads as "no keys" — reconcileSSHSecrets rejects that
						// configuration before the workload is ever created.
						Items: []corev1.KeyToPath{{Key: authorizedKey, Path: sshAuthorizedKeysFile}},
					},
				},
			},
		)
	}
	if activityAgentEnabled(env) {
		// Appended last, so Containers[0] stays the environment's own container:
		// the main port, the readiness probe and the init container all describe
		// it, and nothing about the sidecar may come to be read as the workload.
		podSpec.Containers = append(podSpec.Containers, r.desiredActivityAgent(env))
		// The agent reports on the environment's processes by reading /proc, and
		// the pod's PID namespace is the only thing that decides whether the
		// user's work is in there to read: without this, /proc inside a container
		// holds that container's processes alone and the agent would see nothing
		// but itself. The pod already shares one network namespace, which is what
		// makes /proc/net/tcp the environment's sockets.
		podSpec.ShareProcessNamespace = ptr(true)
		// The account is scoped to this one environment: it can read and annotate
		// exactly this pod and nothing else (::desiredActivityAgentRBAC).
		podSpec.ServiceAccountName = activityAgentServiceAccountName(env)
	}
	return podSpec
}

// desiredActivityAgent renders the idle-timeout sidecar: the container that
// watches the environment's own processes and sockets and records when it was
// last used, by annotating this pod.
//
// It reports and decides nothing. Whether a mark is old enough to stop the
// environment is the controller's to read and act on, and this container cannot
// act on it even if it wanted to: its account can read and patch one pod and
// nothing else.
//
// The watched ports are given rather than discovered because the agent cannot
// guess them: they are the ports the environment's own services bind inside the
// pod, which is mainContainerPort plus sshContainerPort when ssh is exposed —
// sshContainerPort and not the port the Service publishes it on, since the
// published one is bound by a proxy outside the pod and never appears in the
// pod's own socket table. Ports an environment declares through spec.ports are
// deliberately not among them: those are the tenant's own services rather than
// the platform's, and making them part of the sidecar's arguments would make
// every edit to a user's exposure part of the pod template, rolling the workload
// — and losing a running session — to change what an agent watches.
//
// The container is also not allowed to fail. Kubernetes reports a pod's
// readiness and failure over every container it holds, so a sidecar in
// CrashLoopBackOff marks the whole environment Failed and stops the user's work;
// that is why it has no probes, why the agent exits 0 however it is ended, and
// why the resource limits below are hard ones rather than requests: an agent
// that is throttled skips a sample, and one that is evicted for asking for more
// memory than the node has takes the environment with it.
func (r *DevEnvironmentReconciler) desiredActivityAgent(env *aiv1alpha1.DevEnvironment) corev1.Container {
	ports := []int32{mainContainerPort(env.Spec.Type)}
	if sshExposed(env) && env.Spec.Type != aiv1alpha1.DevEnvironmentTypeSSH {
		ports = append(ports, sshContainerPort)
	}
	watched := make([]string, 0, len(ports))
	for _, port := range ports {
		watched = append(watched, strconv.Itoa(int(port)))
	}
	// The identity is the environment's own, not this image's: reading another
	// process's /proc/<pid>/io is a ptrace permission check, and a process may
	// only trace one of its own uid. A sidecar on a uid of its own would come up,
	// report CPU progress, and silently lose the IO dimension — the one that
	// catches work waiting on storage or on a GPU rather than on a core.
	securityContext := desiredSecurityContext(env.Spec.Runtime)
	securityContext.AllowPrivilegeEscalation = ptr(false)
	securityContext.ReadOnlyRootFilesystem = ptr(true)
	// Added rather than defaulted: the runtime's own default set is the image's
	// entrypoint to keep, and this container has no entrypoint but the binary.
	securityContext.Capabilities = &corev1.Capabilities{Drop: []corev1.Capability{allCapabilities}}
	return corev1.Container{
		Name:  activityAgentContainerName,
		Image: activityAgentImage,
		// Always, because the reference above is not guaranteed to be immutable:
		// a manager built without one names the agent's default `latest` tag, and
		// a cached layer under a mutable tag is a rebuilt agent that no node ever
		// picks up. Pulling every time costs a manifest request next to the image
		// layers the node already holds.
		ImagePullPolicy: corev1.PullAlways,
		Args:            []string{"--ports=" + strings.Join(watched, ",")},
		// The pod's own identity, so the agent needs no flag and no guess about
		// which pod it is in. Both come from the downward API rather than from
		// the controller, which would otherwise have to name a pod that does not
		// exist until this template creates it.
		Env: []corev1.EnvVar{
			{
				Name: "POD_NAME",
				ValueFrom: &corev1.EnvVarSource{
					FieldRef: &corev1.ObjectFieldSelector{FieldPath: podNameFieldPath},
				},
			},
			{
				Name: "POD_NAMESPACE",
				ValueFrom: &corev1.EnvVarSource{
					FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.namespace"},
				},
			},
		},
		Resources: corev1.ResourceRequirements{
			Requests: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("10m"),
				corev1.ResourceMemory: resource.MustParse("32Mi"),
			},
			Limits: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("50m"),
				corev1.ResourceMemory: resource.MustParse("64Mi"),
			},
		},
		SecurityContext: securityContext,
	}
}

// desiredVolumeClaimTemplates renders the workspace claim template, creating
// the PVC workspace-<env>-0 that survives stop/start. The claim always uses the
// platform-predefined workspaceStorageClassName and requests ReadWriteMany so
// the volume can be mounted on any node and follow the pod across node faults.
func (r *DevEnvironmentReconciler) desiredVolumeClaimTemplates(env *aiv1alpha1.DevEnvironment) []corev1.PersistentVolumeClaim {
	if env.Spec.Storage == nil {
		return nil
	}
	pvc := corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:   workspaceClaimName,
			Labels: r.envLabels(env.Name),
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany},
			StorageClassName: ptr(workspaceStorageClassName),
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse(env.Spec.Storage.Size)},
			},
		},
	}
	return []corev1.PersistentVolumeClaim{pvc}
}

// servicePortKey identifies a Service port the way the API server does: the
// number and the protocol together are what a Service may carry only once,
// however the entries are named.
func servicePortKey(port int32, protocol corev1.Protocol) string {
	return fmt.Sprintf("%d/%s", port, protocol)
}

// platformServicePorts is what an environment's Service publishes on the
// platform's own account, and so what a spec.ports entry can find already taken:
// the type's main port, and the number sshd is bridged from when one is exposed.
//
// It is a function of the spec and not of cluster state, which is what lets
// specFindings report on the collisions such an entry causes before anything is
// applied, and lets desiredService render from it rather than repeat it.
func platformServicePorts(env *aiv1alpha1.DevEnvironment) []corev1.ServicePort {
	mainPort := mainContainerPort(env.Spec.Type)
	// The ssh container listens on the unprivileged sshContainerPort but is
	// published on the conventional sshServicePort; every other type publishes
	// the port it listens on.
	mainServicePort := mainPort
	if env.Spec.Type == aiv1alpha1.DevEnvironmentTypeSSH {
		mainServicePort = sshServicePort
	}
	ports := []corev1.ServicePort{
		{Name: mainPortName, Port: mainServicePort, TargetPort: intstr.FromInt32(mainPort), Protocol: corev1.ProtocolTCP},
	}
	// The ssh entry is guarded by type, as the container port list guards its
	// own: for the ssh type the two entries are the same port, and the main one
	// is what names it.
	if sshExposed(env) && env.Spec.Type != aiv1alpha1.DevEnvironmentTypeSSH {
		ports = append(ports, corev1.ServicePort{
			Name: sshPortName, Port: sshServicePort, TargetPort: intstr.FromInt32(sshContainerPort), Protocol: corev1.ProtocolTCP,
		})
	}
	return ports
}

// portCollisionFindings reports every spec.ports entry the Service does not
// publish under the name it was declared with, because a (port, protocol) it
// names is already taken by an entry that precedes it (::desiredService).
//
// The two ways that can happen are separated rather than reported as one,
// because what they cost the user differs in kind. An entry folded into one that
// forwards to the same container port — every fold into a type's own main port,
// and every repeat of an earlier spec.ports entry — is served exactly as
// declared, so the environment runs and Accepted reports the fold. An entry
// folded into one that forwards somewhere else is not served at all: the ssh
// bridge is published at 22 and forwards to the sshd on 2222, so an exposure
// declaring container port 22 would have its route reach sshd rather than the
// workload it named, and no other port carries it. Only the user can choose
// another one.
func portCollisionFindings(env *aiv1alpha1.DevEnvironment) []specFinding {
	var findings []specFinding
	// The entries that precede each spec.ports entry, in the order desiredService
	// adds them: the platform's own first, then the spec's.
	taken := map[string]corev1.ServicePort{}
	for _, sp := range platformServicePorts(env) {
		taken[servicePortKey(sp.Port, sp.Protocol)] = sp
	}
	for i, p := range env.Spec.Ports {
		protocol := portProtocol(p)
		key := servicePortKey(p.ContainerPort, protocol)
		owner, collides := taken[key]
		if !collides {
			taken[key] = corev1.ServicePort{
				Name: p.Name, Port: p.ContainerPort, TargetPort: intstr.FromInt32(p.ContainerPort), Protocol: protocol,
			}
			continue
		}
		field := fmt.Sprintf("ports[%d]", i)
		if owner.TargetPort.IntVal == p.ContainerPort {
			findings = append(findings, specFinding{
				field: field,
				detail: fmt.Sprintf("the Service already publishes %d/%s as %q, which forwards to container port %d — the one this entry declares — so the exposure is served by that entry and the name %q goes unused",
					p.ContainerPort, protocol, owner.Name, owner.TargetPort.IntVal, p.Name),
			})
			continue
		}
		findings = append(findings, specFinding{
			reason:     reasonPortCollision,
			mustUpdate: true,
			field:      field,
			detail: fmt.Sprintf("the Service already publishes %d/%s as %q, which forwards to container port %d rather than the %d this entry declares, so the exposure's route would reach whatever listens on %d. Declare a container port the Service does not already publish",
				p.ContainerPort, protocol, owner.Name, owner.TargetPort.IntVal, p.ContainerPort, owner.TargetPort.IntVal),
		})
	}
	return findings
}

// desiredService renders the ClusterIP Service with the main port, the SSH
// port (when exposed and not the main port), and the extra application ports.
//
// Like the container port list it is rendered beside (::desiredContainerPorts),
// the list dedupes on port and protocol: spec.ports is free to repeat a port the
// platform already declared, and a Service carrying one (port, protocol) twice
// is refused by the API server outright. The platform's own entries are added
// first and are what a repeat is folded into, so the number the exposure asked
// for is still published and a route still reaches it — by number rather than by
// name (::serviceBackendRef). What that folding costs the exposure is not this
// function's to decide and is reported on Accepted (::portCollisionFindings).
func (r *DevEnvironmentReconciler) desiredService(env *aiv1alpha1.DevEnvironment) *corev1.Service {
	// The seen set is keyed by port and protocol, as desiredContainerPorts keys
	// its own: the same number under another protocol is a different Service
	// port and survives.
	var ports []corev1.ServicePort
	seen := map[string]bool{}
	add := func(sp corev1.ServicePort) {
		key := servicePortKey(sp.Port, sp.Protocol)
		if seen[key] {
			return
		}
		seen[key] = true
		ports = append(ports, sp)
	}
	for _, sp := range platformServicePorts(env) {
		add(sp)
	}
	for _, p := range env.Spec.Ports {
		// The Service port carries the protocol the exposure speaks: a UDPRoute
		// forwards to a UDP port, and the dataplane reaches the container over
		// that same one. A udp port that stayed TCP here would be accepted and
		// then forward nothing, since a TCP Service port does not listen for
		// datagrams.
		add(corev1.ServicePort{
			Name: p.Name, Port: p.ContainerPort, TargetPort: intstr.FromInt32(p.ContainerPort), Protocol: portProtocol(p),
		})
	}
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: env.Name, Namespace: env.Namespace, Labels: r.envLabels(env.Name)},
		Spec: corev1.ServiceSpec{
			Type:     corev1.ServiceTypeClusterIP,
			Selector: map[string]string{devEnvironmentLabelKey: env.Name},
			Ports:    ports,
		},
	}
}

// desiredNetworkPolicy enforces default-deny ingress — widened by exactly one
// rule when the platform Gateway's dataplane is configured — with DNS egress
// whitelisted (design §9.1). agentEgress is the activity agent's allowance,
// resolved by applyNetworkPolicy, and is empty for an environment that carries
// no agent.
func (r *DevEnvironmentReconciler) desiredNetworkPolicy(env *aiv1alpha1.DevEnvironment, agentEgress []networkingv1.NetworkPolicyEgressRule) *networkingv1.NetworkPolicy {
	tcp := corev1.ProtocolTCP
	udp := corev1.ProtocolUDP
	dnsPort := intstr.FromInt32(53)
	cfg := r.defaultedConfig()
	// Ingress is default-deny: an empty rule list admits nothing, and this is
	// the only place an environment's inbound allowance is widened. The
	// allowance below is the dataplane serving the environment's published
	// routes, which reaches the pod from another namespace and would otherwise
	// be refused.
	//
	// It carries no ports. An environment listens on its type's main port
	// (jupyter 8888, vscode 8080, ssh 2222) plus whatever spec.ports declares, so
	// naming any one of them would silently break the rest. The peer is already
	// narrowed to a single Gateway's proxy pods, and a policy can admit no more
	// ports than the container binds.
	//
	// None of this is enforced for an environment on the host network — a RoCE
	// one (spec.network.rdmaType) — because a CNI filters the pod's own network
	// namespace and a host-network pod has none. The policy is created anyway: it
	// is what an InfiniBand environment needs, it is harmless for a RoCE one, and
	// it takes effect again the moment the environment is reconciled without
	// RDMA. Filtering a host-network pod at all is a CNI host-firewall feature
	// (Cilium's enable-host-firewall, say), which this platform does not
	// configure. The chart README carries the gap for operators; the API does not
	// state it, because which environments are attached this way is not part of
	// spec.network.
	ingress := []networkingv1.NetworkPolicyIngressRule{}
	if ns := cfg.GatewayDataplaneNamespace; ns != "" {
		ingress = append(ingress, networkingv1.NetworkPolicyIngressRule{
			From: []networkingv1.NetworkPolicyPeer{{
				NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{
					namespaceNameLabel: ns,
				}},
				PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{
					gatewayDataplaneNameLabel:      cfg.GatewayName,
					gatewayDataplaneNamespaceLabel: cfg.GatewayNamespace,
				}},
			}},
		})
	}
	return &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: env.Name, Namespace: env.Namespace, Labels: r.envLabels(env.Name)},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{devEnvironmentLabelKey: env.Name}},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress, networkingv1.PolicyTypeEgress},
			Ingress:     ingress,
			Egress: append([]networkingv1.NetworkPolicyEgressRule{
				{
					// Port 53 with no peer, because the resolver's address is
					// the cluster's to choose and no object reports it: the
					// kubelet's --cluster-dns is what reaches a pod's
					// resolv.conf, and it names the DNS Service's ClusterIP on
					// one cluster, a node-local cache's address on the next
					// (Kubernetes' nodelocaldns answers on 169.254.25.10,
					// Cilium's on 169.254.20.10, and --localip moves it
					// anywhere), and nothing stops an operator from setting it
					// to something else again. A rule peering on the kube-dns
					// pods — which is what this one used to do — admits no
					// lookup at all wherever the pod dials a node-local cache
					// instead, and the environment then starts, serves, and
					// cannot resolve a single name.
					//
					// So the port is the scope here, not the destination. The
					// cost is small: this platform's other egress rules all
					// name a peer, and a tenant who could tunnel DNS out
					// through the cluster resolver could already tunnel it
					// through the kube-dns pods this rule would otherwise name.
					Ports: []networkingv1.NetworkPolicyPort{
						{Protocol: &udp, Port: &dnsPort},
						{Protocol: &tcp, Port: &dnsPort},
					},
				},
			}, agentEgress...),
		},
	}
}

// apiserverEgress is the egress rule that admits the activity agent's calls to
// the apiserver, and is empty for an environment that carries no agent.
//
// It is not optional. The policy above is default-deny egress with a single
// DNS allowance, and a NetworkPolicy admits traffic per pod rather than per
// container — so without this rule the sidecar's PATCH is dropped by any
// enforcing CNI, and the agent deploys, runs, looks healthy and never writes an
// annotation, with nothing anywhere reporting an error. The environment is then
// stopped out from under whoever is using it, which is the failure this whole
// feature exists to avoid.
//
// The allowance names the apiserver's addresses rather than widening to
// 0.0.0.0/0: there is no per-container selector to scope it to the sidecar, so
// a rule that opened 443 to the world would open it for the environment's own
// container too, turning every default-deny namespace into an egress-open one
// for its tenant.
//
// It is two addresses because CNIs disagree about whether policy sees an egress
// packet before or after the service translation that rewrites a ClusterIP to a
// backend. Filtering before the rewrite — what this rule was first written for
// — shows the Service's ClusterIP on the Service's own port, which is what the
// pod's KUBERNETES_SERVICE_HOST and its client library dial. Filtering after
// it, as Calico does, shows the endpoint on the endpoint's target port instead,
// and a rule naming only the ClusterIP then admits nothing: every write the
// agent makes fails, with an i/o timeout, and the feature is dead on that
// cluster while looking configured. Naming both is what makes the allowance
// hold on either, and both are the apiserver, so the environment's own
// container gains no route it would not have had.
//
// Every conformant cluster keeps that Service at default/kubernetes; there is
// no API that reports where it is, so the convention is what this reads. A
// failure to read it fails the reconcile rather than being skipped: the object
// is either there or the cluster is not one this platform can run on, and
// carrying on regardless would leave the one failure this rule exists to
// prevent, silently.
func (r *DevEnvironmentReconciler) apiserverEgress(ctx context.Context, env *aiv1alpha1.DevEnvironment) ([]networkingv1.NetworkPolicyEgressRule, error) {
	if !activityAgentEnabled(env) {
		return nil, nil
	}
	svc := &corev1.Service{}
	if err := r.Get(ctx, client.ObjectKey{Name: kubernetesServiceName, Namespace: metav1.NamespaceDefault}, svc); err != nil {
		return nil, fmt.Errorf("reading the apiserver endpoint for the activity agent: %w", err)
	}
	// spec.clusterIPs is the dual-stack form and always carries the primary
	// address first; spec.clusterIP is what a server older than 1.20 writes and
	// is the whole of the address on a single-stack cluster either way. A
	// headless Service — "None" — has no address to admit and matches this
	// platform's apiserver nowhere.
	addresses := svc.Spec.ClusterIPs
	if len(addresses) == 0 {
		addresses = []string{svc.Spec.ClusterIP}
	}
	var peers []networkingv1.NetworkPolicyPeer
	for _, address := range addresses {
		// The prefix length is the address's own, so a v4 ClusterIP is admitted
		// as /32 and a v6 one as /128: an IPBlock names a CIDR and would
		// otherwise round a single address out to the range that contains it.
		ip, err := netip.ParseAddr(address)
		if err != nil {
			continue
		}
		peers = append(peers, networkingv1.NetworkPolicyPeer{
			IPBlock: &networkingv1.IPBlock{CIDR: netip.PrefixFrom(ip, ip.BitLen()).String()},
		})
	}
	if len(peers) == 0 {
		return nil, fmt.Errorf("the kubernetes Service at %s/%s publishes no address", metav1.NamespaceDefault, kubernetesServiceName)
	}
	// The port is the Service's, not the literal 443: the agent dials
	// KUBERNETES_SERVICE_PORT, which is exactly what this Service publishes, and
	// a rule naming a different port would admit nothing while looking correct.
	var ports []networkingv1.NetworkPolicyPort
	for i := range svc.Spec.Ports {
		tcp := corev1.ProtocolTCP
		port := intstr.FromInt32(svc.Spec.Ports[i].Port)
		ports = append(ports, networkingv1.NetworkPolicyPort{Protocol: &tcp, Port: &port})
	}
	// The endpoints, for the CNIs that filter after the service rewrite (see the
	// doc comment): the apiserver's real address is there, on the endpoint's
	// target port rather than the Service's, because the apiserver publishes the
	// kubernetes service's endpoints itself. A cluster that turns that
	// reconciler off (--endpoint-reconciler-type=none) never gets one, so a
	// missing object leaves the ClusterIP allowance above as the whole rule
	// rather than failing the reconcile.
	//nolint:staticcheck // Endpoints is deprecated in v1.33+ but still served; it is what the post-DNAT address is read from (design §3.3).
	endpoints := &corev1.Endpoints{}
	if err := r.Get(ctx, client.ObjectKey{Name: kubernetesServiceName, Namespace: metav1.NamespaceDefault}, endpoints); err != nil && !apierrors.IsNotFound(err) {
		return nil, fmt.Errorf("reading the apiserver's endpoints for the activity agent: %w", err)
	}
	for _, subset := range endpoints.Subsets {
		// Ready addresses only: a NotReady apiserver is one the agent cannot
		// use, and admitting it would only turn the timeout into a refusal.
		for _, address := range subset.Addresses {
			ip, err := netip.ParseAddr(address.IP)
			if err != nil {
				continue
			}
			peers = append(peers, networkingv1.NetworkPolicyPeer{
				IPBlock: &networkingv1.IPBlock{CIDR: netip.PrefixFrom(ip, ip.BitLen()).String()},
			})
		}
		for _, endpointPort := range subset.Ports {
			protocol := endpointPort.Protocol
			if protocol == "" {
				protocol = corev1.ProtocolTCP
			}
			port := intstr.FromInt32(endpointPort.Port)
			ports = append(ports, networkingv1.NetworkPolicyPort{Protocol: &protocol, Port: &port})
		}
	}
	// An Endpoints object is a set: neither its subsets, their addresses nor
	// their ports have a guaranteed order, so the same cluster can list the same
	// endpoints differently between one reconcile and the next. What this rule
	// renders is compared against the live NetworkPolicy to decide whether to
	// write (::applyNetworkPolicy), and that policy is owned by this environment,
	// so an order-only difference would buy a pointless update and the reconcile
	// its own write enqueues. Sorting both lists leaves the render a function of
	// what the apiserver publishes, not of the order it published it in.
	slices.SortFunc(peers, func(a, b networkingv1.NetworkPolicyPeer) int {
		return cmp.Compare(a.IPBlock.CIDR, b.IPBlock.CIDR)
	})
	slices.SortFunc(ports, func(a, b networkingv1.NetworkPolicyPort) int {
		if c := cmp.Compare(*a.Protocol, *b.Protocol); c != 0 {
			return c
		}
		return cmp.Compare(a.Port.IntVal, b.Port.IntVal)
	})
	return []networkingv1.NetworkPolicyEgressRule{{To: peers, Ports: ports}}, nil
}

// applyService creates or updates the Service. The server assigns ClusterIP,
// so only the ports and selector are compared.
func (r *DevEnvironmentReconciler) applyService(ctx context.Context, env *aiv1alpha1.DevEnvironment) error {
	svc := r.desiredService(env)
	if err := ctrl.SetControllerReference(env, svc, r.Scheme); err != nil {
		return err
	}
	existing := &corev1.Service{}
	err := r.Get(ctx, client.ObjectKey{Name: svc.Name, Namespace: svc.Namespace}, existing)
	if apierrors.IsNotFound(err) {
		return r.Create(ctx, svc)
	}
	if err != nil {
		return err
	}
	if err := ensureDevEnvOwned(existing, env); err != nil {
		return err
	}
	if apiequality.Semantic.DeepEqual(existing.Spec.Selector, svc.Spec.Selector) &&
		apiequality.Semantic.DeepEqual(existing.Spec.Ports, svc.Spec.Ports) {
		return nil
	}
	svc.ResourceVersion = existing.ResourceVersion
	return r.Update(ctx, svc)
}

// applyNetworkPolicy creates or updates the NetworkPolicy.
func (r *DevEnvironmentReconciler) applyNetworkPolicy(ctx context.Context, env *aiv1alpha1.DevEnvironment) error {
	agentEgress, err := r.apiserverEgress(ctx, env)
	if err != nil {
		return err
	}
	np := r.desiredNetworkPolicy(env, agentEgress)
	if err := ctrl.SetControllerReference(env, np, r.Scheme); err != nil {
		return err
	}
	existing := &networkingv1.NetworkPolicy{}
	err = r.Get(ctx, client.ObjectKey{Name: np.Name, Namespace: np.Namespace}, existing)
	if apierrors.IsNotFound(err) {
		return r.Create(ctx, np)
	}
	if err != nil {
		return err
	}
	if err := ensureDevEnvOwned(existing, env); err != nil {
		return err
	}
	if apiequality.Semantic.DeepEqual(existing.Spec, np.Spec) {
		return nil
	}
	np.ResourceVersion = existing.ResourceVersion
	return r.Update(ctx, np)
}

// reconcileActivityAgentRBAC ensures the ServiceAccount, Role and RoleBinding
// that authorize an environment's activity agent, and removes them once the
// environment stops asking for one — the grant is worth having only while the
// sidecar exists to use it, and an account that can still annotate a pod after
// the feature is off is one nobody is watching.
func (r *DevEnvironmentReconciler) reconcileActivityAgentRBAC(ctx context.Context, env *aiv1alpha1.DevEnvironment) error {
	enabled := activityAgentEnabled(env)
	for _, obj := range r.desiredActivityAgentRBAC(env) {
		if !enabled {
			if err := r.removeOwnedObject(ctx, env, obj); err != nil {
				return err
			}
			continue
		}
		if err := ctrl.SetControllerReference(env, obj, r.Scheme); err != nil {
			return err
		}
		// Decoded into an empty object of the desired kind, not into a copy of the
		// desired object: a field the server omits — an emptied RoleBinding's
		// subjects serialize as absent — would survive a decode into a populated
		// one and read as "already correct".
		existing := activityAgentRBACBlank(obj)
		err := r.Get(ctx, client.ObjectKeyFromObject(obj), existing)
		if apierrors.IsNotFound(err) {
			if err := r.Create(ctx, obj); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		if err := ensureDevEnvOwned(existing, env); err != nil {
			return err
		}
		if !activityAgentRBACDrifted(existing, obj) {
			continue
		}
		obj.SetResourceVersion(existing.GetResourceVersion())
		if err := r.Update(ctx, obj); err != nil {
			return err
		}
	}
	return nil
}

// desiredActivityAgentRBAC renders the three objects that let an environment's
// activity agent record that the environment is in use: a ServiceAccount of its
// own, a Role that may read and patch exactly that one pod, and the binding
// between them.
//
// Per environment rather than one platform-wide account, and scoped by
// resourceNames rather than by namespace, because the sidecar runs inside the
// tenant's own pod with the tenant's own images beside it: a shared account
// would let any environment's agent annotate any other environment's pod, and a
// namespace-wide one would let a container that can read its own projected token
// relabel every environment in the namespace — including the
// ai.cubestack.io/dev-environment label the controller finds them by.
//
// get is needed as well as patch: the agent reads the mark it is about to
// overwrite, so that a restart does not move an idle environment's activity
// clock backwards (see the agent's Recorder). update and delete are not granted
// — an annotation is all this ever writes, and a merge patch on the pod's
// annotations expresses that without being able to replace the object.
func (r *DevEnvironmentReconciler) desiredActivityAgentRBAC(env *aiv1alpha1.DevEnvironment) []client.Object {
	name := activityAgentServiceAccountName(env)
	labels := r.envLabels(env.Name)
	objectMeta := metav1.ObjectMeta{Name: name, Namespace: env.Namespace, Labels: labels}
	return []client.Object{
		&corev1.ServiceAccount{ObjectMeta: objectMeta},
		&rbacv1.Role{
			ObjectMeta: objectMeta,
			Rules: []rbacv1.PolicyRule{{
				APIGroups:     []string{""},
				Resources:     []string{"pods"},
				ResourceNames: []string{podName(env)},
				Verbs:         []string{"get", "patch"},
			}},
		},
		&rbacv1.RoleBinding{
			ObjectMeta: objectMeta,
			RoleRef: rbacv1.RoleRef{
				APIGroup: rbacv1.GroupName,
				Kind:     "Role",
				Name:     name,
			},
			Subjects: []rbacv1.Subject{{
				Kind:      rbacv1.ServiceAccountKind,
				Name:      name,
				Namespace: env.Namespace,
			}},
		},
	}
}

// activityAgentRBACBlank is an empty object of the same kind as obj, which a
// lookup decodes into.
func activityAgentRBACBlank(obj client.Object) client.Object {
	switch obj.(type) {
	case *corev1.ServiceAccount:
		return &corev1.ServiceAccount{}
	case *rbacv1.Role:
		return &rbacv1.Role{}
	default:
		return &rbacv1.RoleBinding{}
	}
}

// activityAgentRBACDrifted reports whether an existing authorization object says
// something different from the desired one, over the fields this controller
// owns. A ServiceAccount carries none of them — the server fills in its secrets
// and a user may add labels to any of the three — so a field the controller did
// not write is never drift.
func activityAgentRBACDrifted(existing, desired client.Object) bool {
	switch want := desired.(type) {
	case *rbacv1.Role:
		return !apiequality.Semantic.DeepEqual(existing.(*rbacv1.Role).Rules, want.Rules)
	case *rbacv1.RoleBinding:
		got := existing.(*rbacv1.RoleBinding)
		return !apiequality.Semantic.DeepEqual(got.RoleRef, want.RoleRef) ||
			!apiequality.Semantic.DeepEqual(got.Subjects, want.Subjects)
	default:
		return false
	}
}

// removeOwnedObject deletes an object this environment controls, and does nothing
// when it is already gone. A same-name object owned by someone else is reported
// as a conflict rather than deleted, like every other managed object here.
func (r *DevEnvironmentReconciler) removeOwnedObject(ctx context.Context, env *aiv1alpha1.DevEnvironment, obj client.Object) error {
	err := r.Get(ctx, client.ObjectKeyFromObject(obj), obj)
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := ensureDevEnvOwned(obj, env); err != nil {
		return err
	}
	return r.Delete(ctx, obj)
}

// applyStatefulSet creates or updates the StatefulSet. The pod template is
// compared by the stsSpecHash annotation rather than DeepEqual because the
// API server defaults many template fields; an update is only needed when the
// desired template or the replicas change.
func (r *DevEnvironmentReconciler) applyStatefulSet(ctx context.Context, env *aiv1alpha1.DevEnvironment) error {
	sts := r.desiredStatefulSet(env)
	sts.Annotations = map[string]string{stsSpecHashAnnotationKey: r.stsSpecHash(env)}
	if err := ctrl.SetControllerReference(env, sts, r.Scheme); err != nil {
		return err
	}
	existing := &appsv1.StatefulSet{}
	err := r.Get(ctx, client.ObjectKey{Name: sts.Name, Namespace: sts.Namespace}, existing)
	if apierrors.IsNotFound(err) {
		return r.Create(ctx, sts)
	}
	if err != nil {
		return err
	}
	if err := ensureDevEnvOwned(existing, env); err != nil {
		return err
	}
	// The retention policy is a mutable field the controller owns now, but it is
	// derived from spec.storage, which stsSpecHash already covers — so a
	// StatefulSet stored by a controller that hardcoded Retain hashes identically
	// and would otherwise never be corrected. Compare it explicitly.
	sameRetention := existing.Spec.PersistentVolumeClaimRetentionPolicy != nil &&
		existing.Spec.PersistentVolumeClaimRetentionPolicy.WhenDeleted == sts.Spec.PersistentVolumeClaimRetentionPolicy.WhenDeleted &&
		existing.Spec.PersistentVolumeClaimRetentionPolicy.WhenScaled == sts.Spec.PersistentVolumeClaimRetentionPolicy.WhenScaled
	if existing.Annotations[stsSpecHashAnnotationKey] == sts.Annotations[stsSpecHashAnnotationKey] &&
		existing.Spec.Replicas != nil && *existing.Spec.Replicas == *sts.Spec.Replicas && sameRetention {
		return nil
	}
	// spec.volumeClaimTemplates is immutable once the StatefulSet exists, so an
	// update must keep the templates already stored on the object. A StatefulSet
	// that predates the pinned cephfs-ephemeral/ReadWriteMany workspace claim
	// keeps its originally-provisioned claim and stays updatable instead of
	// wedging on an immutability error on the first drift; only newly created
	// environments get the platform-fixed claim template.
	sts.Spec.VolumeClaimTemplates = existing.Spec.VolumeClaimTemplates
	sts.ResourceVersion = existing.ResourceVersion
	return r.Update(ctx, sts)
}

// stsSpecHash hashes the pod-template-affecting fields so applyStatefulSet can
// detect template changes without comparing server-defaulted fields. It mirrors
// the pod template exactly: in particular it includes the secret revisions the
// template carries (see podTemplateAnnotations), so creating or refilling a
// managed Secret changes the hash and applyStatefulSet issues an update that
// rolls the workload.
//
// It is a method because the template depends on the controller's configuration
// as well as on the spec: the RDMA resource name is an operator flag, so a
// changed flag has to reach already-created workloads exactly as a changed spec
// does. Left out, the resource name would be the one input the hash cannot see,
// and an environment would keep claiming the name it was created with after the
// flag moved.
func (r *DevEnvironmentReconciler) stsSpecHash(env *aiv1alpha1.DevEnvironment) string {
	// rdmaTemplate is the RDMA contribution, and is nil unless the environment
	// asks for RDMA. It is a pointer, and its own fields carry omitempty, so the
	// key is absent from the JSON entirely for everyone else: an environment
	// that never enabled RDMA — and the defaulted shape the API server writes
	// for one, rdmaEnabled=false with rdmaType=roce — digests exactly as it did
	// before this field existed. Hashing spec.network itself would instead
	// change the digest for every environment in the cluster and roll every
	// workload once on upgrade, for a feature most of them do not use.
	type rdmaTemplate struct {
		HostNetwork bool   `json:"hostNetwork,omitempty"`
		Resource    string `json:"resource,omitempty"`
		// Ports are the host ports the pod template declares, which a
		// host-network environment has only because it takes them from the node.
		// They are derived from spec.ports, so a hash that covered RDMA but not
		// them would keep the declarations the template was built with: editing
		// spec.ports republishes the Service and the routes without ever rolling
		// the pod behind them, leaving a port published everywhere and bound
		// nowhere. An InfiniBand environment declares none (::desiredPodSpec),
		// so it contributes nothing here either.
		Ports []corev1.ContainerPort `json:"ports,omitempty"`
	}
	type templateInput struct {
		Type       aiv1alpha1.DevEnvironmentType
		Image      string
		Resources  aiv1alpha1.ResourcesSpec
		Runtime    *aiv1alpha1.RuntimeSpec
		Storage    *aiv1alpha1.StorageSpec
		Volumes    []aiv1alpha1.VolumeMount
		SSHExposed bool
		// JupyterTokenRevision is the digest carried on the pod template for a
		// jupyter environment ("" otherwise): introducing the JUPYTER_TOKEN env
		// var plus its revision rolls existing StatefulSets once on upgrade, and
		// a later token refill rolls them again. The plaintext never enters the
		// hash input, only its non-sensitive digest.
		JupyterTokenRevision string
		// SSHKeysRevision is the equivalent digest for the host identity, which the
		// pod mounts as a subPath file and so never sees updated in place. The
		// authorized keys need no revision: their volume is an ordinary Secret
		// mount, which kubelet keeps in sync without a roll.
		SSHKeysRevision string
		// SSHMount is the rest of how the pod gets its ssh material — the version
		// of the mount shape plus the Secret and data key the authorized keys come
		// from (::sshMountKey). The hash is assembled by hand and does not see the
		// ssh volumes, so without this a re-pointed spec.ssh.keysSecret whose
		// content is byte-identical to the previous source — the case an environment
		// reconciled by the bundled-Secret controller is in — or a change to the
		// mount shape itself would digest the same, and applyStatefulSet would skip
		// the update, leaving the workload on a template the controller no longer
		// means. The host key's source needs no equivalent: its Secret name is
		// derived from env.Name, so it cannot vary without a new object.
		SSHMount string
		// PodSecurityContext is the version of the pod-level security context's
		// shape (::podSecurityContextVersion), which carries the seccomp profile.
		// Like SSHMount it is here because the hash is assembled by hand and the
		// field it stands for is a constant: the profile is not derived from the
		// spec, so nothing else in this input would move when it was added.
		PodSecurityContext string
		// RootLauncherEnv is the version of the launcher environment the controller
		// injects into a root Jupyter environment (::rootLauncherEnvVersion), and is
		// empty for every environment that cannot receive it. Like
		// PodSecurityContext it stands for something the input cannot see: the
		// injected values are constants, so nothing else in this input moves when the
		// injection is added. The empty string is omitted rather than hashed (as rdma
		// is), so the environments that cannot receive the injection digest exactly as
		// they did before it existed and are not rewritten on upgrade.
		RootLauncherEnv string `json:"rootLauncherEnv,omitempty"`
		// WorkspaceHome is the version of the home the controller states on a
		// container that has a workspace claim (::workspaceHomeVersion), and is empty
		// for every environment that states none. Like RootLauncherEnv it stands for
		// something this input cannot see: the injected value is the mount path, which
		// Storage and Runtime already carry, so nothing else here moves when the
		// injection is added. The empty string is omitted rather than hashed, so the
		// environments that state no home digest exactly as they did before it
		// existed.
		WorkspaceHome string `json:"workspaceHome,omitempty"`
		// RDMA is the *resolved* RDMA request (::rdmaResource) — the resource the
		// container claims and whether the pod runs on the host network — rather
		// than spec.network as declared. Both follow from the spec and from the
		// resource-name flags together, so hashing them resolved is what lets the
		// flags above reach an existing workload.
		RDMA *rdmaTemplate `json:"rdma,omitempty"`
		// ShareProcessNamespace is pod-spec state nothing else in this input
		// implies: it is what puts the environment's processes where the sidecar
		// can read them, and a pod that kept it after the sidecar left — or lost
		// it while the sidecar stayed — would be a template this input called
		// unchanged.
		ShareProcessNamespace bool `json:"shareProcessNamespace,omitempty"`
		// ActivityAgent is ::activityAgentVersion, and is empty for every
		// environment that carries no sidecar. Like PodSecurityContext it stands
		// for something this input cannot see: the container is a constant plus the
		// ports it watches, which follow from Type and SSHExposed, both of which
		// are already here — so what is left to hash is the sentinel a change to
		// the sidecar bumps. The empty string is omitted rather than hashed, so the
		// environments that predate the agent digest exactly as they did before it
		// existed and are not rolled on upgrade.
		ActivityAgent string `json:"activityAgent,omitempty"`
		// ServiceAccount is the account the pod template names, and is empty for
		// every environment that runs under the namespace's default. It is the one
		// pod-spec field here that is neither the spec nor a constant, so nothing
		// else in this input would move if it were re-pointed.
		ServiceAccount string `json:"serviceAccount,omitempty"`
	}
	var rdma *rdmaTemplate
	if name, hostNetwork := r.rdmaResource(env); name != "" {
		rdma = &rdmaTemplate{HostNetwork: hostNetwork, Resource: string(name)}
		if hostNetwork {
			rdma.Ports = desiredContainerPorts(env)
		}
	}
	// Empty unless the environment is one the injection applies to, so the
	// environments that cannot receive it — every non-root one, and every one that
	// serves no notebook — digest exactly as they did before it existed.
	rootLauncherEnv := ""
	if rootLauncherEnvNeeded(env) {
		rootLauncherEnv = rootLauncherEnvVersion
	}
	// Empty unless the environment states a home, so the environments that state
	// none — every one without a workspace claim — digest exactly as they did before
	// the injection existed.
	workspaceHome := ""
	if _, ok := resolvedHome(env); ok {
		workspaceHome = workspaceHomeVersion
	}
	// Both empty unless the environment asks for an idle timeout, so the
	// environments that ask for none — every one that predates the sidecar —
	// digest exactly as they did before it existed.
	activityAgent := ""
	serviceAccount := ""
	if activityAgentEnabled(env) {
		activityAgent = activityAgentVersion
		serviceAccount = activityAgentServiceAccountName(env)
	}
	h := sha256.New()
	h.Write(mustJSON(templateInput{
		Type:                  env.Spec.Type,
		Image:                 env.Spec.Image,
		Resources:             env.Spec.Resources,
		Runtime:               env.Spec.Runtime,
		Storage:               env.Spec.Storage,
		Volumes:               env.Spec.Volumes,
		SSHExposed:            sshExposed(env),
		JupyterTokenRevision:  env.Annotations[jupyterTokenRevisionAnnotationKey],
		SSHKeysRevision:       env.Annotations[sshKeysRevisionAnnotationKey],
		SSHMount:              sshMountKey(env),
		PodSecurityContext:    podSecurityContextVersion,
		RootLauncherEnv:       rootLauncherEnv,
		WorkspaceHome:         workspaceHome,
		RDMA:                  rdma,
		ShareProcessNamespace: activityAgentEnabled(env),
		ActivityAgent:         activityAgent,
		ServiceAccount:        serviceAccount,
	}))
	return fmt.Sprintf("sha256:%x", h.Sum(nil))
}

// reconcileSSHSecrets ensures both halves of the environment's ssh material
// exist and returns the status ref alongside the host key's digest. The ref is
// nil when the spec delegates: status names only a Secret the controller minted.
//
// The material is two Secrets because it is two things with different owners:
// the host identity, which is the platform's and never leaves the cluster, and
// the client key, which is the user's credential. When the spec names a delegated
// authorized-keys Secret the controller mints the host key only and that Secret
// is mounted as-is; otherwise it mints a client keypair too, so the environment's
// owner has a key that actually logs in (design §6.3).
//
// The user's Secret is read first, before anything is created: a reference that
// is missing, undelegated, or lacks the selected data key then leaves no
// half-provisioned environment behind.
//
// Only the host key produces a revision. The pod reads it through a subPath
// mount, which never sees an update in place, so a repaired host key only reaches
// the pod when the workload rolls (see sshKeysPodAnnotations); the authorized
// keys are a directory mount kubelet keeps in sync, so rotating them deliberately
// does not roll anything.
func (r *DevEnvironmentReconciler) reconcileSSHSecrets(ctx context.Context, env *aiv1alpha1.DevEnvironment) (*corev1.SecretReference, string, error) {
	userKeys := sshUserKeysRef(env)
	if userKeys != nil {
		if err := r.checkUserAuthorizedKeys(ctx, env); err != nil {
			return nil, "", err
		}
	}
	hostKey, err := r.reconcileSSHHostKeySecret(ctx, env)
	if err != nil {
		return nil, "", err
	}
	if userKeys != nil {
		// The user's own Secret. Its name is already in the spec, and it holds the
		// public keys that authorize the login rather than a client key, so there is
		// no generated Secret for status to name.
		return nil, sshHostKeyDigest(hostKey), nil
	}
	if err := r.reconcileSSHClientKeySecret(ctx, env); err != nil {
		return nil, "", err
	}
	// Named through the same helper the Secret is created under, so status and the
	// workload cannot point at different Secrets.
	ref := &corev1.SecretReference{Name: sshClientKeySecretName(env), Namespace: env.Namespace}
	return ref, sshHostKeyDigest(hostKey), nil
}

// reconcileSSHHostKeySecret ensures the managed <env>-ssh-host-key Secret exists
// and carries a host keypair sshd can read. The pair is minted once and not
// rotated (design §6.3), except to replace one sshd cannot read.
//
// It returns the host private key so the caller can fold it into the revision
// digest.
func (r *DevEnvironmentReconciler) reconcileSSHHostKeySecret(ctx context.Context, env *aiv1alpha1.DevEnvironment) ([]byte, error) {
	name := sshHostKeySecretName(env)
	secret := &corev1.Secret{}
	err := r.Get(ctx, types.NamespacedName{Namespace: env.Namespace, Name: name}, secret)
	if apierrors.IsNotFound(err) {
		data := map[string][]byte{}
		// Adopt the host identity of an environment created before the split
		// rather than minting a new one, which would change the fingerprint its
		// users have pinned.
		legacy, err := r.legacyHostKeySecret(ctx, env)
		if err != nil {
			return nil, err
		}
		if legacy != nil {
			data[sshHostKeyKey] = legacy.Data[sshHostKeyKey]
			// The .pub is informational (sshd derives the public half from the
			// private key), and a hand-written legacy Secret may not carry it, so
			// it is copied only when there is one to copy.
			if pub, ok := legacy.Data[sshHostPubKeyKey]; ok {
				data[sshHostPubKeyKey] = pub
			}
		} else {
			privPEM, pubOpenSSH, err := generateSSHKeyPair()
			if err != nil {
				return nil, err
			}
			data[sshHostKeyKey] = privPEM
			data[sshHostPubKeyKey] = pubOpenSSH
		}
		desired := &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: env.Namespace, Labels: r.envLabels(env.Name)},
			Type:       corev1.SecretTypeOpaque,
			Data:       data,
		}
		if err := ctrl.SetControllerReference(env, desired, r.Scheme); err != nil {
			return nil, err
		}
		if err := r.Create(ctx, desired); err != nil {
			return nil, err
		}
		return desired.Data[sshHostKeyKey], nil
	}
	if err != nil {
		return nil, err
	}
	if err := ensureDevEnvOwned(secret, env); err != nil {
		return nil, err
	}
	// A managed Secret can exist without carrying any data — created by hand, or
	// emptied by hand — and the repair below writes into its map, so an empty map
	// has to be in place first. reconcileJupyterTokenSecret needs the same guard
	// for its token.
	if secret.Data == nil {
		secret.Data = map[string][]byte{}
	}
	if hostKeyUnreadable(secret.Data[sshHostKeyKey]) {
		privPEM, pubOpenSSH, err := generateSSHKeyPair()
		if err != nil {
			return nil, err
		}
		secret.Data[sshHostKeyKey] = privPEM
		secret.Data[sshHostPubKeyKey] = pubOpenSSH
		if err := r.Update(ctx, secret); err != nil {
			return nil, err
		}
	}
	return secret.Data[sshHostKeyKey], nil
}

// legacyHostKeySecret is the host keypair inside the pre-split <env>-ssh-keys
// Secret, or nil when there is nothing to carry forward: the Secret is absent,
// is not controlled by this environment, or holds a key sshd cannot read. A
// foreign same-name Secret must never donate a host identity, and adopting a
// PKCS#8 key would only move that problem into the new Secret. Nil means "mint a
// fresh pair".
//
// Only a NotFound is folded into nil: a transient read failure aborts the
// reconcile instead, so a flaky API server can never rotate a host key.
func (r *DevEnvironmentReconciler) legacyHostKeySecret(ctx context.Context, env *aiv1alpha1.DevEnvironment) (*corev1.Secret, error) {
	legacy := &corev1.Secret{}
	if err := r.Get(ctx, types.NamespacedName{Namespace: env.Namespace, Name: sshLegacySecretName(env)}, legacy); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	if ensureDevEnvOwned(legacy, env) != nil {
		return nil, nil
	}
	if hostKeyUnreadable(legacy.Data[sshHostKeyKey]) {
		return nil, nil
	}
	return legacy, nil
}

// reconcileSSHClientKeySecret ensures the generated <env>-ssh-client-key Secret
// carries a client keypair: the private half the environment's owner retrieves
// from status.sshClientKeySecret, and the public half the workload mounts as
// authorized_keys. Like the host key the keypair is minted once and kept, so a
// key its owner has already downloaded keeps working; only one sshd could not
// read sends it back to generation.
//
// The public half is mounted from here rather than from a copy of it under
// another name, so the entry the user reads and the entry that authorizes them
// cannot drift apart, and there is no second entry that looks editable and is
// not. A change here needs no revision: the pod's volume is an ordinary Secret
// mount, which kubelet updates in place.
func (r *DevEnvironmentReconciler) reconcileSSHClientKeySecret(ctx context.Context, env *aiv1alpha1.DevEnvironment) error {
	name := sshClientKeySecretName(env)
	secret := &corev1.Secret{}
	err := r.Get(ctx, types.NamespacedName{Namespace: env.Namespace, Name: name}, secret)
	if apierrors.IsNotFound(err) {
		privPEM, pubOpenSSH, err := generateSSHKeyPair()
		if err != nil {
			return err
		}
		desired := &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: env.Namespace, Labels: r.envLabels(env.Name)},
			Type:       corev1.SecretTypeOpaque,
			Data: map[string][]byte{
				sshClientKeyKey:    privPEM,
				sshClientPubKeyKey: pubOpenSSH,
			},
		}
		if err := ctrl.SetControllerReference(env, desired, r.Scheme); err != nil {
			return err
		}
		return r.Create(ctx, desired)
	}
	if err != nil {
		return err
	}
	if err := ensureDevEnvOwned(secret, env); err != nil {
		return err
	}
	if secret.Data == nil {
		secret.Data = map[string][]byte{}
	}
	changed := false
	pub := secret.Data[sshClientPubKeyKey]
	if hostKeyUnreadable(secret.Data[sshClientKeyKey]) || len(pub) == 0 {
		privPEM, pubOpenSSH, err := generateSSHKeyPair()
		if err != nil {
			return err
		}
		secret.Data[sshClientKeyKey] = privPEM
		secret.Data[sshClientPubKeyKey] = pubOpenSSH
		changed = true
	}
	// The copy an older version of this controller kept for the mount is no
	// longer read by anything, and would sit there looking like the entry to edit.
	if _, ok := secret.Data[sshAuthorizedKeysKey]; ok {
		delete(secret.Data, sshAuthorizedKeysKey)
		changed = true
	}
	if changed {
		return r.Update(ctx, secret)
	}
	return nil
}

// sshHostKeyDigest hashes the host private key into the non-sensitive revision
// recorded on the pod template. It is the only half of the ssh material that
// needs one: the pod reads the key through a subPath mount, which never sees an
// update in place, so a repaired key only reaches it when the workload rolls.
// The authorized keys are a directory mount kubelet keeps in sync, and hashing
// them here would roll every environment on a key rotation — the cost this
// mount shape exists to remove.
func sshHostKeyDigest(hostKeyPriv []byte) string {
	return assetDataHash(map[string]string{sshHostKeyKey: string(hostKeyPriv)})
}

// sshHostKeySecretName is the managed Secret <env>-ssh-host-key, which holds the
// environment's ed25519 host identity and nothing else.
func sshHostKeySecretName(env *aiv1alpha1.DevEnvironment) string {
	return env.Name + "-ssh-host-key"
}

// sshClientKeySecretName is the managed Secret <env>-ssh-client-key, created only
// when the environment supplies no keys of its own: it carries the generated
// client keypair and the authorized_keys entry the workload mounts. It is named
// for the key it holds rather than for the mount, which is the job
// spec.ssh.authorizedKeysSecret names in the delegated case.
func sshClientKeySecretName(env *aiv1alpha1.DevEnvironment) string {
	return env.Name + "-ssh-client-key"
}

// sshLegacySecretName is the pre-split Secret <env>-ssh-keys, which bundled the
// host keypair and authorized_keys together. Nothing creates or updates it any
// more: it survives only as the host-key migration source and as a cleanup
// target for environments created before the split.
func sshLegacySecretName(env *aiv1alpha1.DevEnvironment) string {
	return env.Name + "-ssh-keys"
}

// jupyterTokenSecretName is the name of the managed Jupyter token Secret <env>-jupyter-token.
func jupyterTokenSecretName(env *aiv1alpha1.DevEnvironment) string {
	return env.Name + "-jupyter-token"
}

// reconcileJupyterTokenSecret creates or updates the managed Jupyter token Secret
// <env>-jupyter-token (design §6.3): a random token generated once under the data key
// jupyterTokenKey. The token is never rotated — an existing non-empty token is
// kept so the surfaced token stays valid — but a missing or emptied key is
// refilled so the workload's JUPYTER_TOKEN env var always resolves. The Secret
// is removed together with the environment in cleanup.
//
// It returns the non-sensitive digest of the token in effect (created, refilled,
// or already present) so the caller can record a token revision on the pod
// template: JUPYTER_TOKEN is read at container start, so a refill must roll the
// workload for the new token to take effect (see stsSpecHash).
func (r *DevEnvironmentReconciler) reconcileJupyterTokenSecret(ctx context.Context, env *aiv1alpha1.DevEnvironment) (string, error) {
	name := jupyterTokenSecretName(env)
	secret := &corev1.Secret{}
	err := r.Get(ctx, types.NamespacedName{Namespace: env.Namespace, Name: name}, secret)
	if apierrors.IsNotFound(err) {
		token, err := generateJupyterToken()
		if err != nil {
			return "", err
		}
		desired := &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: env.Namespace, Labels: r.envLabels(env.Name)},
			Type:       corev1.SecretTypeOpaque,
			Data:       map[string][]byte{jupyterTokenKey: []byte(token)},
		}
		if err := ctrl.SetControllerReference(env, desired, r.Scheme); err != nil {
			return "", err
		}
		if err := r.Create(ctx, desired); err != nil {
			return "", err
		}
		return jupyterTokenDigest(token), nil
	}
	if err != nil {
		return "", err
	}
	if err := ensureDevEnvOwned(secret, env); err != nil {
		return "", err
	}
	if len(secret.Data[jupyterTokenKey]) == 0 {
		token, err := generateJupyterToken()
		if err != nil {
			return "", err
		}
		if secret.Data == nil {
			secret.Data = map[string][]byte{}
		}
		secret.Data[jupyterTokenKey] = []byte(token)
		if err := r.Update(ctx, secret); err != nil {
			return "", err
		}
		return jupyterTokenDigest(token), nil
	}
	return jupyterTokenDigest(string(secret.Data[jupyterTokenKey])), nil
}

// jupyterTokenDigest hashes the token so a non-sensitive revision can be
// recorded on the pod template: a sha256 of a random 128-bit token reveals
// nothing that could recover the token, while still changing whenever the token
// changes so the workload rolls onto the new token.
func jupyterTokenDigest(token string) string {
	h := sha256.New()
	h.Write([]byte(token))
	return fmt.Sprintf("sha256:%x", h.Sum(nil))
}

// generateJupyterToken returns a random 32-hex-char token for the managed
// Jupyter auth Secret.
func generateJupyterToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// checkUserAuthorizedKeys verifies the Secret the workload takes its
// authorized_keys from — spec.ssh.keysSecret, at the data key its selector names
// — is one the environment may mount.
//
// The entry has to be present. The volume maps that one data key to the file the
// images read, and a key absent from the Secret leaves the file out of the mount
// rather than failing it: the pod would come up serving nobody, with nothing to
// report. Refusing it here says why. Present-but-empty is allowed — it is a
// legitimate "nobody may log in" state, and it mounts as an empty file.
func (r *DevEnvironmentReconciler) checkUserAuthorizedKeys(ctx context.Context, env *aiv1alpha1.DevEnvironment) error {
	ks := sshUserKeysRef(env)
	_, key := sshAuthorizedKeysSource(env)
	s := &corev1.Secret{}
	if err := r.Get(ctx, types.NamespacedName{Namespace: env.Namespace, Name: ks.Name}, s); err != nil {
		return err
	}
	// Only a Secret that explicitly delegates itself may back authorized_keys:
	// the workload mounts it directly, so an undelegated reference would let an
	// environment creator read any same-namespace Secret through their own
	// container — including another environment's generated login key.
	if s.Labels[devEnvSSHKeysDelegatedLabel] != devEnvSSHKeysDelegatedValue {
		return fmt.Errorf("secret %s/%s is not delegated for SSH keys: missing label %q", env.Namespace, ks.Name, devEnvSSHKeysDelegatedLabel)
	}
	if _, ok := s.Data[key]; !ok {
		return fmt.Errorf("secret %s/%s carries no data key %q, which is the entry the pod mounts as authorized_keys", env.Namespace, ks.Name, key)
	}
	return nil
}

// generateSSHKeyPair produces an ed25519 host keypair: the private key as an
// OpenSSH-format PEM block (sshHostKeyPEMType) and the public key in OpenSSH
// one-line format. The base image contract defines how they are consumed —
// sshd reads the private key in place, so the format has to be one sshd
// accepts: OpenSSH has no PKCS#8 support for Ed25519 and rejects the generic
// "PRIVATE KEY" block with "invalid format".
func generateSSHKeyPair() (privPEM, pubOpenSSH []byte, err error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	pub := priv.Public().(ed25519.PublicKey)
	privPEM = pem.EncodeToMemory(&pem.Block{Type: sshHostKeyPEMType, Bytes: sshEd25519PrivateKeyBlob(pub, priv)})
	pubOpenSSH = append([]byte(sshEd25519Algorithm+" "), base64.StdEncoding.EncodeToString(sshEd25519Blob(pub))...)
	pubOpenSSH = append(pubOpenSSH, '\n')
	return privPEM, pubOpenSSH, nil
}

// sshEd25519PrivateKeyBlob serialises the keypair in OpenSSH's own private key
// format (PROTOCOL.key), unencrypted: the "openssh-key-v1" magic, the cipher
// and KDF names ("none"), the public key blob, then the private section — two
// check integers, the raw public key, the 64-byte private key (seed followed
// by the public key, as crypto/ed25519 lays it out), an empty comment, and the
// 1,2,3… padding up to the cipher's 8-byte block size.
func sshEd25519PrivateKeyBlob(pub ed25519.PublicKey, priv ed25519.PrivateKey) []byte {
	buf := []byte("openssh-key-v1\x00")
	buf = appendSSHString(buf, []byte("none"))  // ciphername
	buf = appendSSHString(buf, []byte("none"))  // kdfname
	buf = appendSSHString(buf, nil)             // kdfoptions
	buf = binary.BigEndian.AppendUint32(buf, 1) // number of keys
	buf = appendSSHString(buf, sshEd25519Blob(pub))

	var section []byte
	// The two check integers must be equal; they detect a wrong passphrase, so
	// any value works for an unencrypted key.
	section = binary.BigEndian.AppendUint32(section, 0)
	section = binary.BigEndian.AppendUint32(section, 0)
	section = appendSSHString(section, []byte(sshEd25519Algorithm))
	section = appendSSHString(section, pub) // raw key, not the blob
	section = appendSSHString(section, priv)
	section = appendSSHString(section, nil) // comment
	for i := 1; len(section)%8 != 0; i++ {
		section = append(section, byte(i))
	}
	return appendSSHString(buf, section)
}

// hostKeyUnreadable reports whether the stored host key is not in a format
// sshd can read, so a Secret written before the format change above — or by
// hand — is regenerated instead of leaving the environment without ssh. A
// regenerated host key changes the host fingerprint, which is unavoidable: the
// key it replaces never authenticated anything.
func hostKeyUnreadable(pemBytes []byte) bool {
	block, _ := pem.Decode(pemBytes)
	return block == nil || block.Type != sshHostKeyPEMType
}

// sshEd25519Blob builds the SSH wire-format public key blob: two
// length-prefixed strings, the algorithm name then the raw public key.
func sshEd25519Blob(pub ed25519.PublicKey) []byte {
	buf := make([]byte, 0, 4+len(sshEd25519Algorithm)+4+len(pub))
	buf = appendSSHString(buf, []byte(sshEd25519Algorithm))
	buf = appendSSHString(buf, pub)
	return buf
}

func appendSSHString(b, s []byte) []byte {
	var l [4]byte
	binary.BigEndian.PutUint32(l[:], uint32(len(s)))
	b = append(b, l[:]...)
	return append(b, s...)
}

// reconcileGatewayRoutes publishes the HTTPRoute and TCPRoutes on the shared
// Gateway, allocates the SSH/TCP ports, and builds the access endpoints. It is
// best-effort: a missing or unready Gateway degrades RouteReady but never
// fails the reconcile (design §6.2).
//
// RouteReady reports what the Gateway did with the routes, not merely that they
// were written: a route the Gateway has not accepted (or has not reported on
// yet) is GatewayNotAccepted and its address is withheld from status.endpoints,
// which would otherwise advertise an address that does not connect. The L4
// listeners are checked first and reported as ListenerNotAccepted, because a
// Gateway that refuses the ListenerSet refuses it above the routes attached to
// it. The route watches above re-enqueue the environment when the Gateway writes
// that status.
//
// A Gateway that is missing or unserved withholds the endpoints too, and not
// merely because its condition is false: Envoy Gateway derives the dataplane
// from the Gateway object, so the published address stops connecting the moment
// the object goes. The platform owns that object now, which makes its deletion
// an ordinary event — an upgrade, a rename, a re-apply — rather than a state
// this install cannot reach.
func (r *DevEnvironmentReconciler) reconcileGatewayRoutes(ctx context.Context, env *aiv1alpha1.DevEnvironment, status *aiv1alpha1.DevEnvironmentStatus) error {
	cfg := r.defaultedConfig()
	gw := &gatewayv1.Gateway{}
	err := r.Get(ctx, types.NamespacedName{Namespace: cfg.GatewayNamespace, Name: cfg.GatewayName}, gw)
	switch {
	case meta.IsNoMatchError(err):
		setDevEnvironmentRouteReadyCondition(&status.Conditions, false, reasonGatewayAPINotInstalled, "Gateway API CRDs are not installed")
		status.Endpoints = nil
		return nil
	case apierrors.IsNotFound(err):
		setDevEnvironmentRouteReadyCondition(&status.Conditions, false, reasonGatewayNotFound, fmt.Sprintf("Gateway %s/%s not found", cfg.GatewayNamespace, cfg.GatewayName))
		// The list withdrawn below is the only record of which endpoint holds
		// which pool port, and a ListenerSet written by an earlier build carries
		// no such record of its own (::migrateListenerNames). An environment that
		// upgrades while the Gateway is away — the upgrade path deletes the
		// Gateway an earlier release owned, so this is that moment — would
		// otherwise come back on a new port, at an address no one was given.
		if err := r.migrateListenerNames(ctx, env, status.Endpoints); err != nil {
			return err
		}
		status.Endpoints = nil
		return nil
	case err != nil:
		return err
	}

	ports, l4Set, published, err := r.publishRoutes(ctx, env, gw)
	if err != nil {
		// A kind the API server does not serve means the Gateway API install is
		// incomplete rather than that publishing failed; say that instead of
		// reporting the no-match error as a route failure.
		reason := reasonRouteCreateFailed
		if meta.IsNoMatchError(err) {
			reason = reasonGatewayAPINotInstalled
		}
		setDevEnvironmentRouteReadyCondition(&status.Conditions, false, reason, err.Error())
		return nil
	}

	gwIP := gatewayIP(gw, cfg)
	if gwIP == "" {
		setDevEnvironmentRouteReadyCondition(&status.Conditions, false, reasonGatewayNotReady, "Gateway has no assigned address")
		status.Endpoints = nil
		return nil
	}
	if rejection := listenerSetRejection(l4Set); rejection != "" {
		setDevEnvironmentRouteReadyCondition(&status.Conditions, false, reasonListenerNotAccepted, rejection)
		status.Endpoints = nil
		return nil
	}
	for _, route := range published {
		if rejection := route.rejection(); rejection != "" {
			setDevEnvironmentRouteReadyCondition(&status.Conditions, false, reasonGatewayNotAccepted, rejection)
			status.Endpoints = nil
			return nil
		}
	}
	// Resolve where each listener is reachable before publishing it: a NodePort
	// dataplane renumbers its listeners, so an address built from the listener
	// port alone would name a port that is closed on the node. The HTTP listener
	// is TCP whatever the environment's own ports are.
	//
	// Only the environments that publish it have to resolve it (publishesHTTP):
	// an ssh-only environment has no endpoint on the HTTP listener, so a
	// dataplane Service that does not carry that port — a Gateway serving no
	// HTTP — says nothing about its ssh address, which resolved perfectly well.
	wanted := make(map[int32]corev1.Protocol, len(ports)+1)
	for name, p := range ports {
		wanted[p] = l4Protocol(env, name)
	}
	if publishesHTTP(env) {
		wanted[cfg.HTTPPort] = corev1.ProtocolTCP
	}
	external, err := r.externalPorts(ctx, gw, wanted)
	if err != nil {
		setDevEnvironmentRouteReadyCondition(&status.Conditions, false, reasonGatewayNotReady, err.Error())
		status.Endpoints = nil
		return nil
	}
	setDevEnvironmentRouteReadyCondition(&status.Conditions, true, reasonPublished, "Routes are published on the gateway")
	r.buildEndpoints(env, status, gwIP, ports, external)
	return nil
}

// publishedRoute is the part of a route this reconcile published that the
// Gateway reports on: what it is, the status the Gateway wrote for it, and which
// object that status is reported against.
type publishedRoute struct {
	kind       string
	name       string
	generation int64
	parents    []gatewayv1.RouteParentStatus
	// parentKind/parentName/parentNamespace name the parent the route attaches
	// to, and so the object whose status reports on it: the shared Gateway for
	// the HTTPRoute, the environment's own ListenerSet for each TCPRoute.
	parentKind      string
	parentName      string
	parentNamespace string
}

// rejection returns "" when the route's parent has accepted it, and otherwise a
// message naming it — the parent's own reason for refusing, when it gave one, or
// the fact that it has not reported on the route's current generation at all.
func (p publishedRoute) rejection() string {
	if routeParentsAccepted(p.parents, p.generation, p.parentName, p.parentNamespace) {
		return ""
	}
	message := fmt.Sprintf("%s %s is not accepted by %s %s/%s", p.kind, p.name, p.parentKind, p.parentNamespace, p.parentName)
	// Quote the parent's own verdict: "No listeners match this parent ref" names
	// the fix, where a bare "not accepted" does not.
	parent := routeParentFor(p.parents, p.parentName, p.parentNamespace)
	if parent == nil {
		return message + ": it has not reported on the route's current generation"
	}
	for _, cond := range parent.Conditions {
		if cond.Status == metav1.ConditionTrue {
			continue
		}
		if cond.ObservedGeneration != 0 && cond.ObservedGeneration != p.generation {
			continue // stale status for a previous generation
		}
		return fmt.Sprintf("%s: %s: %s", message, cond.Reason, cond.Message)
	}
	return message
}

// listenerSetRejection returns "" when the environment's L4 listeners have been
// admitted, and otherwise a message naming what refused them.
//
// It is read before the routes because a refusal lands one level above them: a
// Gateway that does not admit the ListenerSet — the namespace is not allowed by
// allowedListeners, or it has not processed it yet — never gives its routes a
// verdict of their own, so the routes would report only that nothing reported on
// them. Surfacing the ListenerSet's own reason is what makes the documented
// allowedListeners prerequisite diagnosable instead of appearing as an
// environment whose endpoints never appear.
func listenerSetRejection(ls *gatewayv1.ListenerSet) string {
	if ls == nil {
		return ""
	}
	name := fmt.Sprintf("%s %s/%s", listenerSetKind, ls.Namespace, ls.Name)
	reported := false
	for _, cond := range ls.Status.Conditions {
		if cond.Type != string(gatewayv1.ListenerSetConditionAccepted) {
			continue
		}
		if cond.ObservedGeneration != 0 && cond.ObservedGeneration != ls.Generation {
			continue // stale status from a previous generation
		}
		reported = true
		if cond.Status != metav1.ConditionTrue {
			return fmt.Sprintf("%s is not accepted by the gateway: %s: %s", name, cond.Reason, cond.Message)
		}
	}
	if !reported {
		return name + " has not been accepted by the gateway"
	}
	// A listener comes back Conflicted when another listener already holds its
	// port. Gateway API resolves that in the older object's favour, so this
	// environment's port stays dead even though the ListenerSet was accepted —
	// the state the cutover off hand-made Gateway listeners passes through.
	for _, l := range ls.Status.Listeners {
		for _, cond := range l.Conditions {
			if cond.Type == string(gatewayv1.ListenerEntryConditionConflicted) && cond.Status == metav1.ConditionTrue {
				return fmt.Sprintf("%s listener %s is conflicted: %s", name, l.Name, cond.Message)
			}
		}
	}
	return ""
}

// gatewayIP prefers the Gateway's first status address, falling back to the
// configured static address.
func gatewayIP(gw *gatewayv1.Gateway, cfg DevEnvironmentControllerConfig) string {
	for _, addr := range gw.Status.Addresses {
		if addr.Value != "" {
			return addr.Value
		}
	}
	return cfg.GatewayIP
}

// externalPorts maps each given listener port to the port it is reachable on at
// the Gateway's address. Its argument is the listener ports keyed to the
// transport each speaks, since a dataplane Service names both.
//
// A LoadBalancer or ClusterIP dataplane serves a listener on the listener's own
// port, so the mapping is the identity. A NodePort dataplane renumbers every
// listener onto a nodePort instead, and only the dataplane Service knows the
// assignment: the Gateway's status carries an address but no ports. Reading the
// Service is what keeps a published endpoint an address that works.
//
// It reads through APIReader rather than the cache: an address published from a
// stale read is wrong in the user's hands, and this read is all that stands
// between the dataplane's port assignment and the address a user is handed. A
// listener the dataplane does not expose yet is reported rather than passed
// through as its own port, so an endpoint is either known-reachable or
// withheld — never silently dead.
func (r *DevEnvironmentReconciler) externalPorts(ctx context.Context, gw *gatewayv1.Gateway, ports map[int32]corev1.Protocol) (map[int32]int32, error) {
	external := make(map[int32]int32, len(ports))
	for p := range ports {
		external[p] = p
	}
	cfg := r.defaultedConfig()
	if cfg.GatewayDataplaneNamespace == "" {
		return external, nil
	}
	var svcs corev1.ServiceList
	if err := r.APIReader.List(ctx, &svcs, client.InNamespace(cfg.GatewayDataplaneNamespace), client.MatchingLabels{
		gatewayDataplaneNameLabel:      gw.Name,
		gatewayDataplaneNamespaceLabel: gw.Namespace,
	}); err != nil {
		return nil, err
	}
	var dataplane *corev1.Service
	for i := range svcs.Items {
		if svcs.Items[i].Spec.Type == corev1.ServiceTypeNodePort {
			dataplane = &svcs.Items[i]
			break
		}
	}
	if dataplane == nil {
		return external, nil
	}
	for p, protocol := range ports {
		nodePort := int32(0)
		for _, sp := range dataplane.Spec.Ports {
			// The protocol is matched as well as the number. A dataplane
			// Service carries one entry per TCP and per UDP listener, and the
			// two are not obliged to agree on a number outside this operator's
			// pool: a protocol-blind match could return the other entry's
			// nodePort, naming a port that does not serve this endpoint at all.
			if sp.Port == p && sp.Protocol == protocol {
				nodePort = sp.NodePort
				break
			}
		}
		if nodePort == 0 {
			return nil, fmt.Errorf("dataplane Service %s/%s exposes no nodePort for the %s listener port %d", dataplane.Namespace, dataplane.Name, protocol, p)
		}
		external[p] = nodePort
	}
	return external, nil
}

// publishRoutes allocates the SSH and extra tcp/udp ports, declares them as the
// environment's own Gateway listeners, then applies the HTTPRoute and one
// TCPRoute or UDPRoute per allocated port. The returned map is keyed by endpoint
// name and drives buildEndpoints; the returned routes are what the Gateway's
// acceptance is read from, and the returned ListenerSet is what its listeners'
// acceptance is read from (nil when the environment has no L4 port).
func (r *DevEnvironmentReconciler) publishRoutes(ctx context.Context, env *aiv1alpha1.DevEnvironment, gw *gatewayv1.Gateway) (map[string]int32, *gatewayv1.ListenerSet, []publishedRoute, error) {
	cfg := r.defaultedConfig()
	ports := map[string]int32{}
	// The pool is read only for an environment that draws from it, and that read
	// is the reconcile's only use of the TCPRoute, UDPRoute and ListenerSet
	// kinds, which each arrive with their own CRD. An install can carry the
	// Gateway and the HTTPRoute without any of them, so an environment with no L4
	// exposure publishes its HTTPRoute there without naming them, rather than
	// failing with the NoMatch that a missing kind would otherwise raise.
	if l4Exposed(env) {
		used, err := r.usedPorts(ctx, env.Namespace, env.Name)
		if err != nil {
			return nil, nil, nil, err
		}
		held, err := r.heldPorts(ctx, env)
		if err != nil {
			return nil, nil, nil, err
		}
		// A listener the platform declares on the Gateway itself outranks every
		// ListenerSet bound to it: the Gateway API merges the two lists with the
		// parent first, and a listener that loses a port collision is marked
		// Conflicted and never programmed. So a pool port the Gateway already
		// binds must not be handed out. The failure would not be recoverable
		// either — the environment's ListenerSet still holds the port, so every
		// later environment skips it while this one waits on a listener that
		// will never be accepted.
		for _, l := range gw.Spec.Listeners {
			used[l.Port] = true
		}
		for _, name := range l4PortNames(env) {
			p := r.allocatePort(name, used, held)
			if p == 0 {
				return nil, nil, nil, fmt.Errorf("no free port in the L4 port range %d-%d", cfg.L4PortRangeStart, cfg.L4PortRangeEnd)
			}
			ports[name] = p
		}
	}

	// Drop routes for exposures removed since the last reconcile: the loop
	// above no longer allocates their ports, but the old route would keep
	// claiming the Gateway listener and block reuse of the freed port.
	if err := r.pruneL4Routes(ctx, env, ports); err != nil {
		return nil, nil, nil, err
	}

	// Declare the listeners before the routes that attach to them. The routes
	// would be published either way — a route whose listener does not exist yet
	// simply is not accepted — but creating the listener first means the
	// environment never reports a state it has to be corrected out of.
	l4Set, err := r.applyListenerSet(ctx, env, gw, ports)
	if err != nil {
		return nil, nil, nil, err
	}

	published := []publishedRoute{}
	if publishesHTTP(env) {
		route, err := r.applyHTTPRoute(ctx, env, gw)
		if err != nil {
			return nil, nil, nil, err
		}
		published = append(published, publishedRoute{
			kind: httpRouteKind, name: route.Name, generation: route.Generation, parents: route.Status.Parents,
			parentKind: gatewayKind, parentName: gw.Name, parentNamespace: gw.Namespace,
		})
	}
	// Apply the L4 routes in ascending port order — the ports map iterates
	// randomly, and the published set decides which route a rejection names.
	names := make([]string, 0, len(ports))
	for name := range ports {
		names = append(names, name)
	}
	slices.SortFunc(names, func(a, b string) int { return cmp.Compare(ports[a], ports[b]) })
	for _, name := range names {
		// One route per allocated port, of the kind its listener admits: a
		// UDPRoute on a TCP listener (or the reverse) is never accepted, so the
		// protocol decides here and in the ListenerSet alike.
		if l4Protocol(env, name) == corev1.ProtocolUDP {
			route, err := r.applyUDPRoute(ctx, env, name, ports[name])
			if err != nil {
				return nil, nil, nil, err
			}
			published = append(published, publishedRoute{
				kind: udpRouteKind, name: route.Name, generation: route.Generation, parents: route.Status.Parents,
				parentKind: listenerSetKind, parentName: listenerSetName(env), parentNamespace: env.Namespace,
			})
			continue
		}
		route, err := r.applyTCPRoute(ctx, env, name, ports[name])
		if err != nil {
			return nil, nil, nil, err
		}
		published = append(published, publishedRoute{
			kind: tcpRouteKind, name: route.Name, generation: route.Generation, parents: route.Status.Parents,
			parentKind: listenerSetKind, parentName: listenerSetName(env), parentNamespace: env.Namespace,
		})
	}
	return ports, l4Set, published, nil
}

// pruneL4Routes deletes this environment's L4 routes whose allocated port is no
// longer in the desired set — i.e. when an SSH, tcp or udp exposure was removed
// from the spec. Route names embed the allocated port, so the desired set is
// matched by port; a leftover route would keep claiming the Gateway listener and
// block reuse of the freed port by another environment.
func (r *DevEnvironmentReconciler) pruneL4Routes(ctx context.Context, env *aiv1alpha1.DevEnvironment, desired map[string]int32) error {
	desiredPorts := make(map[int32]bool, len(desired))
	for _, p := range desired {
		desiredPorts[p] = true
	}
	var trs gatewayv1.TCPRouteList
	if err := r.List(ctx, &trs, client.InNamespace(env.Namespace), client.MatchingLabels{devEnvironmentLabelKey: env.Name}); err != nil {
		if meta.IsNoMatchError(err) {
			return nil
		}
		return err
	}
	for i := range trs.Items {
		if desiredPorts[tcpRoutePort(trs.Items[i].Name)] {
			continue
		}
		// Only routes owned by this environment may be deleted: a foreign
		// object carrying the environment label must not be touched.
		if err := ensureDevEnvOwned(&trs.Items[i], env); err != nil {
			continue
		}
		if err := r.Delete(ctx, &trs.Items[i]); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	var urs gatewayv1.UDPRouteList
	if err := r.List(ctx, &urs, client.InNamespace(env.Namespace), client.MatchingLabels{devEnvironmentLabelKey: env.Name}); err != nil {
		if meta.IsNoMatchError(err) {
			return nil
		}
		return err
	}
	for i := range urs.Items {
		if desiredPorts[udpRoutePort(urs.Items[i].Name)] {
			continue
		}
		if err := ensureDevEnvOwned(&urs.Items[i], env); err != nil {
			continue
		}
		if err := r.Delete(ctx, &urs.Items[i]); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}

// tcpRoutePort and udpRoutePort extract the allocated listener port from a route
// name of the form <env>-tcp-<port> / <env>-udp-<port>.
func tcpRoutePort(name string) int32 {
	return routePort(name, "-tcp-")
}

func udpRoutePort(name string) int32 {
	return routePort(name, "-udp-")
}

func routePort(name, infix string) int32 {
	i := strings.LastIndex(name, infix)
	if i < 0 {
		return 0
	}
	n, err := strconv.Atoi(name[i+len(infix):])
	if err != nil {
		return 0
	}
	return int32(n)
}

func hasHTTPPorts(env *aiv1alpha1.DevEnvironment) bool {
	for _, p := range env.Spec.Ports {
		if p.Type == aiv1alpha1.PortTypeHTTP {
			return true
		}
	}
	return false
}

// publishesHTTP reports whether the environment has anything on the Gateway's
// HTTP listener: every type except ssh, which serves no web surface of its own,
// plus ssh environments that add an explicit http port. Two decisions ride on
// it and have to agree — whether an HTTPRoute is applied, and whether the HTTP
// listener's port has to be resolved in the dataplane Service before the
// environment's endpoints are published. No endpoint is built for an
// environment that publishes no HTTP, so requiring the port there would withhold
// addresses that did resolve (see reconcileGatewayRoutes).
func publishesHTTP(env *aiv1alpha1.DevEnvironment) bool {
	return env.Spec.Type != aiv1alpha1.DevEnvironmentTypeSSH || hasHTTPPorts(env)
}

// usedPorts collects every L4 port already allocated to another environment
// (the port pool is gateway-wide, so it spans namespaces). Allocations are read
// from the objects that declare them, not from status.endpoints: the endpoint
// list is withheld while a route is unaccepted, and a reservation that disappears
// from under an environment lets two of them claim the same listener port. Both
// objects below are durable records — the ListenerSet holds the port outright,
// and the route's name embeds the port it holds.
//
// The environment's L4 listeners are declared by its ListenerSet, and legacy
// routes attached straight to the Gateway are still counted: the pool is that
// Gateway's listeners, whatever declared them, and counting both is what carries
// ports across the cutover, when routes and ListenerSets briefly coexist. A port
// held by either is taken.
//
// Only objects attached to the configured Gateway count: one parented elsewhere
// holds no listener here. A failed List is returned rather than read as an empty
// pool, which would hand out ports other environments already hold — the one
// exception is a kind the API server does not serve, which holds no objects by
// definition (see the TCPRoute read below).
//
// Every L4 protocol shares this pool: a UDP exposure allocates from here and
// never takes a number TCP already holds. Allocation identity is
// the port number alone — the ListenerSet scan below reads listener ports without
// consulting protocol or listener name, which is what makes that structural. Do
// not add a (protocol, port) key to "reclaim" the shared numbers: the Gateway
// accepts TCP and UDP on one port, so the collision would not be rejected here
// and envtest could not see it (design §8.3).
//
// The Lists go through APIReader, not the cache. Allocation is a read followed
// by a create, and the create lands in the API server while the cache catches up
// asynchronously: an environment reconciled inside that window reads a pool that
// does not yet contain the port the previous reconcile just took, and claims it
// too. Reading through avoids the window entirely, which is what lets the rest of
// allocation stay as it is — reconciles are serialized (MaxConcurrentReconciles
// is pinned to 1 in SetupWithManager), so nothing else can interleave between
// this read and the create. Raising that concurrency would make the sequence racy
// again and would need a real reservation primitive.
func (r *DevEnvironmentReconciler) usedPorts(ctx context.Context, excludeNS, excludeName string) (map[int32]bool, error) {
	cfg := r.defaultedConfig()
	used := map[int32]bool{}
	// A cluster serving the Gateway API's standard channel has no TCPRoute kind
	// at all. That means there are no legacy routes to count — the ListenerSet
	// scan below is what holds every port this operator allocates — so only "no
	// such kind" is tolerated here: read as a failure it would fail allocation
	// for every L4 environment, including the udp-only and ssh-only ones that
	// never had a TCPRoute to count. Every other error is a failed read of a
	// pool this must not mistake for empty.
	var trs gatewayv1.TCPRouteList
	if err := r.APIReader.List(ctx, &trs); err != nil && !meta.IsNoMatchError(err) {
		return nil, err
	}
	// Only TCPRoutes are scanned for their own parent here, and deliberately so:
	// the legacy attachment this covers is a TCPRoute pointed at a listener on
	// the Gateway itself, from before the environment declared its own. UDP had
	// no such era, so every UDPRoute this operator writes hangs off a
	// ListenerSet and its port is already counted below.
	for i := range trs.Items {
		route := &trs.Items[i]
		if route.Namespace == excludeNS && route.Labels[devEnvironmentLabelKey] == excludeName {
			continue // this environment's own allocations are free for it to reuse
		}
		if !routeParentsTo(route.Spec.ParentRefs, route.Namespace, cfg.GatewayName, cfg.GatewayNamespace) {
			continue
		}
		if p := tcpRoutePort(route.Name); p != 0 {
			used[p] = true
		}
	}
	var lss gatewayv1.ListenerSetList
	if err := r.APIReader.List(ctx, &lss); err != nil {
		return nil, err
	}
	for i := range lss.Items {
		ls := &lss.Items[i]
		if ls.Namespace == excludeNS && ls.Labels[devEnvironmentLabelKey] == excludeName {
			continue
		}
		if !listenerSetParentsToGateway(ls, cfg.GatewayName, cfg.GatewayNamespace) {
			continue
		}
		for _, listener := range ls.Spec.Listeners {
			used[listener.Port] = true
		}
	}
	return used, nil
}

// heldPorts is the listener port each endpoint of this environment already
// holds, for allocatePort to keep. The endpoint list carries it whenever it is
// published; the environment's own ListenerSet is where it is read from when it
// is not. That fallback is the difference between a stable address and a moving
// one: the list is withheld while a route or the Gateway is unaccepted, and a
// Gateway is an object the platform creates, replaces and deletes underneath an
// install, so an environment reads as holding nothing at exactly the moment its
// listeners are still declared. Allocation would then hand out the lowest free
// port instead of the environment's own, and the SSH address a user was given
// would stop being the one that answers.
//
// The endpoint list wins where both name the same endpoint. They can only
// disagree after a reconcile that allocated a port, applied the ListenerSet and
// then failed before writing the endpoints, and settling on the published port
// is the choice that leaves the address the user was last shown unchanged.
func (r *DevEnvironmentReconciler) heldPorts(ctx context.Context, env *aiv1alpha1.DevEnvironment) (map[string]int32, error) {
	names := l4PortNames(env)
	held := make(map[string]int32, len(names))
	for _, ep := range env.Status.Endpoints {
		if ep.ListenerPort != 0 {
			held[ep.Name] = ep.ListenerPort
		}
	}
	unrecorded := false
	for _, name := range names {
		if _, ok := held[name]; !ok {
			unrecorded = true
			break
		}
	}
	if !unrecorded {
		return held, nil // every endpoint has a record; the ListenerSet adds nothing
	}
	// Read through APIReader for the reason usedPorts does: this read is followed
	// by the write of the port it returns, and the cache may not have caught up
	// with the previous reconcile's.
	var lss gatewayv1.ListenerSetList
	err := r.APIReader.List(ctx, &lss, client.InNamespace(env.Namespace), client.MatchingLabels(r.envLabels(env.Name)))
	if err != nil {
		// No ListenerSet kind means no listener was ever declared, and so nothing
		// to recover — the same tolerance usedPorts extends to the TCPRoute read.
		if meta.IsNoMatchError(err) {
			return held, nil
		}
		return nil, err
	}
	for i := range lss.Items {
		for _, listener := range lss.Items[i].Spec.Listeners {
			name := l4ListenerEndpoint(listener.Name)
			if name == "" {
				continue
			}
			if _, recorded := held[name]; !recorded {
				held[name] = listener.Port
			}
		}
	}
	return held, nil
}

// migrateListenerNames rewrites the environment's listeners under the naming
// scheme that records the endpoint in the name (::l4ListenerName), pairing each
// one with the endpoint that the given endpoint list records its port against.
// It exists for the one moment where that is still possible: a ListenerSet
// written before the endpoint was part of the name reads back as attributing
// nothing (::l4ListenerEndpoint), so on its own it would leave the allocation
// with no record — and it is called on the way to withdrawing the list that is
// the last one (::reconcileGatewayRoutes).
//
// A listener whose name already carries its endpoint is left alone, as is one
// whose port no endpoint records: the first has nothing to migrate to, the
// second nothing to migrate from.
func (r *DevEnvironmentReconciler) migrateListenerNames(ctx context.Context, env *aiv1alpha1.DevEnvironment, endpoints []aiv1alpha1.Endpoint) error {
	endpointsByPort := make(map[int32]string, len(endpoints))
	for _, ep := range endpoints {
		if ep.ListenerPort != 0 {
			endpointsByPort[ep.ListenerPort] = ep.Name
		}
	}
	lss := &gatewayv1.ListenerSet{}
	err := r.Get(ctx, client.ObjectKey{Name: listenerSetName(env), Namespace: env.Namespace}, lss)
	if err != nil {
		// No ListenerSet kind is an install with no L4 in it, and no such object
		// is an environment that never published a listener: neither has one to
		// migrate.
		if apierrors.IsNotFound(err) || meta.IsNoMatchError(err) {
			return nil
		}
		return err
	}
	migrated := false
	for i, listener := range lss.Spec.Listeners {
		if l4ListenerEndpoint(listener.Name) != "" {
			continue
		}
		name, recorded := endpointsByPort[listener.Port]
		if !recorded {
			continue
		}
		lss.Spec.Listeners[i].Name = gatewayv1.SectionName(l4ListenerName(name, listener.Protocol, listener.Port))
		migrated = true
	}
	if !migrated {
		return nil
	}
	if err := ensureDevEnvOwned(lss, env); err != nil {
		return err
	}
	return r.Update(ctx, lss)
}

// allocatePort picks a port for the named endpoint, reusing the port that
// endpoint already holds when it is still free (stable across restarts) and
// otherwise the lowest free port in the configured range. The record is the
// listener port the environment holds, never the port in an endpoint's address:
// that one says where the endpoint is reachable, not which pool port the
// environment was given.
func (r *DevEnvironmentReconciler) allocatePort(name string, used map[int32]bool, held map[string]int32) int32 {
	cfg := r.defaultedConfig()
	if p, ok := held[name]; ok && p >= cfg.L4PortRangeStart && p <= cfg.L4PortRangeEnd && !used[p] {
		used[p] = true
		return p
	}
	for p := cfg.L4PortRangeStart; p <= cfg.L4PortRangeEnd; p++ {
		if !used[p] {
			used[p] = true
			return p
		}
	}
	return 0
}

// desiredHTTPRoute renders the HTTPRoute: the web path prefix for the main
// port plus one subpath rule per extra http port (design §6.2/§6.4).
func (r *DevEnvironmentReconciler) desiredHTTPRoute(env *aiv1alpha1.DevEnvironment, gw *gatewayv1.Gateway) *gatewayv1.HTTPRoute {
	parentRefs := []gatewayv1.ParentReference{gatewayParentRef(gw, "")}
	rules := []gatewayv1.HTTPRouteRule{}
	if env.Spec.Type != aiv1alpha1.DevEnvironmentTypeSSH {
		rules = append(rules, gatewayv1.HTTPRouteRule{
			Matches: []gatewayv1.HTTPRouteMatch{{Path: &gatewayv1.HTTPPathMatch{
				Type:  ptr(gatewayv1.PathMatchPathPrefix),
				Value: ptr(webPath(env)),
			}}},
			BackendRefs: []gatewayv1.HTTPBackendRef{{BackendRef: serviceBackendRef(env.Name, mainContainerPort(env.Spec.Type))}},
		})
	}
	for _, p := range env.Spec.Ports {
		if p.Type != aiv1alpha1.PortTypeHTTP {
			continue
		}
		rules = append(rules, gatewayv1.HTTPRouteRule{
			Matches: []gatewayv1.HTTPRouteMatch{{Path: &gatewayv1.HTTPPathMatch{
				Type:  ptr(gatewayv1.PathMatchPathPrefix),
				Value: ptr(fmt.Sprintf("/dev/%s/%s/port/%s/", env.Namespace, env.Name, p.Name)),
			}}},
			BackendRefs: []gatewayv1.HTTPBackendRef{{BackendRef: serviceBackendRef(env.Name, p.ContainerPort)}},
		})
	}
	return &gatewayv1.HTTPRoute{
		ObjectMeta: metav1.ObjectMeta{Name: webRouteName(env), Namespace: env.Namespace, Labels: r.envLabels(env.Name)},
		Spec: gatewayv1.HTTPRouteSpec{
			CommonRouteSpec: gatewayv1.CommonRouteSpec{ParentRefs: parentRefs},
			Rules:           rules,
		},
	}
}

func webRouteName(env *aiv1alpha1.DevEnvironment) string {
	return env.Name + "-web"
}

// webPath is the path prefix an environment's web endpoint is published under
// (design §6.4). The route matches it and forwards it unchanged, so the
// endpoint address and any container serving there have to agree on it — the
// Jupyter base_url injection (::withNotebookBaseURL) reads the same function
// rather than repeating the format.
func webPath(env *aiv1alpha1.DevEnvironment) string {
	return fmt.Sprintf("/dev/%s/%s/", env.Namespace, env.Name)
}

// desiredListenerSet renders the environment's L4 listeners. Every allocated
// port becomes one listener here — TCP or UDP, depending on how the port is
// exposed — and the environment's TCPRoutes and UDPRoutes attach to those
// listeners rather than to listeners on the shared Gateway (design §4).
//
// The API server's defaults are set explicitly, as in gatewayParentRef: an
// unset allowedRoutes.namespaces would come back as {from: Same} and an unset
// parentRef group/kind as the Gateway API group and Gateway, and the stored
// spec would then differ from this one on every reconcile.
func (r *DevEnvironmentReconciler) desiredListenerSet(env *aiv1alpha1.DevEnvironment, gw *gatewayv1.Gateway, ports map[string]int32) *gatewayv1.ListenerSet {
	// Declared in ascending port order: the ports map iterates randomly, and a
	// reordered listener list is a changed spec that would be written back on
	// every reconcile.
	names := make([]string, 0, len(ports))
	for name := range ports {
		names = append(names, name)
	}
	slices.SortFunc(names, func(a, b string) int { return cmp.Compare(ports[a], ports[b]) })

	listeners := make([]gatewayv1.ListenerEntry, 0, len(names))
	for _, name := range names {
		protocol, routeKind := l4ListenerFor(l4Protocol(env, name))
		listeners = append(listeners, gatewayv1.ListenerEntry{
			Name:     gatewayv1.SectionName(l4ListenerName(name, protocol, ports[name])),
			Protocol: protocol,
			Port:     ports[name],
			AllowedRoutes: &gatewayv1.AllowedRoutes{
				Kinds: []gatewayv1.RouteGroupKind{{
					Group: ptr(gatewayv1.Group(gatewayAPIGroup)),
					Kind:  gatewayv1.Kind(routeKind),
				}},
				// The ListenerSet and the routes it serves are both in the
				// environment's namespace, so no other namespace has business
				// attaching here.
				Namespaces: &gatewayv1.RouteNamespaces{
					From: ptr(gatewayv1.NamespacesFromSame),
				},
			},
		})
	}
	return &gatewayv1.ListenerSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      listenerSetName(env),
			Namespace: env.Namespace,
			Labels:    r.envLabels(env.Name),
		},
		Spec: gatewayv1.ListenerSetSpec{
			ParentRef: gatewayv1.ParentGatewayReference{
				Group:     ptr(gatewayv1.Group(gatewayAPIGroup)),
				Kind:      ptr(gatewayv1.Kind(gatewayKind)),
				Namespace: ptr(gatewayv1.Namespace(gw.Namespace)),
				Name:      gatewayv1.ObjectName(gw.Name),
			},
			Listeners: listeners,
		},
	}
}

// desiredTCPRoute renders the TCPRoute for one allocated port: it attaches to
// the matching listener of the environment's own ListenerSet and forwards to
// the matching Service port (design §4).
func (r *DevEnvironmentReconciler) desiredTCPRoute(env *aiv1alpha1.DevEnvironment, name string, port int32) *gatewayv1.TCPRoute {
	return &gatewayv1.TCPRoute{
		ObjectMeta: metav1.ObjectMeta{Name: tcpRouteName(env, port), Namespace: env.Namespace, Labels: r.envLabels(env.Name)},
		Spec: gatewayv1.TCPRouteSpec{
			CommonRouteSpec: gatewayv1.CommonRouteSpec{ParentRefs: []gatewayv1.ParentReference{
				listenerSetParentRef(env, name, corev1.ProtocolTCP, port),
			}},
			Rules: []gatewayv1.TCPRouteRule{{
				BackendRefs: []gatewayv1.BackendRef{serviceBackendRef(env.Name, servicePortFor(env, name))},
			}},
		},
	}
}

// desiredUDPRoute renders the UDPRoute for one allocated port. It is the
// datagram twin of desiredTCPRoute: the same listener, the same backend and the
// same naming, differing only in the kind it is and in the field its backend
// goes into.
func (r *DevEnvironmentReconciler) desiredUDPRoute(env *aiv1alpha1.DevEnvironment, name string, port int32) *gatewayv1.UDPRoute {
	return &gatewayv1.UDPRoute{
		ObjectMeta: metav1.ObjectMeta{Name: udpRouteName(env, port), Namespace: env.Namespace, Labels: r.envLabels(env.Name)},
		Spec: gatewayv1.UDPRouteSpec{
			CommonRouteSpec: gatewayv1.CommonRouteSpec{ParentRefs: []gatewayv1.ParentReference{
				listenerSetParentRef(env, name, corev1.ProtocolUDP, port),
			}},
			Rules: []gatewayv1.UDPRouteRule{{
				BackendRefs: []gatewayv1.BackendRef{serviceBackendRef(env.Name, servicePortFor(env, name))},
			}},
		},
	}
}

func tcpRouteName(env *aiv1alpha1.DevEnvironment, port int32) string {
	return fmt.Sprintf("%s-tcp-%d", env.Name, port)
}

func udpRouteName(env *aiv1alpha1.DevEnvironment, port int32) string {
	return fmt.Sprintf("%s-udp-%d", env.Name, port)
}

// listenerSetName is the per-environment ListenerSet that carries the
// environment's L4 listeners. One per environment, so the listeners come and go
// with it (design §7.2).
func listenerSetName(env *aiv1alpha1.DevEnvironment) string {
	return env.Name + l4ListenerSetSuffix
}

// l4ListenerName names one listener within the ListenerSet: the endpoint it was
// declared for, then the protocol and the port, e.g. "ssh-tcp-20000". Listener
// names only have to be unique within their ListenerSet, and an allocated port
// is unique across the whole gateway, so spelling the port keeps them distinct
// without a second naming scheme; the protocol is there so a reader can tell a
// datagram port from a stream one without checking the listener's protocol
// field; and the endpoint leads because the name is also the record the
// environment's own allocation is read back from when status no longer carries
// it (::heldPorts).
func l4ListenerName(name string, protocol gatewayv1.ProtocolType, port int32) string {
	return fmt.Sprintf("%s-%s-%d", name, strings.ToLower(string(protocol)), port)
}

// l4ListenerEndpoint recovers the endpoint a ListenerSet listener was declared
// for from its name (::l4ListenerName). A name this operator did not write — a
// listener left from before the endpoint was part of it — recovers "", and its
// port is left to whatever else records the allocation.
func l4ListenerEndpoint(name gatewayv1.SectionName) string {
	for _, infix := range []string{"-tcp-", "-udp-"} {
		if i := strings.LastIndex(string(name), infix); i > 0 {
			if _, err := strconv.Atoi(string(name)[i+len(infix):]); err == nil {
				return string(name)[:i]
			}
		}
	}
	return ""
}

// listenerSetParentRef points a route at one listener of the environment's
// ListenerSet. The ListenerSet lives in the environment's namespace, so unlike
// gatewayParentRef this resolves without fetching anything. As there, the
// explicit defaults are set so the stored spec compares equal across
// reconciles.
func listenerSetParentRef(env *aiv1alpha1.DevEnvironment, name string, protocol corev1.Protocol, port int32) gatewayv1.ParentReference {
	listenerProtocol, _ := l4ListenerFor(protocol)
	return gatewayv1.ParentReference{
		Group:       ptr(gatewayv1.Group(gatewayAPIGroup)),
		Kind:        ptr(gatewayv1.Kind(listenerSetKind)),
		Namespace:   ptr(gatewayv1.Namespace(env.Namespace)),
		Name:        gatewayv1.ObjectName(listenerSetName(env)),
		SectionName: ptr(gatewayv1.SectionName(l4ListenerName(name, listenerProtocol, port))),
	}
}

// gatewayParentRef builds a ParentReference to the shared Gateway, setting the
// explicit defaults so the stored route spec compares equal across reconciles.
func gatewayParentRef(gw *gatewayv1.Gateway, sectionName string) gatewayv1.ParentReference {
	ref := gatewayv1.ParentReference{
		Group:     ptr(gatewayv1.Group(gatewayAPIGroup)),
		Kind:      ptr(gatewayv1.Kind(gatewayKind)),
		Namespace: ptr(gatewayv1.Namespace(gw.Namespace)),
		Name:      gatewayv1.ObjectName(gw.Name),
	}
	if sectionName != "" {
		ref.SectionName = ptr(gatewayv1.SectionName(sectionName))
	}
	return ref
}

// serviceBackendRef builds a backend reference to the environment Service,
// with explicit defaults for the fields the API server would otherwise
// default, keeping the stored route spec stable.
func serviceBackendRef(serviceName string, port int32) gatewayv1.BackendRef {
	return gatewayv1.BackendRef{
		BackendObjectReference: gatewayv1.BackendObjectReference{
			Group: ptr(gatewayv1.Group("")),
			Kind:  ptr(gatewayv1.Kind(serviceKind)),
			Name:  gatewayv1.ObjectName(serviceName),
			Port:  ptr(port),
		},
		Weight: ptr(int32(1)),
	}
}

// servicePortFor is the Service port number behind a named endpoint: the ssh
// port is always sshServicePort (which the Service maps to the container's
// sshContainerPort), extras use the declared containerPort.
func servicePortFor(env *aiv1alpha1.DevEnvironment, name string) int32 {
	if name == sshPortName {
		return sshServicePort
	}
	for _, p := range env.Spec.Ports {
		if p.Name == name {
			return p.ContainerPort
		}
	}
	return 0
}

// applyHTTPRoute creates or updates the HTTPRoute, returning the stored object
// so its acceptance can be read. A route this call created or changed carries no
// acceptance for its new generation until the Gateway reports on it, which is
// what the returned object shows.
func (r *DevEnvironmentReconciler) applyHTTPRoute(ctx context.Context, env *aiv1alpha1.DevEnvironment, gw *gatewayv1.Gateway) (*gatewayv1.HTTPRoute, error) {
	desired := r.desiredHTTPRoute(env, gw)
	if err := ctrl.SetControllerReference(env, desired, r.Scheme); err != nil {
		return nil, err
	}
	existing := &gatewayv1.HTTPRoute{}
	err := r.Get(ctx, client.ObjectKey{Name: desired.Name, Namespace: desired.Namespace}, existing)
	if apierrors.IsNotFound(err) {
		return desired, r.Create(ctx, desired)
	}
	if err != nil {
		return nil, err
	}
	if err := ensureDevEnvOwned(existing, env); err != nil {
		return nil, err
	}
	if apiequality.Semantic.DeepEqual(existing.Spec, desired.Spec) {
		return existing, nil
	}
	desired.ResourceVersion = existing.ResourceVersion
	return desired, r.Update(ctx, desired)
}

// applyTCPRoute creates or updates one TCPRoute, returning the stored object so
// its acceptance can be read.
func (r *DevEnvironmentReconciler) applyTCPRoute(ctx context.Context, env *aiv1alpha1.DevEnvironment, name string, port int32) (*gatewayv1.TCPRoute, error) {
	desired := r.desiredTCPRoute(env, name, port)
	if err := ctrl.SetControllerReference(env, desired, r.Scheme); err != nil {
		return nil, err
	}
	existing := &gatewayv1.TCPRoute{}
	err := r.Get(ctx, client.ObjectKey{Name: desired.Name, Namespace: desired.Namespace}, existing)
	if apierrors.IsNotFound(err) {
		return desired, r.Create(ctx, desired)
	}
	if err != nil {
		return nil, err
	}
	if err := ensureDevEnvOwned(existing, env); err != nil {
		return nil, err
	}
	if apiequality.Semantic.DeepEqual(existing.Spec, desired.Spec) {
		return existing, nil
	}
	desired.ResourceVersion = existing.ResourceVersion
	return desired, r.Update(ctx, desired)
}

// applyUDPRoute creates or updates one UDPRoute, returning the stored object so
// its acceptance can be read. It is applyTCPRoute against the other kind.
func (r *DevEnvironmentReconciler) applyUDPRoute(ctx context.Context, env *aiv1alpha1.DevEnvironment, name string, port int32) (*gatewayv1.UDPRoute, error) {
	desired := r.desiredUDPRoute(env, name, port)
	if err := ctrl.SetControllerReference(env, desired, r.Scheme); err != nil {
		return nil, err
	}
	existing := &gatewayv1.UDPRoute{}
	err := r.Get(ctx, client.ObjectKey{Name: desired.Name, Namespace: desired.Namespace}, existing)
	if apierrors.IsNotFound(err) {
		return desired, r.Create(ctx, desired)
	}
	if err != nil {
		return nil, err
	}
	if err := ensureDevEnvOwned(existing, env); err != nil {
		return nil, err
	}
	if apiequality.Semantic.DeepEqual(existing.Spec, desired.Spec) {
		return existing, nil
	}
	desired.ResourceVersion = existing.ResourceVersion
	return desired, r.Update(ctx, desired)
}

// applyListenerSet creates or updates the environment's ListenerSet so it
// declares exactly the allocated ports, returning the stored object so its
// acceptance can be read. With no ports there is no L4 exposure and the object
// is removed instead: a listener left behind keeps its port claimed (see
// usedPorts) and Gateway API would still prefer it as the older declaration.
//
// The ListenerSet kind arrives with its own CRD, so this is reached on clusters
// that do not serve it, by environments that expose nothing on L4. Only the
// removal path tolerates that (see below); declaring ports needs the kind, and
// its NoMatch is left to report as the incomplete install it is.
func (r *DevEnvironmentReconciler) applyListenerSet(ctx context.Context, env *aiv1alpha1.DevEnvironment, gw *gatewayv1.Gateway, ports map[string]int32) (*gatewayv1.ListenerSet, error) {
	existing := &gatewayv1.ListenerSet{}
	err := r.Get(ctx, client.ObjectKey{Name: listenerSetName(env), Namespace: env.Namespace}, existing)

	// No ports means no L4 exposure: remove the object rather than leave a
	// listener behind, which would keep its port claimed (see usedPorts) and,
	// being the older declaration, would win any conflict over a new owner's.
	// "Nothing to remove" covers both a kind the cluster serves without the
	// object and one it does not serve at all (NoMatch) — the latter is an
	// install with no L4 in it, where no ListenerSet can exist to remove, and
	// failing here would withhold the environment's HTTPRoute over it.
	if len(ports) == 0 {
		if apierrors.IsNotFound(err) || meta.IsNoMatchError(err) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if err := ensureDevEnvOwned(existing, env); err != nil {
			return nil, err
		}
		return nil, r.Delete(ctx, existing)
	}

	notFound := apierrors.IsNotFound(err)
	if err != nil && !notFound {
		return nil, err
	}
	desired := r.desiredListenerSet(env, gw, ports)
	if err := ctrl.SetControllerReference(env, desired, r.Scheme); err != nil {
		return nil, err
	}
	if notFound {
		return desired, r.Create(ctx, desired)
	}
	if err := ensureDevEnvOwned(existing, env); err != nil {
		return nil, err
	}
	if apiequality.Semantic.DeepEqual(existing.Spec, desired.Spec) {
		return existing, nil
	}
	desired.ResourceVersion = existing.ResourceVersion
	return desired, r.Update(ctx, desired)
}

// buildEndpoints assembles status.endpoints from the published routes: the
// web URL, the SSH address, and the extra http/tcp exposures.
//
// ports maps an endpoint name to the listener port its exposure holds in the L4
// pool; external maps a listener port to the port it is reachable on at gwIP.
// The two differ under a NodePort dataplane, and both are recorded: external in
// the address, so that it works, and ports in listenerPort, so that the
// allocator can hand the same listener back on the next reconcile.
func (r *DevEnvironmentReconciler) buildEndpoints(env *aiv1alpha1.DevEnvironment, status *aiv1alpha1.DevEnvironmentStatus, gwIP string, ports map[string]int32, external map[int32]int32) {
	cfg := r.defaultedConfig()
	// JoinHostPort brackets a literal IPv6 gateway address ([::1]:80); a plain
	// fmt "%s:%d" would produce an invalid URL.
	hostPort := func(port int32) string {
		return net.JoinHostPort(gwIP, strconv.Itoa(int(external[port])))
	}
	status.Endpoints = nil
	if env.Spec.Type != aiv1alpha1.DevEnvironmentTypeSSH {
		status.Endpoints = append(status.Endpoints, aiv1alpha1.Endpoint{
			Name:         string(env.Spec.Type),
			Address:      "http://" + hostPort(cfg.HTTPPort) + webPath(env),
			ListenerPort: cfg.HTTPPort,
		})
	}
	if sshExposed(env) {
		status.Endpoints = append(status.Endpoints, aiv1alpha1.Endpoint{
			Name:         sshPortName,
			Address:      fmt.Sprintf("ssh://%s@%s", runtimeUser(env), hostPort(ports[sshPortName])),
			ListenerPort: ports[sshPortName],
		})
	}
	for _, p := range env.Spec.Ports {
		switch p.Type {
		case aiv1alpha1.PortTypeHTTP:
			status.Endpoints = append(status.Endpoints, aiv1alpha1.Endpoint{
				Name:         p.Name,
				Address:      "http://" + hostPort(cfg.HTTPPort) + fmt.Sprintf("/dev/%s/%s/port/%s/", env.Namespace, env.Name, p.Name),
				ListenerPort: cfg.HTTPPort,
			})
		case aiv1alpha1.PortTypeTCP, aiv1alpha1.PortTypeUDP:
			// Both are published as a bare host:port, and the client prefixes
			// the scheme its protocol needs — tcp:// or udp:// — exactly as it
			// does for a TLS port. Which of the two the port speaks is in the
			// spec, under this same endpoint name.
			status.Endpoints = append(status.Endpoints, aiv1alpha1.Endpoint{
				Name:         p.Name,
				Address:      hostPort(ports[p.Name]),
				ListenerPort: ports[p.Name],
			})
		}
	}
}

// environmentPod reads the environment's ordinal-0 pod, returning nil when it
// does not exist yet (scale 0 or pod not created).
func (r *DevEnvironmentReconciler) environmentPod(ctx context.Context, env *aiv1alpha1.DevEnvironment) (*corev1.Pod, error) {
	pod := &corev1.Pod{}
	err := r.Get(ctx, types.NamespacedName{Namespace: env.Namespace, Name: podName(env)}, pod)
	if apierrors.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return pod, nil
}

func podName(env *aiv1alpha1.DevEnvironment) string {
	return env.Name + "-0"
}

// envLabels are the labels every managed resource carries: the owning
// environment and the controller identity.
func (r *DevEnvironmentReconciler) envLabels(envName string) map[string]string {
	return map[string]string{
		devEnvironmentLabelKey: envName,
		managedByLabelKey:      devEnvManagedByValue,
	}
}

// ensureDevEnvOwned verifies that an existing resource is controlled by the
// given DevEnvironment. A same-name resource owned by someone else — or not
// owned at all — must never be updated or accepted; the caller returns a
// conflict so the reconcile fails visibly instead of mutating foreign objects.
func ensureDevEnvOwned(existing client.Object, env *aiv1alpha1.DevEnvironment) error {
	if owner := metav1.GetControllerOf(existing); owner == nil || owner.UID != env.UID {
		return apierrors.NewConflict(schema.GroupResource{Group: "ai.cubestack.io", Resource: "devenvironments"},
			existing.GetName(), fmt.Errorf("resource is not controlled by DevEnvironment %q", env.Name))
	}
	return nil
}

// setPhase sets the environment phase, bumping LastTransitionTime only when
// the phase name changes.
func setPhase(status *aiv1alpha1.DevEnvironmentStatus, name aiv1alpha1.PhaseName, reason string) {
	if status.Phase == nil || status.Phase.Name != name {
		now := metav1.Now()
		status.Phase = &aiv1alpha1.Phase{Name: name, LastTransitionTime: &now}
	}
	status.Phase.Reason = reason
}

// setAcceptedCondition sets the Accepted condition: whether the controller
// applies the spec as written, or has resolved some of it itself
// (::specFindings).
func setAcceptedCondition(conditions *[]metav1.Condition, status metav1.ConditionStatus, reason, message string) {
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type: aiv1alpha1.ConditionAccepted, Status: status, Reason: reason, Message: message,
	})
}

// setPodScheduledCondition sets the PodScheduled condition from the observed
// pod.
func setPodScheduledCondition(conditions *[]metav1.Condition, pod *corev1.Pod) {
	switch {
	case pod == nil:
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type: aiv1alpha1.ConditionPodScheduled, Status: metav1.ConditionFalse, Reason: reasonNotCreated, Message: "The environment pod has not been created yet",
		})
	case pod.Spec.NodeName == "":
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type: aiv1alpha1.ConditionPodScheduled, Status: metav1.ConditionFalse, Reason: reasonNotScheduled, Message: "The environment pod is not scheduled to a node yet",
		})
	default:
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type: aiv1alpha1.ConditionPodScheduled, Status: metav1.ConditionTrue, Reason: reasonScheduled, Message: "The environment pod is scheduled",
		})
	}
}

// setDevEnvironmentRouteReadyCondition sets the RouteReady condition from the gateway
// publish outcome.
func setDevEnvironmentRouteReadyCondition(conditions *[]metav1.Condition, ready bool, reason, message string) {
	status := metav1.ConditionTrue
	if !ready {
		status = metav1.ConditionFalse
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type: aiv1alpha1.ConditionRouteReady, Status: status, Reason: reason, Message: message,
	})
}

// setDevEnvironmentReadyCondition sets the Ready condition.
func setDevEnvironmentReadyCondition(conditions *[]metav1.Condition, status metav1.ConditionStatus, reason, message string) {
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type: aiv1alpha1.ConditionReady, Status: status, Reason: reason, Message: message,
	})
}

// setPhaseAndReady derives the phase and Ready condition from the desired
// running state and the observed pod (design §4.2).
func (r *DevEnvironmentReconciler) setPhaseAndReady(env *aiv1alpha1.DevEnvironment, status *aiv1alpha1.DevEnvironmentStatus, pod *corev1.Pod) {
	switch {
	case !env.Spec.Running:
		setPhase(status, aiv1alpha1.PhaseStopped, reasonStopped)
		setDevEnvironmentReadyCondition(&status.Conditions, metav1.ConditionFalse, reasonStopped, "Environment is stopped (running=false)")
	case autoStopped(env):
		// The mark, not spec.running, is what says stopped (D7/DEV-27), and it
		// has to be read before the pod cases: the stop scales the StatefulSet to
		// zero, so the pod this reconcile sees is missing or terminating, and
		// reporting Pending or Failed for an environment the platform stopped on
		// purpose would be wrong in both directions. A user's own stop keeps its
		// own reason — its case is above, and it clears the mark before this runs.
		setPhase(status, aiv1alpha1.PhaseStopped, reasonIdleTimeout)
		setDevEnvironmentReadyCondition(&status.Conditions, metav1.ConditionFalse, reasonIdleTimeout,
			fmt.Sprintf("Environment was stopped after %s of inactivity", idleTimeoutOf(env)))
	case pod == nil:
		setPhase(status, aiv1alpha1.PhasePending, reasonPending)
		setDevEnvironmentReadyCondition(&status.Conditions, metav1.ConditionFalse, reasonPending, "The environment pod has not been created yet")
	case pod.Spec.NodeName == "":
		setPhase(status, aiv1alpha1.PhasePending, reasonPending)
		setDevEnvironmentReadyCondition(&status.Conditions, metav1.ConditionFalse, reasonPending, "The environment pod is not scheduled to a node yet")
	case podFailed(pod):
		reason := failedReason(pod)
		setPhase(status, aiv1alpha1.PhaseFailed, reason)
		setDevEnvironmentReadyCondition(&status.Conditions, metav1.ConditionFalse, reason, fmt.Sprintf("Environment failed: %s", reason))
	case pod.Status.Phase == corev1.PodRunning && podReady(pod):
		setPhase(status, aiv1alpha1.PhaseRunning, reasonRunning)
		setDevEnvironmentReadyCondition(&status.Conditions, metav1.ConditionTrue, reasonRunning, "Environment is running and ready")
	case pod.Status.Phase == corev1.PodRunning:
		setPhase(status, aiv1alpha1.PhaseRunning, reasonRunning)
		setDevEnvironmentReadyCondition(&status.Conditions, metav1.ConditionFalse, reasonRunning, "Environment pod is running but not ready")
	default:
		setPhase(status, aiv1alpha1.PhasePending, reasonPending)
		setDevEnvironmentReadyCondition(&status.Conditions, metav1.ConditionFalse, reasonPending, "Environment pod is being created")
	}
}

// withdrawStoppedEndpoints drops the access addresses of a stopped environment:
// its workload is scaled to zero, so nothing answers behind the routes, and the
// phase already says why. Withheld here rather than where the routes are
// published so that one rule covers every stop — a user's spec.running=false, an
// idle auto-stop, and an environment that has never been started — the way it
// already covers them for an ssh exposure, whose L4 route the gateway rejects
// once its Service has no ready endpoints.
//
// The routes and the ListenerSet are left in place: the address is recomputed on
// the next start, and for an L4 exposure heldPorts recovers the port it held from
// the ListenerSet (::heldPorts), so the environment comes back on the same one.
func withdrawStoppedEndpoints(status *aiv1alpha1.DevEnvironmentStatus) {
	if status.Phase != nil && status.Phase.Name == aiv1alpha1.PhaseStopped {
		status.Endpoints = nil
	}
}

// emitLifecycleTransition records an events.k8s.io/v1 Event when the derived
// phase makes a user-visible lifecycle transition (design §11.2). env carries the last
// persisted phase and desired the just-derived one, so only a real transition
// fires; a phase that is unchanged across reconciles emits nothing. The Stopped
// guard (old phase must be non-empty) keeps a newly created, never-started
// environment (running=false) from reporting a stop it never went through.
func (r *DevEnvironmentReconciler) emitLifecycleTransition(env, desired *aiv1alpha1.DevEnvironment) {
	if r.Recorder == nil || desired.Status.Phase == nil {
		return
	}
	oldName := aiv1alpha1.PhaseName("")
	if env.Status.Phase != nil {
		oldName = env.Status.Phase.Name
	}
	switch desired.Status.Phase.Name {
	case aiv1alpha1.PhaseRunning:
		if oldName != aiv1alpha1.PhaseRunning {
			r.Recorder.Eventf(env, nil, corev1.EventTypeNormal, eventReasonStarted, eventReasonStarted,
				"DevEnvironment %s/%s is running", env.Namespace, env.Name)
		}
	case aiv1alpha1.PhaseStopped:
		if oldName != "" && oldName != aiv1alpha1.PhaseStopped {
			// The reason is the phase's own, so an idle auto-stop is recorded
			// under reasonIdleTimeout while a user stop keeps the reason it has
			// always had: both constants are the string "Stopped", so that path
			// is unchanged. Keying this off the mark instead would label a user's
			// stop of a marked environment an auto-stop.
			reason := eventReasonStopped
			if desired.Status.Phase.Reason != "" {
				reason = desired.Status.Phase.Reason
			}
			r.Recorder.Eventf(env, nil, corev1.EventTypeNormal, reason, reason,
				"DevEnvironment %s/%s is stopped", env.Namespace, env.Name)
		}
	case aiv1alpha1.PhaseFailed:
		if oldName != aiv1alpha1.PhaseFailed {
			r.Recorder.Eventf(env, nil, corev1.EventTypeWarning, eventReasonFailed, eventReasonFailed,
				"DevEnvironment %s/%s failed: %s", env.Namespace, env.Name, desired.Status.Phase.Reason)
		}
	}
}

// podFailed reports whether the pod is failed or waiting on an image or
// crash-loop error (design §4.2: these surface as Failed rather than Pending).
func podFailed(pod *corev1.Pod) bool {
	if pod.Status.Phase == corev1.PodFailed {
		return true
	}
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.State.Waiting != nil {
			switch cs.State.Waiting.Reason {
			case imagePullBackOff, errImagePull, crashLoopBackOff:
				return true
			}
		}
	}
	return false
}

// failedReason names the failure: the pod's failed phase, or the first
// container waiting reason.
func failedReason(pod *corev1.Pod) string {
	if pod.Status.Phase == corev1.PodFailed {
		return reasonFailed
	}
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			return cs.State.Waiting.Reason
		}
	}
	return reasonFailed
}

// podReady reports whether the pod's Ready condition is true (its readiness
// probe passes).
func podReady(pod *corev1.Pod) bool {
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
			return true
		}
	}
	return false
}

// defaultedConfig returns the controller config with zero values replaced by
// the platform defaults.
func (r *DevEnvironmentReconciler) defaultedConfig() DevEnvironmentControllerConfig {
	cfg := r.Config
	if cfg.GatewayName == "" {
		cfg.GatewayName = defaultGatewayName
	}
	if cfg.GatewayNamespace == "" {
		cfg.GatewayNamespace = defaultGatewayNamespace
	}
	if cfg.HTTPPort == 0 {
		cfg.HTTPPort = 80
	}
	if cfg.L4PortRangeStart == 0 {
		cfg.L4PortRangeStart = 20000
	}
	if cfg.L4PortRangeEnd == 0 {
		cfg.L4PortRangeEnd = 20999
	}
	if cfg.RDMAIBResource == "" {
		cfg.RDMAIBResource = defaultRDMAIBResource
	}
	if cfg.RDMARoCEResource == "" {
		cfg.RDMARoCEResource = defaultRDMARoCEResource
	}
	return cfg
}
