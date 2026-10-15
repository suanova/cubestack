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

// +kubebuilder:rbac:groups=ai.cubestack.io,resources=inferenceservices,verbs=get;list;watch
// +kubebuilder:rbac:groups=ai.cubestack.io,resources=inferenceservices/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=ai.cubestack.io,resources=inferenceruntimeprofiles,verbs=get;list;watch
// +kubebuilder:rbac:groups=ai.cubestack.io,resources=modelversions,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch;create
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=leaderworkerset.x-k8s.io,resources=leaderworkersets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=httproutes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=aigateway.envoyproxy.io,resources=aigatewayroutes,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=aigateway.envoyproxy.io,resources=aiservicebackends,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=referencegrants,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gateway.envoyproxy.io,resources=backends,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=monitoring.coreos.com,resources=servicemonitors,verbs=get;list;watch;create;update;patch;delete

package controller

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	aigwv1beta1 "github.com/envoyproxy/ai-gateway/api/v1beta1"
	egv1alpha1 "github.com/envoyproxy/gateway/api/v1alpha1"
	monitoringv1 "github.com/prometheus-operator/prometheus-operator/pkg/apis/monitoring/v1"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
	leaderworkersetv1 "sigs.k8s.io/lws/api/leaderworkerset/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/internal/renderer"
)

// InferenceServiceReconciler resolves the referenced profile, model version
// and asset sources (Resolved), validates and renders the profile templates
// (Rendered), provisions the rendered asset ConfigMaps and the model PVC
// (Provisioned), and applies the Services and workloads of every role with
// dependency gating (WorkloadsApplied). The profile revision is adopted only
// after a fully successful apply.
type InferenceServiceReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	// GatewayName and GatewayNamespace select the platform Gateway the
	// catalog entry of a published service attaches to (spec.parentRefs).
	GatewayName      string
	GatewayNamespace string
	// CatalogRoute is the name of the platform's pre-installed shared
	// AIGatewayRoute (in GatewayNamespace) that published services attach a
	// rule to. The operator never creates it; a missing one degrades to
	// CatalogRouteNotFound (design §3.3).
	CatalogRoute string
	// CatalogHostname, when set, is surfaced in status.endpoint.public so the
	// Agent Router can advertise the shared catalog's host. It is a display
	// value only — it no longer gates publishing.
	CatalogHostname string
	// AgentRouterAvailable reports whether the cluster serves the Agent
	// Router CRDs. Probed once at startup (AgentRouterAvailable below).
	AgentRouterAvailable bool
	// ServiceMonitorAvailable reports whether the cluster serves the
	// monitoring.coreos.com ServiceMonitor CRD. The ServiceMonitors scraping
	// the role Services are monitoring infrastructure, not part of the
	// service: a cluster without the prometheus-operator CRDs must still
	// reconcile its InferenceServices, so the apply step skips them instead
	// of failing on an unknown kind. Probed once at startup.
	ServiceMonitorAvailable bool
}

// ServiceMonitorAvailable reports whether the cluster serves the
// monitoring.coreos.com ServiceMonitor CRD. The ServiceMonitors scraping the
// role Services are optional monitoring infrastructure: where
// prometheus-operator is not installed, the controller skips them rather than
// failing every InferenceService on an unknown kind.
func ServiceMonitorAvailable(mapper meta.RESTMapper) bool {
	_, err := mapper.RESTMapping(
		monitoringv1.SchemeGroupVersion.WithKind("ServiceMonitor").GroupKind(),
		monitoringv1.SchemeGroupVersion.Version,
	)
	return err == nil
}

// AgentRouterAvailable reports whether the cluster serves the Agent Router
// kinds the published-route path needs: the ai-gateway CRDs (AIGatewayRoute,
// AIServiceBackend) and the Envoy Gateway Backend they reference. A cluster
// without them still reconciles InferenceServices: publish degrades to
// RouteReady=False with reason AgentRouterUnavailable instead of failing on an
// unknown kind. All the kinds are probed together because the guarded setup
// registers an Owns/Watches for each of them — a cluster serving only some of
// them would otherwise abort controller startup, the very failure the guard
// exists to prevent. Probed once at startup, like ServiceMonitorAvailable.
func AgentRouterAvailable(mapper meta.RESTMapper) bool {
	for _, gvk := range []schema.GroupVersionKind{
		aigwv1beta1.SchemeGroupVersion.WithKind("AIGatewayRoute"),
		aigwv1beta1.SchemeGroupVersion.WithKind("AIServiceBackend"),
		egv1alpha1.SchemeGroupVersion.WithKind("Backend"),
	} {
		if _, err := mapper.RESTMapping(gvk.GroupKind(), gvk.Version); err != nil {
			return false
		}
	}
	return true
}

