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
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=leaderworkerset.x-k8s.io,resources=leaderworkersets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=httproutes,verbs=get;list;watch;create;update;patch;delete

package controller

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
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
	// GatewayDomain is the platform domain; the public hostname of a published
	// service is <modelName>.<GatewayDomain> (design §3.3).
	GatewayDomain string
	// GatewayName and GatewayNamespace select the platform Gateway the
	// HTTPRoutes of published services attach to.
	GatewayName      string
	GatewayNamespace string
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
	if resolved.profile != nil {
		desired.Status.Profile = &aiv1alpha1.ProfileStatus{Name: resolved.profile.Name}
		// Keep the last adopted revision of the same profile: ProfileDrifted
		// compares the current hash against it while changed profile content is
		// not yet adopted. A different profile has no baseline revision.
		if isvc.Status.Profile != nil && isvc.Status.Profile.Name == resolved.profile.Name {
			desired.Status.Profile.Revision = isvc.Status.Profile.Revision
		}
	} else if isvc.Status.Profile != nil && isvc.Status.Profile.Name != isvc.Spec.ProfileRef {
		// A switched reference must not linger, but a same-name reference
		// keeps its echo — including the adopted revision, the drift baseline
		// that must survive the profile's deletion and recreation.
		desired.Status.Profile = nil
	}
	if resolved.model != nil {
		desired.Status.Model = &aiv1alpha1.ModelStatus{Name: resolved.model.Spec.Model, Version: resolved.model.Spec.Version}
	} else {
		desired.Status.Model = nil
	}

	if !resolved.resolved() {
		// A stale Rendered from a previous spec must not persist.
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionRendered)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionProvisioned)
		meta.RemoveStatusCondition(&desired.Status.Conditions, aiv1alpha1.ConditionWorkloadsApplied)
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
			setProvisionedCondition(&desired.Status.Conditions, "PVCCreateFailed", err)
			statusErr := r.updateStatusIfChanged(ctx, &isvc, desired)
			if statusErr != nil {
				return ctrl.Result{}, statusErr
			}
			// Return the provision error so the reconcile is requeued; the
			// status write must not swallow it.
			return ctrl.Result{}, err
		}
		desired.Status.Assets = assetStatuses
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

		hostname := publicHostname(desired, r.GatewayDomain)
		route, err := r.checkRoute(ctx, desired, resolved.profile, endpoint, hostname)
		if err != nil {
			return ctrl.Result{}, err
		}
		setRouteReadyCondition(&desired.Status.Conditions, route)
		if hostname != "" && route.Reason == "" {
			desired.Status.Endpoint.Public = "https://" + hostname
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
	return ctrl.NewControllerManagedBy(mgr).
		For(&aiv1alpha1.InferenceService{}).
		Owns(&corev1.ConfigMap{}).
		Owns(&corev1.PersistentVolumeClaim{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.Service{}).
		Watches(&aiv1alpha1.ModelVersion{},
			handler.EnqueueRequestsFromMapFunc(r.enqueueReferencingServices)).
		Watches(&aiv1alpha1.InferenceRuntimeProfile{},
			handler.EnqueueRequestsFromMapFunc(r.enqueueReferencingServices)).
		Watches(&corev1.ConfigMap{},
			handler.EnqueueRequestsFromMapFunc(r.enqueueForSourceConfigMap)).
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

// enqueueForOwnedLWS maps a LeaderWorkerSet to the InferenceService owning it.
func (r *InferenceServiceReconciler) enqueueForOwnedLWS(ctx context.Context, obj client.Object) []reconcile.Request {
	lws := obj.(*leaderworkersetv1.LeaderWorkerSet)
	if owner := metav1.GetControllerOf(lws); owner != nil && owner.Kind == "InferenceService" {
		return []reconcile.Request{{NamespacedName: types.NamespacedName{Namespace: lws.Namespace, Name: owner.Name}}}
	}
	return nil
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
