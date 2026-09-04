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

// +kubebuilder:rbac:groups=ai.cubestack.io,resources=modelversions,verbs=get;list;watch
// +kubebuilder:rbac:groups=ai.cubestack.io,resources=modelversions/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=ai.cubestack.io,resources=inferenceservices,verbs=get;list;watch
// +kubebuilder:rbac:groups=storage.k8s.io,resources=storageclasses,verbs=get

package controller

import (
	"context"
	"fmt"

	storagev1 "k8s.io/api/storage/v1"
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

// ModelVersionReconciler maintains the reverse index of InferenceServices
// referencing a ModelVersion: status.usedBy and the InUse condition. The
// index is fully rebuilt on every reconcile.
type ModelVersionReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// Reconcile rebuilds status.usedBy from the InferenceServices whose
// spec.modelRef points at this ModelVersion, and updates the InUse
// condition accordingly.
func (r *ModelVersionReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var mv aiv1alpha1.ModelVersion
	if err := r.Get(ctx, req.NamespacedName, &mv); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	referrers, err := r.referringServices(ctx, mv.Name)
	if err != nil {
		return ctrl.Result{}, err
	}

	desired := mv.DeepCopy()
	desired.Status.UsedBy = sortedUsedBy(referrers.Items)
	setInUseCondition(&desired.Status.Conditions, desired.Status.UsedBy)
	if err := r.setStorageResolvedCondition(ctx, &desired.Status.Conditions, &mv); err != nil {
		return ctrl.Result{}, err
	}

	if !apiequality.Semantic.DeepEqual(mv.Status, desired.Status) {
		if err := r.Status().Update(ctx, desired); err != nil {
			return ctrl.Result{}, err
		}
	}
	return ctrl.Result{}, nil
}

// setStorageResolvedCondition sets the StorageResolved condition. For Dynamic
// storage the referenced StorageClass must exist; for HostPath storage it is
// always True; for Static storage the condition is not managed here — it is set
// by the storage-side integration (go-ceph getpath/quota checks, design §3.1).
// In the manual-testing phase, the operator leaves a manually-patched
// StorageResolved condition untouched. A transient lookup error is returned so
// the reconcile is retried instead of leaving the condition stale.
func (r *ModelVersionReconciler) setStorageResolvedCondition(ctx context.Context, conditions *[]metav1.Condition, mv *aiv1alpha1.ModelVersion) error {
	switch mv.Spec.Storage.Strategy {
	case aiv1alpha1.StorageStrategyHostPath:
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionStorageResolved,
			Status:  metav1.ConditionTrue,
			Reason:  "NotApplicable",
			Message: "HostPath storage does not require a StorageClass",
		})
		return nil

	case aiv1alpha1.StorageStrategyStatic, aiv1alpha1.StorageStrategyS3:
		// Static/S3: the storage-side integration manages this condition
		// (getpath/quota for Static; prefix/credentials resolution for S3). In
		// the manual-testing phase (no storage controller), the operator does
		// not touch the condition — it may be patched manually.
		return nil

	default: // Dynamic
		sc := &storagev1.StorageClass{}
		err := r.Get(ctx, types.NamespacedName{Name: mv.Spec.Storage.Dynamic.StorageClassName}, sc)
		if apierrors.IsNotFound(err) {
			meta.SetStatusCondition(conditions, metav1.Condition{
				Type:    aiv1alpha1.ConditionStorageResolved,
				Status:  metav1.ConditionFalse,
				Reason:  "StorageClassNotFound",
				Message: fmt.Sprintf("StorageClass %q does not exist", mv.Spec.Storage.Dynamic.StorageClassName),
			})
			return nil
		}
		if err != nil {
			return err
		}
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionStorageResolved,
			Status:  metav1.ConditionTrue,
			Reason:  "StorageClassExists",
			Message: fmt.Sprintf("StorageClass %q exists", mv.Spec.Storage.Dynamic.StorageClassName),
		})
		return nil
	}
}

// referringServices lists the InferenceServices whose spec.modelRef points at
// the given ModelVersion, using the spec.modelRef cache index.
func (r *ModelVersionReconciler) referringServices(ctx context.Context, modelRef string) (*aiv1alpha1.InferenceServiceList, error) {
	list := &aiv1alpha1.InferenceServiceList{}
	if err := r.List(ctx, list, client.MatchingFields{modelRefIndexKey: modelRef}); err != nil {
		return nil, err
	}
	return list, nil
}

// SetupWithManager registers the ModelVersion watch and the InferenceService
// watch mapped through spec.modelRef, and indexes InferenceServices by
// spec.modelRef for the referring-services query.
func (r *ModelVersionReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := registerSharedIndexes(mgr); err != nil {
		return err
	}
	return ctrl.NewControllerManagedBy(mgr).
		For(&aiv1alpha1.ModelVersion{}).
		Watches(&aiv1alpha1.InferenceService{},
			handler.EnqueueRequestsFromMapFunc(r.enqueueReferencingModelVersion)).
		Complete(r)
}

// enqueueReferencingModelVersion maps an InferenceService to the ModelVersion
// it references (cluster-scoped, so the key has no namespace).
func (r *ModelVersionReconciler) enqueueReferencingModelVersion(_ context.Context, obj client.Object) []reconcile.Request {
	isvc := obj.(*aiv1alpha1.InferenceService)
	return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: isvc.Spec.ModelRef}}}
}
