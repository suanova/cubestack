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
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get;list;watch

package controller

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

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

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/internal/renderer"
)

// InferenceServiceReconciler resolves the referenced profile, model version
// and asset sources (Resolved), then validates and renders the profile
// templates (Rendered). Resource creation and readiness aggregation are
// later phases; this controller writes only status.
type InferenceServiceReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// Reconcile runs the render pipeline's generation steps (design §4.1 steps
// 1–2): resolve the references, render the templates, and report the
// Resolved and Rendered conditions in status.
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
		return ctrl.Result{}, r.updateStatusIfChanged(ctx, &isvc, desired)
	}

	rendered := renderer.Render(&isvc, resolved.profile, resolved.model, resolved.assets)
	setRenderedCondition(&desired.Status.Conditions, &rendered)

	rev := revisionHash(resolved.profile, resolved.assets)
	setProfileDriftedCondition(&desired.Status.Conditions, desired.Status.Profile, rev)
	if len(rendered.Errors) == 0 {
		desired.Status.Profile.Revision = rev
	}
	setProfileDeprecatedCondition(&desired.Status.Conditions, resolved.profile)

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
		Watches(&aiv1alpha1.ModelVersion{},
			handler.EnqueueRequestsFromMapFunc(r.enqueueReferencingServices)).
		Watches(&aiv1alpha1.InferenceRuntimeProfile{},
			handler.EnqueueRequestsFromMapFunc(r.enqueueReferencingServices)).
		Watches(&corev1.ConfigMap{},
			handler.EnqueueRequestsFromMapFunc(r.enqueueForSourceConfigMap)).
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