// Reconcile runs the render pipeline's generation steps (design §4.1 steps
// 1–7): resolve the references, render the templates, provision the asset
// ConfigMaps and the model PVC, apply the Services and workloads of every
// role with dependency gating, check the internal endpoint, publish the
// public route and aggregate Ready/Progressing — reporting the Resolved,
// Rendered, Provisioned, WorkloadsApplied, EndpointReady, RouteReady, Ready
// and Progressing conditions in status.
func (r *InferenceServiceReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var isvc aiv1alpha1.InferenceService
	if err := r.Get(ctx, req.NamespacedName, &isvc); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// A service being deleted sheds its rule from the platform's shared catalog
	// route (and the finalizer that guards that removal) before it goes; a
	// published service that is not being deleted makes sure it carries that
	// finalizer. The rule lives in another namespace and is not owned by the
	// service, so the finalizer is what lets the service wait for its removal.
	if isvc.DeletionTimestamp != nil {
		return ctrl.Result{}, r.finalizeCatalogRule(ctx, req, &isvc)
	}
	if err := r.ensureCatalogFinalizer(ctx, &isvc); err != nil {
		return ctrl.Result{}, err
	}

	resolved, err := r.resolve(ctx, &isvc)
	if err != nil {
		return ctrl.Result{}, err
	}

	desired := isvc.DeepCopy()
	desired.Status.ObservedGeneration = isvc.Generation
	// The audit echo reflects only a fully provisioned state: it is cleared
	// here and filled after every provisioning step succeeds. The role and
	// endpoint echoes follow the same rule — they are filled only after a
	// successful apply (the endpoint by the convergence steps).
	desired.Status.Assets = nil
	desired.Status.Roles = nil
	desired.Status.Endpoint = nil
	setResolvedCondition(&desired.Status.Conditions, resolved)
	setProfileEcho(desired, &isvc, resolved.profile)
	setModelEcho(desired, resolved.model)

	if !resolved.resolved() {
		// A stale Rendered from a previous spec must not persist, and the
		// convergence conditions whose checks need the resolved references
		// (endpoint role, route profile) cannot be verified — they are removed
		// alongside the Status.Endpoint echo (line 104). Ready is kept: it
		// reflects the running deployment (design §3.3).
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionRendered)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionProvisioned)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionWorkloadsApplied)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionEndpointReady)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionRouteReady)
		// Nothing is being applied: a stale True/Rollout must not linger.
		setProgressingCondition(&desired.Status.Conditions, nil, "")
		return ctrl.Result{}, r.updateStatusIfChanged(ctx, &isvc, desired)
	}

	rendered := renderer.Render(&isvc, resolved.profile, resolved.model, resolved.assets)
	setRenderedCondition(&desired.Status.Conditions, &rendered)

	rev := revisionHash(resolved.profile, resolved.assets)
	setProfileDriftedCondition(&desired.Status.Conditions, desired.Status.Profile, rev)
	setProfileDeprecatedCondition(&desired.Status.Conditions, resolved.profile)

	// Provision only on a successful render: with Rendered=False the output
	// may still hold unresolved placeholders, which must not be written to
	// asset ConfigMaps.
	if len(rendered.Errors) == 0 {
		assetStatuses, err := r.provisionAssets(ctx, &isvc, resolved.profile, &rendered)
		if err != nil {
			setProvisionedCondition(&desired.Status.Conditions, "AssetConfigMapFailed", err)
			statusErr := r.updateStatusIfChanged(ctx, &isvc, desired)
			if statusErr != nil {
				return ctrl.Result{}, statusErr
			}
			// Return the provision error so the reconcile is requeued; the
			// status write must not swallow it.
			return ctrl.Result{}, err
		}
		if err := r.provisionModelPVC(ctx, &isvc, resolved.model); err != nil {
			reason := "PVCCreateFailed"
			var idErr *storageIdentityErr
			if errors.As(err, &idErr) {
				reason = "StorageIdentityChanged"
			}
			setProvisionedCondition(&desired.Status.Conditions, reason, err)
			statusErr := r.updateStatusIfChanged(ctx, &isvc, desired)
			if statusErr != nil {
				return ctrl.Result{}, statusErr
			}
			// Return the provision error so the reconcile is requeued; the
			// status write must not swallow it.
			return ctrl.Result{}, err
		}
		credStatus, err := r.provisionModelCredentials(ctx, &isvc, resolved.model)
		if err != nil {
			setProvisionedCondition(&desired.Status.Conditions, "SecretCopyFailed", err)
			statusErr := r.updateStatusIfChanged(ctx, &isvc, desired)
			if statusErr != nil {
				return ctrl.Result{}, statusErr
			}
			// Return the provision error so the reconcile is requeued; the
			// status write must not swallow it.
			return ctrl.Result{}, err
		}
		desired.Status.Assets = assetStatuses
		// The credentials echo is only filled on a fully provisioned state; on
		// any earlier path desired.Status.Model.Credentials stays nil.
		if credStatus != nil && desired.Status.Model != nil {
			desired.Status.Model.Credentials = credStatus
		}
		setProvisionedCondition(&desired.Status.Conditions, "", nil)

		rolesStatus, applyRes, err := r.applyWorkloads(ctx, desired, resolved.profile, &rendered, resolved.model)
		if err != nil {
			var svcErr serviceApplyErr
			if errors.As(err, &svcErr) {
				setWorkloadsAppliedCondition(&desired.Status.Conditions, "ServiceApplyFailed", err)
			} else {
				setWorkloadsAppliedCondition(&desired.Status.Conditions, "WorkloadApplyFailed", err)
			}
			statusErr := r.updateStatusIfChanged(ctx, &isvc, desired)
			if statusErr != nil {
				return ctrl.Result{}, statusErr
			}
			return ctrl.Result{}, err
		}
		desired.Status.Roles = rolesStatus
		if len(applyRes.WaitingDependencies) > 0 {
			setWorkloadsAppliedCondition(&desired.Status.Conditions, "WaitingForDependencies", fmt.Errorf("waiting for roles: %s", strings.Join(applyRes.WaitingDependencies, ", ")))
		} else {
			// Fully applied: adopt the revision and report WorkloadsApplied.
			desired.Status.Profile.Revision = rev
			setWorkloadsAppliedCondition(&desired.Status.Conditions, "", nil)
		}

		// Convergence steps (design §4.1 steps 5-7): endpoint reachability,
		// route publish, and the Ready/Progressing aggregation. Failures here
		// only set their own condition and never block the other aggregates.
		endpoint, err := r.checkEndpoint(ctx, desired, resolved.profile)
		if err != nil {
			return ctrl.Result{}, err
		}
		setEndpointReadyCondition(&desired.Status.Conditions, endpoint)
		desired.Status.Endpoint = &aiv1alpha1.EndpointStatus{Internal: endpoint.Internal}

		route, err := r.checkRoute(ctx, desired, resolved.profile, endpoint, resolved.model.Spec.Model)
		if err != nil {
			return ctrl.Result{}, err
		}
		setRouteReadyCondition(&desired.Status.Conditions, route)
		// status.endpoint.public is the canonical public address of the
		// published service: the model catalog's shared entry hostname, at
		// which the service's model is selected by route.modelName. The
		// platform's public entry point terminates TLS, so the scheme is fixed
		// to https regardless of the Gateway listener protocol. Derived from
		// the route, never from the listener.
		if route.Reason == "" && r.CatalogHostname != "" {
			desired.Status.Endpoint.Public = "https://" + r.CatalogHostname
		}

		setReadyCondition(&desired.Status.Conditions, rolesStatus)
		setProgressingCondition(&desired.Status.Conditions, rolesStatus, applyRes.Progressing)
	} else {
		// A stale Provisioned — and the applied-result conditions, whose steps
		// only run on a successful render+apply — must not persist when the
		// current spec no longer renders. Ready is kept: it reflects the
		// running deployment (design §3.3 "Ready 继续反映当前部署的实际状态"),
		// and Progressing is set to Converged — nothing is being applied.
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionProvisioned)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionWorkloadsApplied)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionEndpointReady)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionRouteReady)
		setProgressingCondition(&desired.Status.Conditions, nil, "")
	}

	return ctrl.Result{}, r.updateStatusIfChanged(ctx, &isvc, desired)
}

