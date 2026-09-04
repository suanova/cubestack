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

// +kubebuilder:rbac:groups=ai.cubestack.io,resources=devenvironments,verbs=get;list;watch
// +kubebuilder:rbac:groups=ai.cubestack.io,resources=devenvironments/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=ai.cubestack.io,resources=devenvironments/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=statefulsets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch;delete
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
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"fmt"
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
	reasonBound                  = "Bound"
	reasonWaiting                = "Waiting"
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

	// sshPortName names the SSH Service port and the "ssh" endpoint; the ssh
	// endpoint address uses the generic login user of the base image.
	sshPortName       = "ssh"
	mainPortName      = "main"
	sshKeysVolumeName = "ssh-keys"
	sshEndpointUser   = "user"

	// compute node pool labels: development pods are pinned to the compute
	// pool, isolated from the inference pool (design §8.1).
	computeNodePoolLabelKey = "cubestack.io/node-pool"
	computeNodePoolValue    = "compute"

	sshEd25519Algorithm = "ssh-ed25519"
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
		env.Finalizers = append(env.Finalizers, devEnvFinalizer)
		if err := r.Update(ctx, &env); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	desired := env.DeepCopy()
	desired.Status.ObservedGeneration = env.Generation

	// 1. Brand match gate: gpuType must match the image brand. A mismatch is a
	// hard failure — nothing is provisioned (design §4.2). An environment that
	// was running before the image or gpuType changed is withdrawn so the Failed
	// phase reflects reality: the workload is stopped and the routes removed.
	if reason := brandMismatchReason(&env); reason != "" {
		if err := r.stopCompute(ctx, &env); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.deleteRoutes(ctx, &env); err != nil {
			return ctrl.Result{}, err
		}
		setBrandMatchValidCondition(&desired.Status.Conditions, false, reasonBrandMismatch, reason)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionPodScheduled)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionStorageReady)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionRouteReady)
		desired.Status.Endpoints = nil
		setPhase(&desired.Status, aiv1alpha1.PhaseFailed, reasonBrandMismatch)
		setDevEnvironmentReadyCondition(&desired.Status.Conditions, metav1.ConditionFalse, reasonBrandMismatch, reason)
		return ctrl.Result{}, r.updateStatusIfChanged(ctx, &env, desired)
	}
	setBrandMatchValidCondition(&desired.Status.Conditions, true, reasonBrandValid, "gpuType matches the image brand")

	// 2. SSH secret: a managed host keypair + authorized_keys when SSH is
	// exposed (design §6.3).
	if sshExposed(&env) {
		keysSecret, err := r.reconcileSSHSecret(ctx, &env)
		if err != nil {
			return ctrl.Result{}, err
		}
		desired.Status.SSHKeysSecret = keysSecret
	} else {
		desired.Status.SSHKeysSecret = nil
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

	// 5. Observe the pod and workspace PVC, aggregate conditions and phase.
	pod, err := r.environmentPod(ctx, &env)
	if err != nil {
		return ctrl.Result{}, err
	}
	setPodScheduledCondition(&desired.Status.Conditions, pod)
	if err := r.setStorageReadyCondition(ctx, &env, &desired.Status.Conditions); err != nil {
		return ctrl.Result{}, err
	}
	r.setPhaseAndReady(&env, &desired.Status, pod)

	return ctrl.Result{}, r.updateStatusIfChanged(ctx, &env, desired)
}

