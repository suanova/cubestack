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
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=list;patch
// +kubebuilder:rbac:groups=networking.k8s.io,resources=networkpolicies,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=httproutes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=tcproutes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=udproutes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gateways,verbs=get;list;watch
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=listenersets,verbs=get;list;watch;create;update;patch;delete

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
	"slices"
	"strconv"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
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
}

// Reason constants for DevEnvironment conditions and status.phase. Several
// values double as both a phase name and a condition reason.
const (
	reasonPending                = "Pending"
	reasonRunning                = "Running"
	reasonStopped                = "Stopped"
	reasonFailed                 = "Failed"
	reasonDeleting               = "Deleting"
	reasonScheduled              = "Scheduled"
	reasonNotScheduled           = "NotScheduled"
	reasonNotCreated             = "PodNotCreated"
	reasonNotApplicable          = "NotApplicable"
	reasonBrandMismatch          = "BrandMismatch"
	reasonBrandValid             = "BrandMatchValid"
	reasonNotebookArgsUnusable   = "NotebookArgsUnusable"
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

	// defaultGatewayName is the shared Envoy Gateway the routes attach to when
	// no name is configured.
	defaultGatewayName = "cubestack-gateway"

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
	// spec.runtime.user or defaultRuntimeUser when the spec names none.
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

	// defaultRuntimeUser is the account an environment logs in as when
	// spec.runtime.user names none; it is also the account the platform's base
	// images conventionally use.
	defaultRuntimeUser = "user"

	// defaultWorkspacePath is where the workspace PVC mounts when neither
	// spec.storage.mountPath nor a declared HOME nor the runtime identity implies
	// another home.
	defaultWorkspacePath = "/workspace"

	// homeEnv is the variable spec.runtime.env declares the account's home
	// through; it is the second input to the workspace mount path
	// (::resolveMountPath).
	homeEnv = "HOME"

	// Jupyter token: the managed Secret <env>-auth holds the random token under
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

	// compute node pool labels: development pods are pinned to the compute
	// pool, isolated from the inference pool (design §8.1).
	computeNodePoolLabelKey = "cubestack.io/node-pool"
	computeNodePoolValue    = "compute"

	sshEd25519Algorithm = "ssh-ed25519"
	sshHostKeyPEMType   = "OPENSSH PRIVATE KEY"

	// Kubernetes Event reasons emitted on lifecycle transitions (design §11.2):
	// Created on adoption, Started/Stopped on phase transitions into
	// Running/Stopped, and Failed (Warning) on transitions into Failed.
	eventReasonCreated = "Created"
	eventReasonStarted = "Started"
	eventReasonStopped = "Stopped"
	eventReasonFailed  = "Failed"

	// legacyStorageReadyCondition is the workspace condition the pre-delegation
	// controller reported while it managed the claim itself. The claim's
	// lifecycle belongs to the StatefulSet now, so nothing can set or clear it
	// any more; an environment created by that manager still carries it, and it
	// is dropped during reconcile rather than left on status forever.
	legacyStorageReadyCondition = "StorageReady"
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

// Reconcile runs the DevEnvironment pipeline: brand match gate, SSH secret,
// core resources, gateway routes (best-effort), then pod/PVC observation and
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
	// any path below writes status.
	meta.RemoveStatusCondition(&desired.Status.Conditions, legacyStorageReadyCondition)

	// 1. Brand match gate: gpuType must match the image brand. A mismatch is a
	// hard failure — nothing is provisioned (design §4.2). An environment that
	// was running before the image or gpuType changed is withdrawn so the Failed
	// phase reflects reality: the workload is stopped and the routes removed.
	// An environment requesting no GPU (gpuCount 0) is exempt: with no
	// accelerator there is no brand to match, which is what makes a CPU image
	// usable at all.
	if reason := brandMismatchReason(&env); reason != "" {
		if err := r.stopCompute(ctx, &env); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.deleteRoutes(ctx, &env); err != nil {
			return ctrl.Result{}, err
		}
		setBrandMatchValidCondition(&desired.Status.Conditions, false, reasonBrandMismatch, reason)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionPodScheduled)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionRouteReady)
		desired.Status.Endpoints = nil
		setPhase(&desired.Status, aiv1alpha1.PhaseFailed, reasonBrandMismatch)
		setDevEnvironmentReadyCondition(&desired.Status.Conditions, metav1.ConditionFalse, reasonBrandMismatch, reason)
		if err := r.updateStatusIfChanged(ctx, &env, desired); err != nil {
			return ctrl.Result{}, err
		}
		r.emitLifecycleTransition(&env, desired)
		return ctrl.Result{}, nil
	}
	if desiredGPUCount(&env) == 0 {
		setBrandMatchValidCondition(&desired.Status.Conditions, true, reasonNotApplicable, "no GPU requested; image brand not checked")
	} else {
		setBrandMatchValidCondition(&desired.Status.Conditions, true, reasonBrandValid, "gpuType matches the image brand")
	}

	// 1b. Notebook path gate: the controller owns the prefix a jupyter
	// environment's route publishes and has to be able to tell the notebook to
	// serve it. An environment that hides NOTEBOOK_ARGS behind a valueFrom
	// source cannot be told, so it is refused like a brand mismatch rather than
	// published with an address that 404s — nothing is provisioned, and an
	// environment that was running is withdrawn.
	if reason := unsupportedNotebookArgsReason(&env); reason != "" {
		if err := r.stopCompute(ctx, &env); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.deleteRoutes(ctx, &env); err != nil {
			return ctrl.Result{}, err
		}
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionPodScheduled)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionRouteReady)
		desired.Status.Endpoints = nil
		setPhase(&desired.Status, aiv1alpha1.PhaseFailed, reasonNotebookArgsUnusable)
		setDevEnvironmentReadyCondition(&desired.Status.Conditions, metav1.ConditionFalse, reasonNotebookArgsUnusable, reason)
		if err := r.updateStatusIfChanged(ctx, &env, desired); err != nil {
			return ctrl.Result{}, err
		}
		r.emitLifecycleTransition(&env, desired)
		return ctrl.Result{}, nil
	}

	// 2. SSH secrets: a managed host keypair and the authorized_keys source when
	// SSH is exposed (design §6.3).
	if sshExposed(&env) {
		keysSecret, digest, err := r.reconcileSSHSecrets(ctx, &env)
		if err != nil {
			return ctrl.Result{}, err
		}
		desired.Status.SSHKeysSecret = keysSecret
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
		desired.Status.SSHKeysSecret = nil
	}

	// 2b. Jupyter token secret: a random per-environment token guarding the web
	// path, injected into the workload as JUPYTER_TOKEN (design §6.3). It is
	// reconciled before the core resources so a pod never references a missing
	// Secret.
	if env.Spec.Type == aiv1alpha1.DevEnvironmentTypeJupyter {
		digest, err := r.reconcileJupyterAuthSecret(ctx, &env)
		if err != nil {
			return ctrl.Result{}, err
		}
		// Named through the same helper the workload's SecretKeyRef uses, so the
		// status and the injected JUPYTER_TOKEN cannot point at different Secrets.
		desired.Status.JupyterAuthSecret = &corev1.SecretReference{Name: authSecretName(&env), Namespace: env.Namespace}
		// Carry the token revision to applyStatefulSet below. env is re-fetched
		// every reconcile and only its status is persisted, so this in-memory
		// annotation never lands on the DevEnvironment object; it only drives the
		// pod-template annotation and stsSpecHash (see desiredStatefulSet).
		if env.Annotations == nil {
			env.Annotations = map[string]string{}
		}
		env.Annotations[jupyterTokenRevisionAnnotationKey] = digest
	} else {
		desired.Status.JupyterAuthSecret = nil
	}

	// 3. Core resources.
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

	if err := r.updateStatusIfChanged(ctx, &env, desired); err != nil {
		return ctrl.Result{}, err
	}
	r.emitLifecycleTransition(&env, desired)
	return ctrl.Result{}, nil
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
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: sshAuthorizedKeysSecretName(env), Namespace: env.Namespace}},
		// The pre-split bundled Secret: nothing creates it any more, but an
		// environment created before the split still has one.
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: sshLegacySecretName(env), Namespace: env.Namespace}},
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: authSecretName(env), Namespace: env.Namespace}},
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
		Watches(&corev1.Secret{}, handler.EnqueueRequestsFromMapFunc(r.enqueueForDevEnvKeysSecret)).
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