// finalizeCatalogRule removes the catalog finalizer from a service that is
// being deleted, after shedding its rule from the platform's shared catalog
// route. The rule lives in another namespace and is not owned by the service,
// so it is removed explicitly here; the other catalog objects cascade through
// their ownerRef. The guard is on the finalizer's presence, not on spec.route —
// a service that was published and later had publish flipped off still carries
// a rule to remove, and the finalizer is only ever added while the service is
// being reconciled as published. A service without the finalizer has nothing to
// shed, so deletion proceeds immediately.
func (r *InferenceServiceReconciler) finalizeCatalogRule(ctx context.Context, req ctrl.Request, isvc *aiv1alpha1.InferenceService) error {
	if !slices.Contains(isvc.Finalizers, inferenceServiceCatalogFinalizer) {
		return nil
	}
	if err := r.removeCatalogRule(ctx, isvc); err != nil {
		return err
	}
	// Re-fetch for a fresh resourceVersion before mutating finalizers: any
	// status write during the delete reconcile bumped it, so a stale Update
	// would 409-conflict and force a retry reconcile.
	fresh := &aiv1alpha1.InferenceService{}
	if err := r.Get(ctx, req.NamespacedName, fresh); err != nil {
		return client.IgnoreNotFound(err)
	}
	fresh.Finalizers = slices.DeleteFunc(fresh.Finalizers, func(f string) bool {
		return f == inferenceServiceCatalogFinalizer
	})
	return r.Update(ctx, fresh)
}