// updateStatusIfChanged writes the desired status only when it differs from
// the observed one.
func (r *DevEnvironmentReconciler) updateStatusIfChanged(ctx context.Context, env *aiv1alpha1.DevEnvironment, desired *aiv1alpha1.DevEnvironment) error {
	if !apiequality.Semantic.DeepEqual(env.Status, desired.Status) {
		return r.Status().Update(ctx, desired)
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
// Terminating phase, deletes the managed resources, removes the workspace PVC
// only when pvcRetention=delete (design §7), and drops the finalizer.
func (r *DevEnvironmentReconciler) cleanup(ctx context.Context, env *aiv1alpha1.DevEnvironment) error {
	desired := env.DeepCopy()
	setPhase(&desired.Status, aiv1alpha1.PhaseTerminating, reasonDeleting)
	if err := r.updateStatusIfChanged(ctx, env, desired); err != nil {
		return err
	}

	for _, obj := range []client.Object{
		&appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: env.Name, Namespace: env.Namespace}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: env.Name, Namespace: env.Namespace}},
		&networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: env.Name, Namespace: env.Namespace}},
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: sshSecretName(env), Namespace: env.Namespace}},
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

	// The workspace PVC survives by default: the StatefulSet retains it on
	// delete. Remove it only when pvcRetention=delete. The PVC's controller
	// owner is the StatefulSet (created via volumeClaimTemplate), so ownership
	// is verified by the environment label instead of a controller ownerRef.
	if env.Spec.Storage != nil && env.Spec.Storage.PVCRetention == aiv1alpha1.PVCRetentionDelete {
		pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: workspacePVCName(env), Namespace: env.Namespace}}
		if err := r.Get(ctx, client.ObjectKeyFromObject(pvc), pvc); err != nil {
			if !apierrors.IsNotFound(err) {
				return err
			}
			// A missing PVC is already cleaned up; fall through to the
			// finalizer removal so the environment does not stall in
			// Terminating.
		} else if pvc.Labels[devEnvironmentLabelKey] == env.Name {
			if err := r.Delete(ctx, pvc); err != nil && !apierrors.IsNotFound(err) {
				return err
			}
		}
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
	builder := ctrl.NewControllerManagedBy(mgr).
		For(&aiv1alpha1.DevEnvironment{}).
		Owns(&appsv1.StatefulSet{}).
		Owns(&corev1.Service{}).
		Owns(&networkingv1.NetworkPolicy{}).
		Owns(&corev1.Secret{}).
		Watches(&corev1.Pod{}, handler.EnqueueRequestsFromMapFunc(r.enqueueForDevEnv)).
		Watches(&corev1.PersistentVolumeClaim{}, handler.EnqueueRequestsFromMapFunc(r.enqueueForDevEnv)).
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

// gatewayAPICRDsInstalled reports whether the Gateway API CRDs are present,
// so the manager only watches Gateway routes when the API is available.
func gatewayAPICRDsInstalled(mgr ctrl.Manager) bool {
	_, err := mgr.GetRESTMapper().RESTMapping(
		schema.GroupKind{Group: gatewayv1.GroupName, Kind: gatewayKind}, gatewayv1.GroupVersion.Version)
	return err == nil
}

// brandMismatchReason returns a non-empty message when gpuType does not match
// the image brand: nvidia <-> base-cuda and metax <-> base-maca (design §4.2).
// Custom images must carry their brand marker in the name (P1 baseline).
func brandMismatchReason(env *aiv1alpha1.DevEnvironment) string {
	image := strings.ToLower(env.Spec.Image)
	switch env.Spec.Resources.GPUType {
	case aiv1alpha1.GPUTypeNVIDIA:
		if !strings.Contains(image, "base-cuda") {
			return fmt.Sprintf("image %q does not match gpuType nvidia (expected a base-cuda image)", env.Spec.Image)
		}
	case aiv1alpha1.GPUTypeMetaX:
		if !strings.Contains(image, "base-maca") {
			return fmt.Sprintf("image %q does not match gpuType metax (expected a base-maca image)", env.Spec.Image)
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
// ssh 22, vscode 8080 (design §6.1).
func mainContainerPort(t aiv1alpha1.DevEnvironmentType) int32 {
	switch t {
	case aiv1alpha1.DevEnvironmentTypeJupyter:
		return 8888
	case aiv1alpha1.DevEnvironmentTypeVSCode:
		return 8080
	default:
		return 22
	}
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
func desiredResources(env *aiv1alpha1.DevEnvironment) corev1.ResourceRequirements {
	gpuName := gpuResource(env.Spec.Resources.GPUType)
	gpu := resource.NewQuantity(int64(env.Spec.Resources.GPUCount), resource.DecimalSI)
	limits := corev1.ResourceList{gpuName: *gpu}
	requests := corev1.ResourceList{gpuName: *gpu}
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

// desiredStatefulSet renders the environment StatefulSet: replicas 1/0 from
// spec.running, the workspace volumeClaimTemplate, and PVC retention so the
// workspace data survives stop and delete (the finalizer removes it only when
// pvcRetention=delete).
func (r *DevEnvironmentReconciler) desiredStatefulSet(env *aiv1alpha1.DevEnvironment) *appsv1.StatefulSet {
	replicas := int32(0)
	if env.Spec.Running {
		replicas = 1
	}
	return &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: env.Name, Namespace: env.Namespace, Labels: r.envLabels(env.Name)},
		Spec: appsv1.StatefulSetSpec{
			ServiceName: env.Name,
			Replicas:    &replicas,
			Selector:    &metav1.LabelSelector{MatchLabels: map[string]string{devEnvironmentLabelKey: env.Name}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: r.envLabels(env.Name)},
				Spec:       r.desiredPodSpec(env),
			},
			VolumeClaimTemplates: r.desiredVolumeClaimTemplates(env),
			PersistentVolumeClaimRetentionPolicy: &appsv1.StatefulSetPersistentVolumeClaimRetentionPolicy{
				WhenDeleted: appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
				WhenScaled:  appsv1.RetainPersistentVolumeClaimRetentionPolicyType,
			},
		},
	}
}

// desiredPodSpec renders the pod spec: compute-pool nodeSelector, the main
// container with the workspace and data volume mounts, and the SSH keys volume.
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
	if env.Spec.Runtime != nil {
		container.Command = env.Spec.Runtime.Command
		container.Args = env.Spec.Runtime.Args
		container.Env = env.Spec.Runtime.Env
	}
	if env.Spec.Storage != nil {
		container.VolumeMounts = append(container.VolumeMounts, corev1.VolumeMount{
			Name: workspaceClaimName, MountPath: env.Spec.Storage.MountPath,
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
		// Base images read the sshd host keys and authorized_keys from this
		// path (documented in the sample CR); permissions are 0644 so a
		// non-root sshd can read them, and the image's setup may tighten them.
		container.VolumeMounts = append(container.VolumeMounts, corev1.VolumeMount{
			Name: sshKeysVolumeName, MountPath: "/etc/cubestack/ssh", ReadOnly: true,
		})
	}

	podSpec := corev1.PodSpec{
		NodeSelector: map[string]string{computeNodePoolLabelKey: computeNodePoolValue},
		Containers:   []corev1.Container{container},
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
// the PVC <env>-workspace-0 that survives stop/start.
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
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse(env.Spec.Storage.Size)},
			},
		},
	}
	if env.Spec.Storage.StorageClassName != "" {
		pvc.Spec.StorageClassName = ptr(env.Spec.Storage.StorageClassName)
	}
	return []corev1.PersistentVolumeClaim{pvc}
}