// enqueueForDevEnvKeysSecret maps a Secret to the DevEnvironments that reference
// it as their authorized_keys source (spec.ssh.keysSecret), so editing it
// re-reconciles them: the pod's volume is an ordinary Secret mount and kubelet
// delivers the new bytes on its own, but the reconcile is what re-checks the
// reference (the Secret may have been undelegated or had the entry removed since)
// and reports it. The reference is same-namespace (corev1.SecretKeySelector), so
// Secrets in other namespaces short-circuit cheaply.
func (r *DevEnvironmentReconciler) enqueueForDevEnvKeysSecret(ctx context.Context, obj client.Object) []reconcile.Request {
	secret := obj.(*corev1.Secret)
	list := &aiv1alpha1.DevEnvironmentList{}
	if err := r.List(ctx, list, client.InNamespace(secret.Namespace)); err != nil {
		return nil
	}
	reqs := make([]reconcile.Request, 0)
	for i := range list.Items {
		env := &list.Items[i]
		if env.Spec.SSH == nil || env.Spec.SSH.KeysSecret == nil || env.Spec.SSH.KeysSecret.Name != secret.Name {
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

// brandMismatchReason returns a non-empty message when gpuType does not match
// the image brand: nvidia <-> base-cuda and metax <-> base-maca (design §4.2).
// Custom images must carry their brand marker in the name (P1 baseline). An
// environment that requests no GPU has no brand to match, so it is exempt —
// which is what lets a CPU-only environment run a CPU image.
func brandMismatchReason(env *aiv1alpha1.DevEnvironment) string {
	if desiredGPUCount(env) == 0 {
		return ""
	}
	image := strings.ToLower(env.Spec.Image)
	switch env.Spec.Resources.GPUType {
	case aiv1alpha1.GPUTypeNVIDIA:
		if !strings.Contains(image, "base-cuda") {
			return fmt.Sprintf("image %q does not match gpuType nvidia (expected a base-cuda image); set spec.resources.gpuCount: 0 for a CPU-only environment", env.Spec.Image)
		}
	case aiv1alpha1.GPUTypeMetaX:
		if !strings.Contains(image, "base-maca") {
			return fmt.Sprintf("image %q does not match gpuType metax (expected a base-maca image); set spec.resources.gpuCount: 0 for a CPU-only environment", env.Spec.Image)
		}
	}
	return ""
}

// sshExposed reports whether SSH access is exposed: the ssh container type is
// always SSH; other types only when spec.ssh.enabled (design §6.1).
func sshExposed(env *aiv1alpha1.DevEnvironment) bool {
	if env.Spec.Type == aiv1alpha1.DevEnvironmentTypeSSH {
		return true
	}
	return env.Spec.SSH != nil && env.Spec.SSH.Enabled
}

// l4Exposed reports whether the environment declares any L4 exposure, i.e.
// whether it draws a port from the pool. It is the guard for every use of the
// TCPRoute, UDPRoute and ListenerSet kinds: each arrives with its own CRD, and
// an environment that exposes nothing on L4 must still publish its HTTPRoute in
// an install that carries none of them.
//
// It mirrors the allocation loop in publishRoutes exactly — the two must agree
// on what counts as L4 exposure, so a change there belongs here too.
func l4Exposed(env *aiv1alpha1.DevEnvironment) bool {
	if sshExposed(env) {
		return true
	}
	for _, p := range env.Spec.Ports {
		if p.Type == aiv1alpha1.PortTypeTCP || p.Type == aiv1alpha1.PortTypeUDP {
			return true
		}
	}
	return false
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
	return env.Spec.SSH.KeysSecret
}

// sshAuthorizedKeysSource is the name and data key of the Secret the pod mounts
// as /run/ssh/authorized_keys: the user's delegated Secret when the spec names
// one, at the data key its selector names, else the controller-generated
// <env>-ssh-authorized-keys at sshClientPubKeyKey — the login keypair's public
// half, which is the key that actually logs in.
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
	return sshAuthorizedKeysSecretName(env), sshClientPubKeyKey
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

// desiredGPUCount resolves the requested accelerator count. A nil count means
// the field was never defaulted — a Go-constructed object — which the API
// server would have set to 1.
func desiredGPUCount(env *aiv1alpha1.DevEnvironment) int32 {
	if env.Spec.Resources.GPUCount == nil {
		return 1
	}
	return *env.Spec.Resources.GPUCount
}

// gpuResource is the GPU extended resource by vendor (design §8.1).
func gpuResource(t aiv1alpha1.GPUType) corev1.ResourceName {
	if t == aiv1alpha1.GPUTypeMetaX {
		return "metax-tech.com/gpu"
	}
	return "nvidia.com/gpu"
}

// desiredResources maps the requested compute to container resources: the GPU
// is both requested and limited; CPU/memory are limits only (design §3.2.2).
// A GPUCount of 0 asks for no accelerator, so the vendor resource is left out
// entirely rather than requested at zero — a zero request would still pin the
// pod to a node advertising that resource.
func desiredResources(env *aiv1alpha1.DevEnvironment) corev1.ResourceRequirements {
	limits := corev1.ResourceList{}
	requests := corev1.ResourceList{}
	if count := desiredGPUCount(env); count > 0 {
		gpuName := gpuResource(env.Spec.Resources.GPUType)
		gpu := resource.NewQuantity(int64(count), resource.DecimalSI)
		limits[gpuName] = *gpu
		requests[gpuName] = *gpu
	}
	if env.Spec.Resources.CPU != "" {
		limits[corev1.ResourceCPU] = resource.MustParse(env.Spec.Resources.CPU)
	}
	if env.Spec.Resources.Memory != "" {
		limits[corev1.ResourceMemory] = resource.MustParse(env.Spec.Resources.Memory)
	}
	return corev1.ResourceRequirements{Limits: limits, Requests: requests}
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
// NET_BIND_SERVICE — so a namespace hosting DevEnvironments has to be at
// Baseline, where these three are among the capabilities that remain allowed.
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
				Drop: []corev1.Capability{"ALL"},
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
// token carried from reconcileJupyterAuthSecret via env.Annotations (in-memory
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
// else the platform default.
func runtimeUser(env *aiv1alpha1.DevEnvironment) string {
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
		kept := slices.DeleteFunc(strings.Fields(v.Value), func(arg string) bool {
			return strings.HasPrefix(arg, notebookBaseURLFlag)
		})
		envVars[i].Value = strings.TrimSpace(strings.Join(append(kept, notebookBaseURLFlag+path), " "))
		return envVars
	}
	return append(envVars, corev1.EnvVar{Name: notebookArgsEnv, Value: notebookBaseURLFlag + path})
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

// desiredStatefulSet renders the environment StatefulSet: replicas 1/0 from
// spec.running, the workspace volumeClaimTemplate, and PVC retention. The
// workspace PVC's lifecycle belongs to the StatefulSet: it creates the claim
// from the template and, per whenDeleted, removes it when the StatefulSet is
// deleted — so the controller neither creates nor deletes workspace claims.
func (r *DevEnvironmentReconciler) desiredStatefulSet(env *aiv1alpha1.DevEnvironment) *appsv1.StatefulSet {
	replicas := int32(0)
	if env.Spec.Running {
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

// desiredPodSpec renders the pod spec: compute-pool nodeSelector, the main
// container with the workspace and data volume mounts, the SSH keys volume, and —
// when the environment has its own storage — the init container that makes that
// storage writable (::desiredPermissionInitContainer).
func (r *DevEnvironmentReconciler) desiredPodSpec(env *aiv1alpha1.DevEnvironment) corev1.PodSpec {
	mainPort := mainContainerPort(env.Spec.Type)
	container := corev1.Container{
		Name:            string(env.Spec.Type),
		Image:           env.Spec.Image,
		Resources:       desiredResources(env),
		SecurityContext: desiredSecurityContext(env.Spec.Runtime),
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
		// <env>-auth Secret surfaced to the owner, so a user-supplied entry is
		// dropped and the injected secretKeyRef always wins (a user override
		// would bypass the token the owner is told about).
		envVars = slices.DeleteFunc(envVars, func(v corev1.EnvVar) bool { return v.Name == jupyterTokenEnv })
		envVars = append(envVars, corev1.EnvVar{
			Name: jupyterTokenEnv,
			ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: authSecretName(env)},
					Key:                  jupyterTokenKey,
				},
			},
		})
		// Jupyter has to serve under the prefix its route publishes, and the
		// launcher only learns the prefix from NOTEBOOK_ARGS (design §6.4).
		envVars = withNotebookBaseURL(envVars, webPath(env))
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
		// never enters the container. DefaultMode stays 0644: the files are
		// root-owned and OpenSSH only enforces its private-key check on files owned
		// by the uid reading them, so a tighter mode would make a non-root sshd exit
		// with "no hostkeys available".
		container.VolumeMounts = append(container.VolumeMounts,
			corev1.VolumeMount{
				Name: sshHostKeyVolumeName, MountPath: sshHostKeyPath, SubPath: sshHostKeyKey, ReadOnly: true,
			},
			corev1.VolumeMount{
				Name: sshAuthorizedKeysVolumeName, MountPath: sshAuthorizedKeysDir, ReadOnly: true,
			},
		)
	}

	podSpec := corev1.PodSpec{
		NodeSelector: map[string]string{computeNodePoolLabelKey: computeNodePoolValue},
		Containers:   []corev1.Container{container},
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
		mode := int32(0o644)
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
	return podSpec
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

// desiredService renders the ClusterIP Service with the main port, the SSH
// port (when exposed and not the main port), and the extra application ports.
func (r *DevEnvironmentReconciler) desiredService(env *aiv1alpha1.DevEnvironment) *corev1.Service {
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
	if sshExposed(env) && env.Spec.Type != aiv1alpha1.DevEnvironmentTypeSSH {
		ports = append(ports, corev1.ServicePort{Name: sshPortName, Port: sshServicePort, TargetPort: intstr.FromInt32(sshContainerPort), Protocol: corev1.ProtocolTCP})
	}
	for _, p := range env.Spec.Ports {
		// The Service port carries the protocol the exposure speaks: a UDPRoute
		// forwards to a UDP port, and the dataplane reaches the container over
		// that same one. A udp port that stayed TCP here would be accepted and
		// then forward nothing, since a TCP Service port does not listen for
		// datagrams.
		ports = append(ports, corev1.ServicePort{Name: p.Name, Port: p.ContainerPort, TargetPort: intstr.FromInt32(p.ContainerPort), Protocol: portProtocol(p)})
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
// whitelisted (design §9.1).
func (r *DevEnvironmentReconciler) desiredNetworkPolicy(env *aiv1alpha1.DevEnvironment) *networkingv1.NetworkPolicy {
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
			Egress: []networkingv1.NetworkPolicyEgressRule{
				{
					To: []networkingv1.NetworkPolicyPeer{{
						NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{namespaceNameLabel: "kube-system"}},
						PodSelector:       &metav1.LabelSelector{MatchLabels: map[string]string{"k8s-app": "kube-dns"}},
					}},
					Ports: []networkingv1.NetworkPolicyPort{
						{Protocol: &udp, Port: &dnsPort},
						{Protocol: &tcp, Port: &dnsPort},
					},
				},
			},
		},
	}
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
	np := r.desiredNetworkPolicy(env)
	if err := ctrl.SetControllerReference(env, np, r.Scheme); err != nil {
		return err
	}
	existing := &networkingv1.NetworkPolicy{}
	err := r.Get(ctx, client.ObjectKey{Name: np.Name, Namespace: np.Namespace}, existing)
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

// applyStatefulSet creates or updates the StatefulSet. The pod template is
// compared by the stsSpecHash annotation rather than DeepEqual because the
// API server defaults many template fields; an update is only needed when the
// desired template or the replicas change.
func (r *DevEnvironmentReconciler) applyStatefulSet(ctx context.Context, env *aiv1alpha1.DevEnvironment) error {
	sts := r.desiredStatefulSet(env)
	sts.Annotations = map[string]string{stsSpecHashAnnotationKey: stsSpecHash(env)}
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
func stsSpecHash(env *aiv1alpha1.DevEnvironment) string {
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
	}
	h := sha256.New()
	h.Write(mustJSON(templateInput{
		Type:                 env.Spec.Type,
		Image:                env.Spec.Image,
		Resources:            env.Spec.Resources,
		Runtime:              env.Spec.Runtime,
		Storage:              env.Spec.Storage,
		Volumes:              env.Spec.Volumes,
		SSHExposed:           sshExposed(env),
		JupyterTokenRevision: env.Annotations[jupyterTokenRevisionAnnotationKey],
		SSHKeysRevision:      env.Annotations[sshKeysRevisionAnnotationKey],
		SSHMount:             sshMountKey(env),
	}))
	return fmt.Sprintf("sha256:%x", h.Sum(nil))
}

// reconcileSSHSecrets ensures both halves of the environment's ssh material
// exist and returns the status ref alongside the host key's digest.
//
// The material is two Secrets because it is two things with different owners:
// the host identity, which is the platform's and never leaves the cluster, and
// the authorized keys, which are the user's credential. When the spec names a
// delegated keys Secret the controller mints the host key only and that Secret
// is mounted as-is; otherwise it mints a login keypair too, so the environment's
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
	if sshUserKeysRef(env) != nil {
		if err := r.checkUserAuthorizedKeys(ctx, env); err != nil {
			return nil, "", err
		}
	}
	hostKey, err := r.reconcileSSHHostKeySecret(ctx, env)
	if err != nil {
		return nil, "", err
	}
	if sshUserKeysRef(env) == nil {
		if err := r.reconcileSSHAuthorizedKeysSecret(ctx, env); err != nil {
			return nil, "", err
		}
	}
	// Only the Secret is recorded: status names it, and the field's own doc says
	// which entries either case puts in it. Going through the same source the pod
	// does is what keeps the two from naming different Secrets.
	name, _ := sshAuthorizedKeysSource(env)
	ref := &corev1.SecretReference{Name: name, Namespace: env.Namespace}
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
	// has to be in place first. reconcileJupyterAuthSecret needs the same guard
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

// reconcileSSHAuthorizedKeysSecret ensures the generated
// <env>-ssh-authorized-keys Secret carries a login keypair: the private half the
// environment's owner retrieves from status.sshKeysSecret, and the public half
// the workload mounts as authorized_keys. Like the host key the keypair is minted
// once and kept, so a key its owner has already downloaded keeps working; only
// one sshd could not read sends it back to generation.
//
// The public half is mounted from here rather than from a copy of it under
// another name, so the entry the user reads and the entry that authorizes them
// cannot drift apart, and there is no second entry that looks editable and is
// not. A change here needs no revision: the pod's volume is an ordinary Secret
// mount, which kubelet updates in place.
func (r *DevEnvironmentReconciler) reconcileSSHAuthorizedKeysSecret(ctx context.Context, env *aiv1alpha1.DevEnvironment) error {
	name := sshAuthorizedKeysSecretName(env)
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

// sshAuthorizedKeysSecretName is the managed Secret <env>-ssh-authorized-keys,
// created only when the environment supplies no keys of its own: it carries the
// generated login keypair and the authorized_keys entry the workload mounts.
func sshAuthorizedKeysSecretName(env *aiv1alpha1.DevEnvironment) string {
	return env.Name + "-ssh-authorized-keys"
}

// sshLegacySecretName is the pre-split Secret <env>-ssh-keys, which bundled the
// host keypair and authorized_keys together. Nothing creates or updates it any
// more: it survives only as the host-key migration source and as a cleanup
// target for environments created before the split.
func sshLegacySecretName(env *aiv1alpha1.DevEnvironment) string {
	return env.Name + "-ssh-keys"
}

// authSecretName is the name of the managed Jupyter token Secret <env>-auth.
func authSecretName(env *aiv1alpha1.DevEnvironment) string {
	return env.Name + "-auth"
}

// reconcileJupyterAuthSecret creates or updates the managed Jupyter token Secret
// <env>-auth (design §6.3): a random token generated once under the data key
// jupyterTokenKey. The token is never rotated — an existing non-empty token is
// kept so the surfaced token stays valid — but a missing or emptied key is
// refilled so the workload's JUPYTER_TOKEN env var always resolves. The Secret
// is removed together with the environment in cleanup.
//
// It returns the non-sensitive digest of the token in effect (created, refilled,
// or already present) so the caller can record a token revision on the pod
// template: JUPYTER_TOKEN is read at container start, so a refill must roll the
// workload for the new token to take effect (see stsSpecHash).
func (r *DevEnvironmentReconciler) reconcileJupyterAuthSecret(ctx context.Context, env *aiv1alpha1.DevEnvironment) (string, error) {
	name := authSecretName(env)
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
func (r *DevEnvironmentReconciler) reconcileGatewayRoutes(ctx context.Context, env *aiv1alpha1.DevEnvironment, status *aiv1alpha1.DevEnvironmentStatus) error {
	cfg := r.defaultedConfig()
	gw := &gatewayv1.Gateway{}
	err := r.Get(ctx, types.NamespacedName{Namespace: cfg.GatewayNamespace, Name: cfg.GatewayName}, gw)
	switch {
	case meta.IsNoMatchError(err):
		setDevEnvironmentRouteReadyCondition(&status.Conditions, false, reasonGatewayAPINotInstalled, "Gateway API CRDs are not installed")
		return nil
	case apierrors.IsNotFound(err):
		setDevEnvironmentRouteReadyCondition(&status.Conditions, false, reasonGatewayNotFound, fmt.Sprintf("Gateway %s/%s not found", cfg.GatewayNamespace, cfg.GatewayName))
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
		if sshExposed(env) {
			p := r.allocatePort(env, sshPortName, used)
			if p == 0 {
				return nil, nil, nil, fmt.Errorf("no free port in the L4 port range %d-%d", cfg.L4PortRangeStart, cfg.L4PortRangeEnd)
			}
			ports[sshPortName] = p
		}
		for _, sp := range env.Spec.Ports {
			// tcp and udp are the pool's two protocols and share its numbering:
			// the allocator keys on the port alone, so one number serves one
			// protocol for one environment (design §8.3).
			if sp.Type != aiv1alpha1.PortTypeTCP && sp.Type != aiv1alpha1.PortTypeUDP {
				continue
			}
			p := r.allocatePort(env, sp.Name, used)
			if p == 0 {
				return nil, nil, nil, fmt.Errorf("no free port in the L4 port range %d-%d", cfg.L4PortRangeStart, cfg.L4PortRangeEnd)
			}
			ports[sp.Name] = p
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

// allocatePort picks a port for the named endpoint, reusing the env's own
// recorded listener port when it is still free (stable across restarts) and
// otherwise the lowest free port in the configured range. The record is
// status.endpoints[].listenerPort rather than the port in that endpoint's
// address, which says where the endpoint is reachable, not which pool port the
// environment holds.
func (r *DevEnvironmentReconciler) allocatePort(env *aiv1alpha1.DevEnvironment, name string, used map[int32]bool) int32 {
	cfg := r.defaultedConfig()
	for _, ep := range env.Status.Endpoints {
		if ep.Name == name {
			if p := ep.ListenerPort; p >= cfg.L4PortRangeStart && p <= cfg.L4PortRangeEnd && !used[p] {
				used[p] = true
				return p
			}
		}
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
			Name:     gatewayv1.SectionName(l4ListenerName(protocol, ports[name])),
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
				listenerSetParentRef(env, corev1.ProtocolTCP, port),
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
				listenerSetParentRef(env, corev1.ProtocolUDP, port),
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

// l4ListenerName names one listener within the ListenerSet. Listener names only
// have to be unique within their ListenerSet, and an allocated port is unique
// across the whole gateway, so spelling the port keeps them distinct without a
// second naming scheme; the protocol prefix is there so a reader can tell a
// datagram port from a stream one without checking the listener's protocol
// field.
func l4ListenerName(protocol gatewayv1.ProtocolType, port int32) string {
	return fmt.Sprintf("%s-%d", strings.ToLower(string(protocol)), port)
}

// listenerSetParentRef points a route at one listener of the environment's
// ListenerSet. The ListenerSet lives in the environment's namespace, so unlike
// gatewayParentRef this resolves without fetching anything. As there, the
// explicit defaults are set so the stored spec compares equal across
// reconciles.
func listenerSetParentRef(env *aiv1alpha1.DevEnvironment, protocol corev1.Protocol, port int32) gatewayv1.ParentReference {
	listenerProtocol, _ := l4ListenerFor(protocol)
	return gatewayv1.ParentReference{
		Group:       ptr(gatewayv1.Group(gatewayAPIGroup)),
		Kind:        ptr(gatewayv1.Kind(listenerSetKind)),
		Namespace:   ptr(gatewayv1.Namespace(env.Namespace)),
		Name:        gatewayv1.ObjectName(listenerSetName(env)),
		SectionName: ptr(gatewayv1.SectionName(l4ListenerName(listenerProtocol, port))),
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

// setBrandMatchValidCondition sets the BrandMatchValid condition.
func setBrandMatchValidCondition(conditions *[]metav1.Condition, valid bool, reason, message string) {
	status := metav1.ConditionTrue
	if !valid {
		status = metav1.ConditionFalse
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type: aiv1alpha1.ConditionBrandMatchValid, Status: status, Reason: reason, Message: message,
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
			r.Recorder.Eventf(env, nil, corev1.EventTypeNormal, eventReasonStopped, eventReasonStopped,
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
		cfg.GatewayNamespace = systemNamespace
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
	return cfg
}
