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
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gateways,verbs=get;list;watch

package controller

import (
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
	// pods run in, which is where its traffic to an environment originates. It
	// is not GatewayNamespace: the Gateway object and its Envoy dataplane are
	// separate deployments and Envoy Gateway places the latter in its own
	// namespace. Empty disables the ingress allowance in desiredNetworkPolicy,
	// leaving environments at the default-deny floor.
	GatewayDataplaneNamespace string
	// GatewayIP is a static fallback address used when the Gateway has no
	// status address yet.
	GatewayIP string
	// HTTPPort is the Gateway's HTTP listener port used in published URLs.
	HTTPPort int32
	// SSHPortRangeStart is the first port of the Gateway's static TCP listener
	// pool allocated per environment (design §6.2).
	SSHPortRangeStart int32
	// SSHPortRangeEnd is the last port of the Gateway's static TCP listener pool.
	SSHPortRangeEnd int32
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
	reasonPublished              = "Published"
	reasonGatewayNotFound        = "GatewayNotFound"
	reasonGatewayNotReady        = "GatewayNotReady"
	reasonGatewayAPINotInstalled = "GatewayAPINotInstalled"
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

	// Gateway API well-known names used in route specs.
	gatewayAPIGroup = "gateway.networking.k8s.io"
	gatewayKind     = "Gateway"
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
	sshPortName       = "ssh"
	mainPortName      = "main"
	sshKeysVolumeName = "ssh-keys"

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
	sshHostKeyPath        = "/etc/ssh/ssh_host_ed25519_key"
	sshAuthorizedKeysPath = "/run/ssh/authorized_keys"

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

	// jupyterTokenRevisionAnnotationKey records a non-sensitive sha256 digest of
	// the managed Jupyter token on the StatefulSet pod template. JUPYTER_TOKEN
	// is read from the Secret at container start, so a refilled token must roll
	// the pod; the digest makes the template (and stsSpecHash) change when the
	// token is created or refilled without ever putting the plaintext on the pod.
	jupyterTokenRevisionAnnotationKey = "ai.cubestack.io/jupyter-token-revision"

	// sshKeysRevisionAnnotationKey records a non-sensitive digest of the ssh
	// material mounted into the pod on the StatefulSet pod template. The mounts
	// are subPath, and Kubernetes does not propagate Secret updates into those,
	// so a rotated authorized_keys is inert until the pod is recreated; the
	// digest makes the template (and stsSpecHash) change when the Secret's
	// content does, which rolls the workload onto it.
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

	// 2. SSH secret: a managed host keypair + authorized_keys when SSH is
	// exposed (design §6.3).
	if sshExposed(&env) {
		keysSecret, digest, err := r.reconcileSSHSecret(ctx, &env)
		if err != nil {
			return ctrl.Result{}, err
		}
		desired.Status.SSHKeysSecret = keysSecret
		// Carry the key revision to applyStatefulSet below, like the jupyter
		// token: the keys are subPath mounts, so only a roll picks up changed
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
		// Carry the token revision to applyStatefulSet below. env is re-fetched
		// every reconcile and only its status is persisted, so this in-memory
		// annotation never lands on the DevEnvironment object; it only drives the
		// pod-template annotation and stsSpecHash (see desiredStatefulSet).
		if env.Annotations == nil {
			env.Annotations = map[string]string{}
		}
		env.Annotations[jupyterTokenRevisionAnnotationKey] = digest
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
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: sshSecretName(env), Namespace: env.Namespace}},
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