// ensureCatalogFinalizer adds the catalog finalizer to a published service that
// does not already carry it, so its rule survives the service's deletion until
// it is shed. A service that is not published — or already carries the
// finalizer — is left untouched: the finalizer is added only for the
// publish=true state, and a missing one means nothing needs guarding.
func (r *InferenceServiceReconciler) ensureCatalogFinalizer(ctx context.Context, isvc *aiv1alpha1.InferenceService) error {
	if slices.Contains(isvc.Finalizers, inferenceServiceCatalogFinalizer) || isvc.Spec.Route == nil || !isvc.Spec.Route.Publish {
		return nil
	}
	// Patch, not Update: the finalizer is the only field this call means to
	// change. The patch carries the resourceVersion we read (optimistic lock)
	// because a merge patch spells out the whole finalizers list as we saw it:
	// without the lock, a finalizer another controller adds after our read
	// would be silently dropped by this write. With it, such a write 409s and
	// this reconcile retries against a fresh read.
	patch := client.MergeFromWithOptions(isvc.DeepCopy(), client.MergeFromWithOptimisticLock{})
	isvc.Finalizers = append(isvc.Finalizers, inferenceServiceCatalogFinalizer)
	return r.Patch(ctx, isvc, patch)
}

// setProfileEcho fills the profile status echo from the resolved profile. A
// resolved profile sets the echo, keeping the last adopted revision of the
// same profile: ProfileDrifted compares the current hash against it while
// changed profile content is not yet adopted, and a different profile has no
// baseline revision. With no resolved profile a switched reference is cleared,
// while a same-name reference keeps its echo — including the adopted revision,
// the drift baseline that must survive the profile's deletion and recreation.
func setProfileEcho(desired, isvc *aiv1alpha1.InferenceService, profile *aiv1alpha1.InferenceRuntimeProfile) {
	if profile != nil {
		desired.Status.Profile = &aiv1alpha1.ProfileStatus{Name: profile.Name}
		if isvc.Status.Profile != nil && isvc.Status.Profile.Name == profile.Name {
			desired.Status.Profile.Revision = isvc.Status.Profile.Revision
		}
		return
	}
	if isvc.Status.Profile != nil && isvc.Status.Profile.Name != isvc.Spec.ProfileRef {
		desired.Status.Profile = nil
	}
}

// setModelEcho fills the model status echo from the resolved model version.
func setModelEcho(desired *aiv1alpha1.InferenceService, model *aiv1alpha1.ModelVersion) {
	if model != nil {
		desired.Status.Model = &aiv1alpha1.ModelStatus{Name: model.Spec.Model, Version: model.Spec.Version}
		return
	}
	desired.Status.Model = nil
}

// updateStatusIfChanged writes the desired status only when it differs from
// the observed one.
func (r *InferenceServiceReconciler) updateStatusIfChanged(ctx context.Context, isvc *aiv1alpha1.InferenceService, desired *aiv1alpha1.InferenceService) error {
	if !apiequality.Semantic.DeepEqual(isvc.Status, desired.Status) {
		return r.Status().Update(ctx, desired)
	}
	return nil
}

