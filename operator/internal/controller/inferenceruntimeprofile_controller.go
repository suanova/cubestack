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

// +kubebuilder:rbac:groups=ai.cubestack.io,resources=inferenceruntimeprofiles,verbs=get;list;watch
// +kubebuilder:rbac:groups=ai.cubestack.io,resources=inferenceruntimeprofiles/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=ai.cubestack.io,resources=inferenceservices,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get

package controller

import (
	"context"
	"fmt"
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
)

// profileRefIndexKey is the cache index field for InferenceService.spec.profileRef.
const profileRefIndexKey = "spec.profileRef"

// systemNamespace hosts the source ConfigMaps referenced by profile assets.
const systemNamespace = "cubestack-system"

// InferenceRuntimeProfileReconciler maintains the reverse index of
// InferenceServices referencing an InferenceRuntimeProfile (status.usedBy and
// the InUse condition, fully rebuilt on every reconcile) and the
// AssetsResolved condition, which checks that all asset source ConfigMaps
// exist in cubestack-system and are immutable.
type InferenceRuntimeProfileReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// Reconcile rebuilds status.usedBy from the InferenceServices whose
// spec.profileRef points at this profile, and resolves the asset sources.
func (r *InferenceRuntimeProfileReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var irp aiv1alpha1.InferenceRuntimeProfile
	if err := r.Get(ctx, req.NamespacedName, &irp); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	referrers, err := r.referringServices(ctx, irp.Name)
	if err != nil {
		return ctrl.Result{}, err
	}

	desired := irp.DeepCopy()
	desired.Status.UsedBy = sortedUsedBy(referrers.Items)
	setInUseCondition(&desired.Status.Conditions, desired.Status.UsedBy)
	if err := r.setAssetsResolvedCondition(ctx, &desired.Status.Conditions, &irp); err != nil {
		return ctrl.Result{}, err
	}

	if !apiequality.Semantic.DeepEqual(irp.Status, desired.Status) {
		if err := r.Status().Update(ctx, desired); err != nil {
			return ctrl.Result{}, err
		}
	}
	return ctrl.Result{}, nil
}

// referringServices lists the InferenceServices whose spec.profileRef points
// at the given profile, using the spec.profileRef cache index.
func (r *InferenceRuntimeProfileReconciler) referringServices(ctx context.Context, profileRef string) (*aiv1alpha1.InferenceServiceList, error) {
	list := &aiv1alpha1.InferenceServiceList{}
	if err := r.List(ctx, list, client.MatchingFields{profileRefIndexKey: profileRef}); err != nil {
		return nil, err
	}
	return list, nil
}

// setAssetsResolvedCondition sets the AssetsResolved condition: every
// assets[].configMapRef.name must exist in cubestack-system and be immutable.
// A profile without assets is always resolved. A transient lookup error is
// returned so the reconcile is retried instead of leaving the condition
// stale.
func (r *InferenceRuntimeProfileReconciler) setAssetsResolvedCondition(ctx context.Context, conditions *[]metav1.Condition, irp *aiv1alpha1.InferenceRuntimeProfile) error {
	if len(irp.Spec.Assets) == 0 {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionAssetsResolved,
			Status:  metav1.ConditionTrue,
			Reason:  "NotApplicable",
			Message: "Profile declares no assets",
		})
		return nil
	}

	var missing, mutable []string
	for _, asset := range irp.Spec.Assets {
		cm := &corev1.ConfigMap{}
		err := r.Get(ctx, types.NamespacedName{Namespace: systemNamespace, Name: asset.ConfigMapRef.Name}, cm)
		if apierrors.IsNotFound(err) {
			missing = append(missing, asset.ConfigMapRef.Name)
			continue
		}
		if err != nil {
			return err
		}
		if cm.Immutable == nil || !*cm.Immutable {
			mutable = append(mutable, asset.ConfigMapRef.Name)
		}
	}

	switch {
	case len(missing) > 0:
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionAssetsResolved,
			Status:  metav1.ConditionFalse,
			Reason:  "AssetNotFound",
			Message: fmt.Sprintf("Source ConfigMaps not found in %s: %s", systemNamespace, strings.Join(missing, ", ")),
		})
	case len(mutable) > 0:
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionAssetsResolved,
			Status:  metav1.ConditionFalse,
			Reason:  "ConfigMapNotImmutable",
			Message: fmt.Sprintf("Source ConfigMaps must be immutable: %s", strings.Join(mutable, ", ")),
		})
	default:
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionAssetsResolved,
			Status:  metav1.ConditionTrue,
			Reason:  "Resolved",
			Message: "All source ConfigMaps exist and are immutable",
		})
	}
	return nil
}

// SetupWithManager registers the InferenceRuntimeProfile watch and the
// InferenceService watch mapped through spec.profileRef, and indexes
// InferenceServices by spec.profileRef for the referring-services query.
func (r *InferenceRuntimeProfileReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := mgr.GetCache().IndexField(context.Background(), &aiv1alpha1.InferenceService{}, profileRefIndexKey,
		func(o client.Object) []string {
			return []string{o.(*aiv1alpha1.InferenceService).Spec.ProfileRef}
		}); err != nil {
		return err
	}
	return ctrl.NewControllerManagedBy(mgr).
		For(&aiv1alpha1.InferenceRuntimeProfile{}).
		Watches(&aiv1alpha1.InferenceService{},
			handler.EnqueueRequestsFromMapFunc(r.enqueueReferencingProfile)).
		Complete(r)
}

// enqueueReferencingProfile maps an InferenceService to the profile it
// references (cluster-scoped, so the key has no namespace).
func (r *InferenceRuntimeProfileReconciler) enqueueReferencingProfile(_ context.Context, obj client.Object) []reconcile.Request {
	isvc := obj.(*aiv1alpha1.InferenceService)
	return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: isvc.Spec.ProfileRef}}}
}