// deleteRoutes removes the HTTPRoute and TCPRoutes created for the
// environment, looked up by label because TCPRoute names embed allocated
// ports. When the Gateway API CRDs are not installed, there is nothing to do.
func (r *DevEnvironmentReconciler) deleteRoutes(ctx context.Context, env *aiv1alpha1.DevEnvironment) error {
	opts := []client.ListOption{client.InNamespace(env.Namespace), client.MatchingLabels{devEnvironmentLabelKey: env.Name}}
	var hrs gatewayv1.HTTPRouteList
	if err := r.List(ctx, &hrs, opts...); err != nil {
		if meta.IsNoMatchError(err) {
			return nil
		}
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
	if err := r.List(ctx, &trs, opts...); err != nil {
		if meta.IsNoMatchError(err) {
			return nil
		}
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
	return nil
}

// SetupWithManager registers the DevEnvironment watch, the owned resources,
// and the label-based Pod/PVC watches (the pod and workspace PVC are owned by
// the StatefulSet, not the environment). Gateway watches are added only when
// the Gateway API CRDs are installed, since a missing CRD would fail the cache.
func (r *DevEnvironmentReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if r.Recorder == nil {
		r.Recorder = mgr.GetEventRecorder(devEnvManagedByValue)
	}
	builder := ctrl.NewControllerManagedBy(mgr).
		For(&aiv1alpha1.DevEnvironment{}).
		Owns(&appsv1.StatefulSet{}).
		Owns(&corev1.Service{}).
		Owns(&networkingv1.NetworkPolicy{}).
		Owns(&corev1.Secret{}).
		Watches(&corev1.Pod{}, handler.EnqueueRequestsFromMapFunc(r.enqueueForDevEnv)).
		Watches(&corev1.Secret{}, handler.EnqueueRequestsFromMapFunc(r.enqueueForDevEnvKeysSecret)).
		Watches(&aiv1alpha1.DevEnvironment{}, handler.EnqueueRequestsFromMapFunc(r.enqueueAllDevEnvironments))
	if gatewayAPICRDsInstalled(mgr) {
		builder.Owns(&gatewayv1.HTTPRoute{}).
			Owns(&gatewayv1.TCPRoute{}).
			Watches(&gatewayv1.Gateway{}, handler.EnqueueRequestsFromMapFunc(r.enqueueAllDevEnvironments))
	}
	return builder.Complete(r)
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
// it as their authorized_keys source (spec.ssh.keysSecret): rotating the user
// keys Secret re-reconciles the referencing environment so the managed SSH
// secret's authorized_keys content refreshes. The reference is same-namespace
// (corev1.SecretKeySelector), so Secrets in other namespaces short-circuit
// cheaply.
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

// gatewayAPICRDsInstalled reports whether the Gateway API CRDs are present,
// so the manager only watches Gateway routes when the API is available.
func gatewayAPICRDsInstalled(mgr ctrl.Manager) bool {
	_, err := mgr.GetRESTMapper().RESTMapping(
		schema.GroupKind{Group: gatewayv1.GroupName, Kind: gatewayKind}, gatewayv1.GroupVersion.Version)
	return err == nil
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

// sshKeysPodAnnotations is jupyterTokenPodAnnotations for the ssh material: the
// digest carried from reconcileSSHSecret via env.Annotations (in-memory only,
// never persisted on the DevEnvironment) changes the pod template — and so
// stsSpecHash — whenever the mounted Secret bytes change, which is the only way
// a subPath mount ever picks them up. It also rolls the workload once on upgrade
// from a controller that stamped no revision at all.
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
		// chmod (images/README.md) — so the Secret's keys are mounted as files
		// with subPath: the host key where sshd looks for its identity, and the
		// platform keys at the absolute path the images' AuthorizedKeysFile names.
		// Neither needs a directory to exist in the image: the runtime creates a
		// file mount target's parent. DefaultMode stays 0644: the files are
		// root-owned and OpenSSH only enforces its private-key check on files owned
		// by the uid reading them, so a tighter mode would make a non-root sshd
		// exit with "no hostkeys available".
		container.VolumeMounts = append(container.VolumeMounts,
			corev1.VolumeMount{
				Name: sshKeysVolumeName, MountPath: sshHostKeyPath, SubPath: sshHostKeyKey, ReadOnly: true,
			},
			corev1.VolumeMount{
				Name: sshKeysVolumeName, MountPath: sshAuthorizedKeysPath,
				SubPath: sshAuthorizedKeysKey, ReadOnly: true,
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
		podSpec.Volumes = append(podSpec.Volumes, corev1.Volume{
			Name: sshKeysVolumeName,
			VolumeSource: corev1.VolumeSource{
				Secret: &corev1.SecretVolumeSource{SecretName: sshSecretName(env), DefaultMode: &mode},
			},
		})
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
		if p.Type == aiv1alpha1.PortTypeUDP {
			continue // UDP exposure is deferred
		}
		ports = append(ports, corev1.ServicePort{Name: p.Name, Port: p.ContainerPort, TargetPort: intstr.FromInt32(p.ContainerPort), Protocol: corev1.ProtocolTCP})
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
		// SSHKeysRevision is the equivalent digest for the ssh material the pod
		// mounts as subPath files, which never see a Secret update in place.
		SSHKeysRevision string
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
	}))
	return fmt.Sprintf("sha256:%x", h.Sum(nil))
}

// reconcileSSHSecret creates or updates the managed SSH secret holding the
// ed25519 host keypair and the authorized_keys content assembled from
// spec.ssh.keysSecret. The host keypair is generated once and not rotated
// (design §6.3), except to replace one sshd cannot read; authorized_keys is
// refreshed when the user's keys change.
//
// It returns the non-sensitive digest of the mounted material alongside the
// key selector, so the caller can record a revision on the pod template: the
// pod reads the Secret through subPath mounts, which never see an update in
// place, so refreshed authorized_keys only reach it when the workload rolls
// (see sshKeysPodAnnotations).
func (r *DevEnvironmentReconciler) reconcileSSHSecret(ctx context.Context, env *aiv1alpha1.DevEnvironment) (*corev1.SecretKeySelector, string, error) {
	name := sshSecretName(env)
	authorized, err := r.userAuthorizedKeys(ctx, env)
	if err != nil {
		return nil, "", err
	}
	selector := &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: name}, Key: sshAuthorizedKeysKey}

	secret := &corev1.Secret{}
	err = r.Get(ctx, types.NamespacedName{Namespace: env.Namespace, Name: name}, secret)
	if apierrors.IsNotFound(err) {
		privPEM, pubOpenSSH, err := generateSSHKeyPair()
		if err != nil {
			return nil, "", err
		}
		desired := &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: env.Namespace, Labels: r.envLabels(env.Name)},
			Type:       corev1.SecretTypeOpaque,
			Data: map[string][]byte{
				sshHostKeyKey:        privPEM,
				sshHostPubKeyKey:     pubOpenSSH,
				sshAuthorizedKeysKey: []byte(authorized),
			},
		}
		if err := ctrl.SetControllerReference(env, desired, r.Scheme); err != nil {
			return nil, "", err
		}
		if err := r.Create(ctx, desired); err != nil {
			return nil, "", err
		}
		return selector, sshKeysDigest(desired), nil
	}
	if err != nil {
		return nil, "", err
	}
	if err := ensureDevEnvOwned(secret, env); err != nil {
		return nil, "", err
	}
	// A managed Secret can exist without carrying any data — created by hand, or
	// emptied by hand — and both repairs below write into its map, so an empty map
	// has to be in place first. reconcileJupyterAuthSecret needs the same guard
	// for its token.
	changed := false
	if secret.Data == nil {
		secret.Data = map[string][]byte{}
	}
	if hostKeyUnreadable(secret.Data[sshHostKeyKey]) {
		privPEM, pubOpenSSH, err := generateSSHKeyPair()
		if err != nil {
			return nil, "", err
		}
		secret.Data[sshHostKeyKey] = privPEM
		secret.Data[sshHostPubKeyKey] = pubOpenSSH
		changed = true
	}
	// The key has to be written even when authorized is empty: the pod mounts it
	// by subPath, and a key that is missing from the Secret — rather than present
	// and empty — leaves the mount with nothing to resolve, so the environment
	// never starts. This is the shape Create already gives it.
	if cur, ok := secret.Data[sshAuthorizedKeysKey]; !ok || string(cur) != authorized {
		secret.Data[sshAuthorizedKeysKey] = []byte(authorized)
		changed = true
	}
	if changed {
		if err := r.Update(ctx, secret); err != nil {
			return nil, "", err
		}
	}
	return selector, sshKeysDigest(secret), nil
}