// SetupWithManager registers the InferenceService watch and the ModelVersion,
// InferenceRuntimeProfile and source-ConfigMap watches mapped back through the
// shared cache indexes.
func (r *InferenceServiceReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := registerSharedIndexes(mgr); err != nil {
		return err
	}
	b := ctrl.NewControllerManagedBy(mgr).
		For(&aiv1alpha1.InferenceService{}).
		Owns(&corev1.ConfigMap{}).
		Owns(&corev1.PersistentVolumeClaim{}).
		Owns(&corev1.Secret{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.Service{})
	if r.ServiceMonitorAvailable {
		// Owns() starts an informer on the kind: registering it where the CRD
		// is not served would abort controller startup — the very failure the
		// ServiceMonitorAvailable degradation exists to avoid.
		b = b.Owns(&monitoringv1.ServiceMonitor{})
	}
	if r.AgentRouterAvailable {
		// Same rule as above for the Agent Router catalog objects: with the
		// CRDs served, their status writes (and external edits or deletions)
		// must re-run the acceptance check of the owning service.
		b = b.Owns(&gatewayv1.ReferenceGrant{}).
			Owns(&aigwv1beta1.AIServiceBackend{}).
			Owns(&egv1alpha1.Backend{}).
			Watches(&aigwv1beta1.AIGatewayRoute{},
				handler.EnqueueRequestsFromMapFunc(r.enqueueForSharedCatalogRoute)).
			Watches(&aigwv1beta1.AIServiceBackend{},
				handler.EnqueueRequestsFromMapFunc(r.enqueueForOwnedCatalogObject)).
			Watches(&egv1alpha1.Backend{},
				handler.EnqueueRequestsFromMapFunc(r.enqueueForOwnedCatalogObject))
	}
	return b.
		Watches(&aiv1alpha1.ModelVersion{},
			handler.EnqueueRequestsFromMapFunc(r.enqueueReferencingServices)).
		Watches(&aiv1alpha1.InferenceRuntimeProfile{},
			handler.EnqueueRequestsFromMapFunc(r.enqueueReferencingServices)).
		Watches(&corev1.ConfigMap{},
			handler.EnqueueRequestsFromMapFunc(r.enqueueForSourceConfigMap)).
		Watches(&corev1.Secret{},
			handler.EnqueueRequestsFromMapFunc(r.enqueueForSourceCredentialsSecret)).
		Watches(&leaderworkersetv1.LeaderWorkerSet{},
			handler.EnqueueRequestsFromMapFunc(r.enqueueForOwnedLWS)).
		Complete(r)
}

// enqueueReferencingServices maps a ModelVersion or InferenceRuntimeProfile
// to the services referencing it through the matching cache index.
func (r *InferenceServiceReconciler) enqueueReferencingServices(ctx context.Context, obj client.Object) []reconcile.Request {
	var ref, indexKey string
	switch o := obj.(type) {
	case *aiv1alpha1.ModelVersion:
		ref, indexKey = o.Name, modelRefIndexKey
	case *aiv1alpha1.InferenceRuntimeProfile:
		ref, indexKey = o.Name, profileRefIndexKey
	default:
		return nil
	}
	return r.referencingServices(ctx, indexKey, ref)
}

// enqueueForOwnedCatalogObject maps a catalog object (Backend,
// AIServiceBackend or AIGatewayRoute) to its owning InferenceService, so a
// status write from the Agent Router controller re-runs the acceptance check.
func (r *InferenceServiceReconciler) enqueueForOwnedCatalogObject(_ context.Context, obj client.Object) []reconcile.Request {
	if owner := metav1.GetControllerOf(obj); owner != nil && isInferenceServiceOwner(owner) {
		return []reconcile.Request{{NamespacedName: types.NamespacedName{Namespace: obj.GetNamespace(), Name: owner.Name}}}
	}
	return nil
}

// enqueueForSharedCatalogRoute maps a change to the platform's shared catalog
// route to every published service, whose rule lives in that route and must be
// re-reconciled when the route is edited or its acceptance changes. Only the
// single route named by CatalogRoute in GatewayNamespace is meaningful; any
// other AIGatewayRoute is left to the owning controller (the per-service
// routes the previous design created are gone, but the CRD still allows
// arbitrary routes in the cluster).
func (r *InferenceServiceReconciler) enqueueForSharedCatalogRoute(ctx context.Context, obj client.Object) []reconcile.Request {
	route := obj.(*aigwv1beta1.AIGatewayRoute)
	if route.Name != r.CatalogRoute || route.Namespace != r.GatewayNamespace {
		return nil
	}
	var reqs []reconcile.Request
	var list aiv1alpha1.InferenceServiceList
	if err := r.List(ctx, &list, client.MatchingFields{publishIndexKey: publishIndexValue}); err != nil {
		return nil
	}
	for i := range list.Items {
		reqs = append(reqs, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: list.Items[i].Namespace, Name: list.Items[i].Name}})
	}
	return reqs
}