// desiredService renders the ClusterIP Service with the main port, the SSH
// port (when exposed and not the main port), and the extra application ports.
func (r *DevEnvironmentReconciler) desiredService(env *aiv1alpha1.DevEnvironment) *corev1.Service {
	mainPort := mainContainerPort(env.Spec.Type)
	ports := []corev1.ServicePort{
		{Name: mainPortName, Port: mainPort, TargetPort: intstr.FromInt32(mainPort), Protocol: corev1.ProtocolTCP},
	}
	if sshExposed(env) && env.Spec.Type != aiv1alpha1.DevEnvironmentTypeSSH {
		ports = append(ports, corev1.ServicePort{Name: sshPortName, Port: 22, TargetPort: intstr.FromInt32(22), Protocol: corev1.ProtocolTCP})
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

// desiredNetworkPolicy enforces default-deny ingress with DNS egress
// whitelisted (design §9.1).
func (r *DevEnvironmentReconciler) desiredNetworkPolicy(env *aiv1alpha1.DevEnvironment) *networkingv1.NetworkPolicy {
	tcp := corev1.ProtocolTCP
	udp := corev1.ProtocolUDP
	dnsPort := intstr.FromInt32(53)
	return &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: env.Name, Namespace: env.Namespace, Labels: r.envLabels(env.Name)},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{devEnvironmentLabelKey: env.Name}},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress, networkingv1.PolicyTypeEgress},
			// Ingress is an empty rule list: default-deny inbound. The platform
			// gateway/portal whitelist rules are installed outside this
			// controller (design §9.1).
			Ingress: []networkingv1.NetworkPolicyIngressRule{},
			Egress: []networkingv1.NetworkPolicyEgressRule{
				{
					To: []networkingv1.NetworkPolicyPeer{{
						NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"kubernetes.io/metadata.name": "kube-system"}},
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
	if existing.Annotations[stsSpecHashAnnotationKey] == sts.Annotations[stsSpecHashAnnotationKey] &&
		existing.Spec.Replicas != nil && *existing.Spec.Replicas == *sts.Spec.Replicas {
		return nil
	}
	sts.ResourceVersion = existing.ResourceVersion
	return r.Update(ctx, sts)
}

// stsSpecHash hashes the pod-template-affecting fields so applyStatefulSet can
// detect template changes without comparing server-defaulted fields.
func stsSpecHash(env *aiv1alpha1.DevEnvironment) string {
	type templateInput struct {
		Type       aiv1alpha1.DevEnvironmentType
		Image      string
		Resources  aiv1alpha1.ResourcesSpec
		Runtime    *aiv1alpha1.RuntimeSpec
		Storage    *aiv1alpha1.StorageSpec
		Volumes    []aiv1alpha1.VolumeMount
		SSHExposed bool
	}
	h := sha256.New()
	h.Write(mustJSON(templateInput{
		Type:       env.Spec.Type,
		Image:      env.Spec.Image,
		Resources:  env.Spec.Resources,
		Runtime:    env.Spec.Runtime,
		Storage:    env.Spec.Storage,
		Volumes:    env.Spec.Volumes,
		SSHExposed: sshExposed(env),
	}))
	return fmt.Sprintf("sha256:%x", h.Sum(nil))
}

// reconcileSSHSecret creates or updates the managed SSH secret holding the
// ed25519 host keypair and the authorized_keys content assembled from
// spec.ssh.keysSecret. The host keypair is generated once and never rotated
// (design §6.3); authorized_keys is refreshed when the user's keys change.
func (r *DevEnvironmentReconciler) reconcileSSHSecret(ctx context.Context, env *aiv1alpha1.DevEnvironment) (*corev1.SecretKeySelector, error) {
	name := sshSecretName(env)
	authorized, err := r.userAuthorizedKeys(ctx, env)
	if err != nil {
		return nil, err
	}

	secret := &corev1.Secret{}
	err = r.Get(ctx, types.NamespacedName{Namespace: env.Namespace, Name: name}, secret)
	if apierrors.IsNotFound(err) {
		privPEM, pubOpenSSH, err := generateSSHKeyPair()
		if err != nil {
			return nil, err
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
			return nil, err
		}
		if err := r.Create(ctx, desired); err != nil {
			return nil, err
		}
		return &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: name}, Key: sshAuthorizedKeysKey}, nil
	}
	if err != nil {
		return nil, err
	}
	if err := ensureDevEnvOwned(secret, env); err != nil {
		return nil, err
	}
	if string(secret.Data[sshAuthorizedKeysKey]) != authorized {
		secret.Data[sshAuthorizedKeysKey] = []byte(authorized)
		if err := r.Update(ctx, secret); err != nil {
			return nil, err
		}
	}
	return &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: name}, Key: sshAuthorizedKeysKey}, nil
}