// sshKeysDigest hashes the Secret content the pod mounts — the host key and the
// platform authorized_keys — into the non-sensitive revision recorded on the
// pod template. The host key never rotates in place (design §6.3), but a Secret
// deleted and regenerated mints a new one, and that must roll the pod too.
func sshKeysDigest(secret *corev1.Secret) string {
	return assetDataHash(map[string]string{
		sshHostKeyKey:        string(secret.Data[sshHostKeyKey]),
		sshAuthorizedKeysKey: string(secret.Data[sshAuthorizedKeysKey]),
	})
}

func sshSecretName(env *aiv1alpha1.DevEnvironment) string {
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

// userAuthorizedKeys reads the multi-line public keys from spec.ssh.keysSecret
// (data key "keys" by default, per the design's sample CR) into authorized_keys
// content. It returns "" when no keysSecret is referenced.
func (r *DevEnvironmentReconciler) userAuthorizedKeys(ctx context.Context, env *aiv1alpha1.DevEnvironment) (string, error) {
	if env.Spec.SSH == nil || env.Spec.SSH.KeysSecret == nil {
		return "", nil
	}
	ks := env.Spec.SSH.KeysSecret
	key := ks.Key
	if key == "" {
		key = sshUserKeysDefaultKey
	}
	s := &corev1.Secret{}
	if err := r.Get(ctx, types.NamespacedName{Namespace: env.Namespace, Name: ks.Name}, s); err != nil {
		return "", err
	}
	// Only a Secret that explicitly delegates itself may back authorized_keys:
	// copying data from an undelegated Secret would let an environment creator
	// read any same-namespace Secret through the managed SSH secret that the
	// workload mounts.
	if s.Labels[devEnvSSHKeysDelegatedLabel] != devEnvSSHKeysDelegatedValue {
		return "", fmt.Errorf("secret %s/%s is not delegated for SSH keys: missing label %q", env.Namespace, ks.Name, devEnvSSHKeysDelegatedLabel)
	}
	return string(s.Data[key]), nil
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

	ports, err := r.publishRoutes(ctx, env, gw)
	if err != nil {
		setDevEnvironmentRouteReadyCondition(&status.Conditions, false, reasonRouteCreateFailed, err.Error())
		return nil
	}

	gwIP := gatewayIP(gw, cfg)
	if gwIP == "" {
		setDevEnvironmentRouteReadyCondition(&status.Conditions, false, reasonGatewayNotReady, "Gateway has no assigned address")
		status.Endpoints = nil
		return nil
	}
	setDevEnvironmentRouteReadyCondition(&status.Conditions, true, reasonPublished, "Routes are published on the gateway")
	r.buildEndpoints(env, status, gwIP, ports)
	return nil
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

// publishRoutes allocates the SSH and extra TCP ports, then applies the
// HTTPRoute and one TCPRoute per allocated port. The returned map is keyed by
// endpoint name and drives buildEndpoints.
func (r *DevEnvironmentReconciler) publishRoutes(ctx context.Context, env *aiv1alpha1.DevEnvironment, gw *gatewayv1.Gateway) (map[string]int32, error) {
	cfg := r.defaultedConfig()
	used := r.usedPorts(ctx, env.Namespace, env.Name)
	ports := map[string]int32{}
	if sshExposed(env) {
		p := r.allocatePort(env, sshPortName, used)
		if p == 0 {
			return nil, fmt.Errorf("no free port in the SSH port range %d-%d", cfg.SSHPortRangeStart, cfg.SSHPortRangeEnd)
		}
		ports[sshPortName] = p
	}
	for _, sp := range env.Spec.Ports {
		if sp.Type != aiv1alpha1.PortTypeTCP {
			continue
		}
		p := r.allocatePort(env, sp.Name, used)
		if p == 0 {
			return nil, fmt.Errorf("no free port in the SSH port range %d-%d", cfg.SSHPortRangeStart, cfg.SSHPortRangeEnd)
		}
		ports[sp.Name] = p
	}

	// Drop routes for exposures removed since the last reconcile: the loop
	// above no longer allocates their ports, but the old TCPRoute would keep
	// claiming the Gateway listener and block reuse of the freed port.
	if err := r.pruneTCPRoutes(ctx, env, ports); err != nil {
		return nil, err
	}

	if env.Spec.Type != aiv1alpha1.DevEnvironmentTypeSSH || hasHTTPPorts(env) {
		if err := r.applyHTTPRoute(ctx, env, gw); err != nil {
			return nil, err
		}
	}
	for name, port := range ports {
		if err := r.applyTCPRoute(ctx, env, gw, name, port); err != nil {
			return nil, err
		}
	}
	return ports, nil
}

// pruneTCPRoutes deletes this environment's TCPRoutes whose allocated port is
// no longer in the desired set — i.e. when an SSH or extra TCP exposure was
// removed from the spec. Route names embed the allocated port, so the desired
// set is matched by port; a leftover route would keep claiming the Gateway
// listener and block reuse of the freed port by another environment.
func (r *DevEnvironmentReconciler) pruneTCPRoutes(ctx context.Context, env *aiv1alpha1.DevEnvironment, desired map[string]int32) error {
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
	return nil
}

// tcpRoutePort extracts the allocated listener port from a TCPRoute name of
// the form <env>-tcp-<port>.
func tcpRoutePort(name string) int32 {
	i := strings.LastIndex(name, "-tcp-")
	if i < 0 {
		return 0
	}
	n, err := strconv.Atoi(name[i+len("-tcp-"):])
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

// usedPorts collects every TCP port already allocated to another environment
// (the port pool is gateway-wide, so it spans namespaces).
func (r *DevEnvironmentReconciler) usedPorts(ctx context.Context, excludeNS, excludeName string) map[int32]bool {
	used := map[int32]bool{}
	list := &aiv1alpha1.DevEnvironmentList{}
	if err := r.List(ctx, list); err != nil {
		return used
	}
	for _, e := range list.Items {
		if e.Namespace == excludeNS && e.Name == excludeName {
			continue
		}
		for _, ep := range e.Status.Endpoints {
			if p := portFromEndpoint(ep.Address); p != 0 {
				used[p] = true
			}
		}
	}
	return used
}

// allocatePort picks a port for the named endpoint, reusing the env's own
// recorded port when it is still free (stable across restarts) and otherwise
// the lowest free port in the configured range.
func (r *DevEnvironmentReconciler) allocatePort(env *aiv1alpha1.DevEnvironment, name string, used map[int32]bool) int32 {
	cfg := r.defaultedConfig()
	for _, ep := range env.Status.Endpoints {
		if ep.Name == name {
			if p := portFromEndpoint(ep.Address); p != 0 && p >= cfg.SSHPortRangeStart && p <= cfg.SSHPortRangeEnd && !used[p] {
				used[p] = true
				return p
			}
		}
	}
	for p := cfg.SSHPortRangeStart; p <= cfg.SSHPortRangeEnd; p++ {
		if !used[p] {
			used[p] = true
			return p
		}
	}
	return 0
}

// portFromEndpoint extracts the trailing port from an endpoint address such as
// "1.2.3.4:20001" or "ssh://user@1.2.3.4:20001"; it returns 0 when the
// address has no parseable port.
func portFromEndpoint(addr string) int32 {
	i := strings.LastIndex(addr, ":")
	if i < 0 {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimRight(addr[i+1:], "/"))
	if err != nil {
		return 0
	}
	return int32(n)
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
				Value: ptr(fmt.Sprintf("/dev/%s/%s/", env.Namespace, env.Name)),
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

// desiredTCPRoute renders the TCPRoute for one allocated port: it attaches to
// the Gateway's static tcp-<port> listener and forwards to the matching
// Service port (design §6.2).
func (r *DevEnvironmentReconciler) desiredTCPRoute(env *aiv1alpha1.DevEnvironment, gw *gatewayv1.Gateway, name string, port int32) *gatewayv1.TCPRoute {
	return &gatewayv1.TCPRoute{
		ObjectMeta: metav1.ObjectMeta{Name: tcpRouteName(env, port), Namespace: env.Namespace, Labels: r.envLabels(env.Name)},
		Spec: gatewayv1.TCPRouteSpec{
			CommonRouteSpec: gatewayv1.CommonRouteSpec{ParentRefs: []gatewayv1.ParentReference{
				gatewayParentRef(gw, fmt.Sprintf("tcp-%d", port)),
			}},
			Rules: []gatewayv1.TCPRouteRule{{
				BackendRefs: []gatewayv1.BackendRef{serviceBackendRef(env.Name, servicePortFor(env, name))},
			}},
		},
	}
}

func tcpRouteName(env *aiv1alpha1.DevEnvironment, port int32) string {
	return fmt.Sprintf("%s-tcp-%d", env.Name, port)
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

// applyHTTPRoute creates or updates the HTTPRoute.
func (r *DevEnvironmentReconciler) applyHTTPRoute(ctx context.Context, env *aiv1alpha1.DevEnvironment, gw *gatewayv1.Gateway) error {
	desired := r.desiredHTTPRoute(env, gw)
	if err := ctrl.SetControllerReference(env, desired, r.Scheme); err != nil {
		return err
	}
	existing := &gatewayv1.HTTPRoute{}
	err := r.Get(ctx, client.ObjectKey{Name: desired.Name, Namespace: desired.Namespace}, existing)
	if apierrors.IsNotFound(err) {
		return r.Create(ctx, desired)
	}
	if err != nil {
		return err
	}
	if err := ensureDevEnvOwned(existing, env); err != nil {
		return err
	}
	if apiequality.Semantic.DeepEqual(existing.Spec, desired.Spec) {
		return nil
	}
	desired.ResourceVersion = existing.ResourceVersion
	return r.Update(ctx, desired)
}

// applyTCPRoute creates or updates one TCPRoute.
func (r *DevEnvironmentReconciler) applyTCPRoute(ctx context.Context, env *aiv1alpha1.DevEnvironment, gw *gatewayv1.Gateway, name string, port int32) error {
	desired := r.desiredTCPRoute(env, gw, name, port)
	if err := ctrl.SetControllerReference(env, desired, r.Scheme); err != nil {
		return err
	}
	existing := &gatewayv1.TCPRoute{}
	err := r.Get(ctx, client.ObjectKey{Name: desired.Name, Namespace: desired.Namespace}, existing)
	if apierrors.IsNotFound(err) {
		return r.Create(ctx, desired)
	}
	if err != nil {
		return err
	}
	if err := ensureDevEnvOwned(existing, env); err != nil {
		return err
	}
	if apiequality.Semantic.DeepEqual(existing.Spec, desired.Spec) {
		return nil
	}
	desired.ResourceVersion = existing.ResourceVersion
	return r.Update(ctx, desired)
}

// buildEndpoints assembles status.endpoints from the published routes: the
// web URL, the SSH address, and the extra http/tcp exposures.
func (r *DevEnvironmentReconciler) buildEndpoints(env *aiv1alpha1.DevEnvironment, status *aiv1alpha1.DevEnvironmentStatus, gwIP string, ports map[string]int32) {
	cfg := r.defaultedConfig()
	// JoinHostPort brackets a literal IPv6 gateway address ([::1]:80); a plain
	// fmt "%s:%d" would produce an invalid URL.
	httpHostPort := net.JoinHostPort(gwIP, strconv.Itoa(int(cfg.HTTPPort)))
	status.Endpoints = nil
	if env.Spec.Type != aiv1alpha1.DevEnvironmentTypeSSH {
		status.Endpoints = append(status.Endpoints, aiv1alpha1.Endpoint{
			Name:    string(env.Spec.Type),
			Address: "http://" + httpHostPort + fmt.Sprintf("/dev/%s/%s/", env.Namespace, env.Name),
		})
	}
	if sshExposed(env) {
		status.Endpoints = append(status.Endpoints, aiv1alpha1.Endpoint{
			Name:    sshPortName,
			Address: fmt.Sprintf("ssh://%s@%s", runtimeUser(env), net.JoinHostPort(gwIP, strconv.Itoa(int(ports[sshPortName])))),
		})
	}
	for _, p := range env.Spec.Ports {
		switch p.Type {
		case aiv1alpha1.PortTypeHTTP:
			status.Endpoints = append(status.Endpoints, aiv1alpha1.Endpoint{
				Name:    p.Name,
				Address: "http://" + httpHostPort + fmt.Sprintf("/dev/%s/%s/port/%s/", env.Namespace, env.Name, p.Name),
			})
		case aiv1alpha1.PortTypeTCP:
			status.Endpoints = append(status.Endpoints, aiv1alpha1.Endpoint{
				Name:    p.Name,
				Address: net.JoinHostPort(gwIP, strconv.Itoa(int(ports[p.Name]))),
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
	if cfg.SSHPortRangeStart == 0 {
		cfg.SSHPortRangeStart = 20000
	}
	if cfg.SSHPortRangeEnd == 0 {
		cfg.SSHPortRangeEnd = 20999
	}
	return cfg
}