// enqueueForSourceConfigMap maps a ConfigMap in cubestack-system to the
// services whose profile references it as an asset source. Unrelated
// ConfigMaps short-circuit cheaply.
func (r *InferenceServiceReconciler) enqueueForSourceConfigMap(ctx context.Context, obj client.Object) []reconcile.Request {
	cm := obj.(*corev1.ConfigMap)
	if cm.Namespace != systemNamespace {
		return nil
	}
	irpList := &aiv1alpha1.InferenceRuntimeProfileList{}
	if err := r.List(ctx, irpList, client.MatchingFields{assetConfigMapRefIndexKey: cm.Name}); err != nil {
		return nil
	}
	var reqs []reconcile.Request
	for _, irp := range irpList.Items {
		reqs = append(reqs, r.referencingServices(ctx, profileRefIndexKey, irp.Name)...)
	}
	return reqs
}

// enqueueForSourceCredentialsSecret maps a Secret in cubestack-system to the
// services whose ModelVersion references it via storage.s3.credentialsRef:
// rotating the source Secret re-syncs the credentials copies (design §3.1).
// Unrelated Secrets short-circuit cheaply.
func (r *InferenceServiceReconciler) enqueueForSourceCredentialsSecret(ctx context.Context, obj client.Object) []reconcile.Request {
	secret := obj.(*corev1.Secret)
	if secret.Namespace != systemNamespace {
		return nil
	}
	mvList := &aiv1alpha1.ModelVersionList{}
	if err := r.List(ctx, mvList, client.MatchingFields{credentialsRefIndexKey: secret.Name}); err != nil {
		// A failed index lookup drops the event; the copy is still re-synced on
		// the next service reconcile.
		return nil
	}
	var reqs []reconcile.Request
	for _, mv := range mvList.Items {
		reqs = append(reqs, r.referencingServices(ctx, modelRefIndexKey, mv.Name)...)
	}
	return reqs
}

// enqueueForOwnedLWS maps a LeaderWorkerSet to the InferenceService owning it.
func (r *InferenceServiceReconciler) enqueueForOwnedLWS(ctx context.Context, obj client.Object) []reconcile.Request {
	lws := obj.(*leaderworkersetv1.LeaderWorkerSet)
	if owner := metav1.GetControllerOf(lws); owner != nil && isInferenceServiceOwner(owner) {
		return []reconcile.Request{{NamespacedName: types.NamespacedName{Namespace: lws.Namespace, Name: owner.Name}}}
	}
	return nil
}

// isInferenceServiceOwner reports whether the owner reference points at an
// InferenceService of this API group — the Kind alone is not enough: a
// controller owner of the same Kind from another group must not be treated as
// one of our services.
func isInferenceServiceOwner(owner *metav1.OwnerReference) bool {
	return owner.Kind == inferenceServiceKind && owner.APIVersion == aiv1alpha1.GroupVersion.String()
}

// referencingServices lists the InferenceServices whose spec field (via the
// given cache index) points at ref.
func (r *InferenceServiceReconciler) referencingServices(ctx context.Context, indexKey, ref string) []reconcile.Request {
	list := &aiv1alpha1.InferenceServiceList{}
	if err := r.List(ctx, list, client.MatchingFields{indexKey: ref}); err != nil {
		// A failed index lookup drops the event; the service is still
		// refreshed on its next reconcile.
		return nil
	}
	reqs := make([]reconcile.Request, 0, len(list.Items))
	for _, isvc := range list.Items {
		reqs = append(reqs, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: isvc.Namespace, Name: isvc.Name}})
	}
	return reqs
}