func sshSecretName(env *aiv1alpha1.DevEnvironment) string {
	return env.Name + "-ssh-keys"
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

// generateSSHKeyPair produces an ed25519 host keypair: the private key as a
// PKCS8 PEM block (readable by sshd) and the public key in OpenSSH one-line
// format. The base image contract defines how they are consumed.
func generateSSHKeyPair() (privPEM, pubOpenSSH []byte, err error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	privDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, nil, err
	}
	privPEM = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privDER})

	pub := priv.Public().(ed25519.PublicKey)
	pubOpenSSH = append([]byte(sshEd25519Algorithm+" "), base64.StdEncoding.EncodeToString(sshEd25519Blob(pub))...)
	pubOpenSSH = append(pubOpenSSH, '\n')
	return privPEM, pubOpenSSH, nil
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
// port is always 22 (main port for the ssh container type), extras use the
// declared containerPort.
func servicePortFor(env *aiv1alpha1.DevEnvironment, name string) int32 {
	if name == sshPortName {
		return 22
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
			Address: fmt.Sprintf("ssh://%s@%s", sshEndpointUser, net.JoinHostPort(gwIP, strconv.Itoa(int(ports[sshPortName])))),
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

func workspacePVCName(env *aiv1alpha1.DevEnvironment) string {
	return env.Name + "-" + workspaceClaimName + "-0"
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

// setStorageReadyCondition sets the StorageReady condition from the workspace
// PVC. When no workspace storage is configured it is True/NotApplicable.
func (r *DevEnvironmentReconciler) setStorageReadyCondition(ctx context.Context, env *aiv1alpha1.DevEnvironment, conditions *[]metav1.Condition) error {
	if env.Spec.Storage == nil {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type: aiv1alpha1.ConditionStorageReady, Status: metav1.ConditionTrue, Reason: reasonNotApplicable, Message: "No workspace storage is configured",
		})
		return nil
	}
	pvc := &corev1.PersistentVolumeClaim{}
	err := r.Get(ctx, types.NamespacedName{Namespace: env.Namespace, Name: workspacePVCName(env)}, pvc)
	if apierrors.IsNotFound(err) {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type: aiv1alpha1.ConditionStorageReady, Status: metav1.ConditionFalse, Reason: reasonWaiting, Message: "The workspace PVC has not been created yet",
		})
		return nil
	}
	if err != nil {
		return err
	}
	if pvc.Status.Phase != corev1.ClaimBound {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type: aiv1alpha1.ConditionStorageReady, Status: metav1.ConditionFalse, Reason: reasonWaiting, Message: fmt.Sprintf("The workspace PVC is %s", pvc.Status.Phase),
		})
		return nil
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type: aiv1alpha1.ConditionStorageReady, Status: metav1.ConditionTrue, Reason: reasonBound, Message: "The workspace PVC is bound",
	})
	return nil
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