// deprecatedLabelKey marks an InferenceRuntimeProfile as deprecated; services
// referencing one report the ProfileDeprecated warning condition.
const deprecatedLabelKey = "ai.cubestack.io/deprecated"

// inferenceServiceKind is the Kind of the owner-reference lookups of the
// owned-resource watches (LWS and the Agent Router catalog objects).
const inferenceServiceKind = "InferenceService"

// setRenderedCondition sets the Rendered condition from the render outcome.
// The reason is the first failure; the message aggregates all failures.
func setRenderedCondition(conditions *[]metav1.Condition, rendered *renderer.Result) {
	if len(rendered.Errors) == 0 {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionRendered,
			Status:  metav1.ConditionTrue,
			Reason:  "Rendered",
			Message: "Overrides are valid and all templates render",
		})
		return
	}
	msgs := make([]string, 0, len(rendered.Errors))
	for _, e := range rendered.Errors {
		msgs = append(msgs, e.Msg)
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type:    aiv1alpha1.ConditionRendered,
		Status:  metav1.ConditionFalse,
		Reason:  string(rendered.Errors[0].Reason),
		Message: strings.Join(msgs, "; "),
	})
}

// setProfileDeprecatedCondition sets the ProfileDeprecated warning condition
// from the profile's deprecated label.
func setProfileDeprecatedCondition(conditions *[]metav1.Condition, profile *aiv1alpha1.InferenceRuntimeProfile) {
	if _, ok := profile.Labels[deprecatedLabelKey]; ok {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionProfileDeprecated,
			Status:  metav1.ConditionTrue,
			Reason:  "Deprecated",
			Message: "The referenced profile is deprecated; migrate to a newer profile",
		})
		return
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type:    aiv1alpha1.ConditionProfileDeprecated,
		Status:  metav1.ConditionFalse,
		Reason:  "NotDeprecated",
		Message: "The referenced profile is not deprecated",
	})
}

// setProfileDriftedCondition sets the ProfileDrifted warning condition: the
// current profile content hash differs from the revision of the last adopted
// render. Phase 1 adopts on every successful render, so drift fires when the
// profile content changed but the new content was not adopted (render failed);
// the baseline semantics become meaningful once applies land (Phase 3).
func setProfileDriftedCondition(conditions *[]metav1.Condition, stored *aiv1alpha1.ProfileStatus, currentHash string) {
	if stored == nil || stored.Revision == "" || stored.Revision == currentHash {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionProfileDrifted,
			Status:  metav1.ConditionFalse,
			Reason:  "Current",
			Message: "Profile content hash matches the last adopted revision",
		})
		return
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type:    aiv1alpha1.ConditionProfileDrifted,
		Status:  metav1.ConditionTrue,
		Reason:  "ProfileRecreated",
		Message: fmt.Sprintf("Profile content hash %s differs from the last adopted revision %s; the profile may have been recreated", currentHash, stored.Revision),
	})
}

// setWorkloadsAppliedCondition sets the WorkloadsApplied condition from the
// apply outcome: True when every Service and workload is written to the
// desired version; False with the matching reason otherwise. A gate-wait for
// a not-yet-ready dependency uses WaitingForDependencies.
func setWorkloadsAppliedCondition(conditions *[]metav1.Condition, reason string, applyErr error) {
	if applyErr == nil {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionWorkloadsApplied,
			Status:  metav1.ConditionTrue,
			Reason:  "WorkloadsApplied",
			Message: "Services and workloads are applied to the desired version",
		})
		return
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type:    aiv1alpha1.ConditionWorkloadsApplied,
		Status:  metav1.ConditionFalse,
		Reason:  reason,
		Message: applyErr.Error(),
	})
}

// revisionHash computes the profile revision: the combined hash of the profile
// spec and the asset source contents (design §3.3). json.Marshal of map values
// sorts keys, keeping the hash deterministic.
func revisionHash(profile *aiv1alpha1.InferenceRuntimeProfile, assets map[string]map[string]string) string {
	h := sha256.New()
	h.Write([]byte("profile:"))
	h.Write(mustJSON(profile.Spec))
	names := make([]string, 0, len(assets))
	for name := range assets {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		_, _ = fmt.Fprintf(h, "|asset:%s=%s", name, mustJSON(assets[name]))
	}
	return fmt.Sprintf("sha256:%x", h.Sum(nil))
}

// mustJSON marshals v; marshaling the API structs cannot fail.
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
