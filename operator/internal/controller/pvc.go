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

package controller

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// provisionModelPVC creates the model PVC <isvc>-model-main when the storage
// strategy is Dynamic or Static (design §3.1: ReadOnlyMany, storageClassName and
// capacity from the ModelVersion, ownerRef to the service). HostPath storage needs
// no PVC. For Static, the PVC includes a selector matching the pre-created PV's
// ai.cubestack.io/model-version label. The PVC is create-only in this phase: it is
// never updated and never cleaned up (design §5.1).
func (r *InferenceServiceReconciler) provisionModelPVC(ctx context.Context, isvc *aiv1alpha1.InferenceService, model *aiv1alpha1.ModelVersion) error {
	strategy := model.Spec.Storage.Strategy
	if strategy != aiv1alpha1.StorageStrategyDynamic && strategy != aiv1alpha1.StorageStrategyStatic {
		return nil
	}

	var sc string
	var capacity corev1.ResourceList
	switch strategy {
	case aiv1alpha1.StorageStrategyDynamic:
		sc = model.Spec.Storage.Dynamic.StorageClassName
		capacity = corev1.ResourceList{corev1.ResourceStorage: model.Spec.Storage.Dynamic.Capacity}
	case aiv1alpha1.StorageStrategyStatic:
		sc = model.Spec.Storage.Static.StorageClassName
		capacity = corev1.ResourceList{corev1.ResourceStorage: model.Spec.Storage.Static.Capacity}
	}

	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("%s-model-main", isvc.Name),
			Namespace: isvc.Namespace,
			Labels: map[string]string{
				inferenceServiceLabelKey: isvc.Name,
				modelLabelKey:            modelKeyMain,
				profileLabelKey:          isvc.Spec.ProfileRef,
				managedByLabelKey:        managedByValue,
			},
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadOnlyMany},
			StorageClassName: &sc,
			Resources: corev1.VolumeResourceRequirements{
				Requests: capacity,
			},
		},
	}

	// Static strategy: bind the PVC to a pre-created PV via a label selector
	// matching the ModelVersion name (design §3.1 Static render contract).
	if strategy == aiv1alpha1.StorageStrategyStatic {
		pvc.Spec.Selector = &metav1.LabelSelector{
			MatchLabels: map[string]string{
				modelVersionLabelKey: model.Name,
			},
		}
	}
	if err := ctrl.SetControllerReference(isvc, pvc, r.Scheme); err != nil {
		return err
	}

	existing := &corev1.PersistentVolumeClaim{}
	err := r.Get(ctx, client.ObjectKey{Name: pvc.Name, Namespace: pvc.Namespace}, existing)
	if apierrors.IsNotFound(err) {
		return r.Create(ctx, pvc)
	}
	if err != nil {
		return err
	}
	// A same-name PVC that is not controlled by this service must not be
	// accepted silently: Phase 3 workloads would bind to a foreign volume.
	if err := ensureOwned(existing, isvc.UID); err != nil {
		return err
	}
	// The owned claim is reused only while its storage identity matches the
	// resolved ModelVersion. A modelRef switch can otherwise leave the Static
	// selector or the Dynamic storageClassName of the previous immutable
	// ModelVersion on the already-bound claim, and new pods would silently
	// mount the old model data. The designed replacement path — stop the
	// consumers, delete and recreate the claim, wait for Bound, then apply the
	// workloads — is the §5.1 target behavior (TODO); until then a mismatch
	// fails loudly instead of reusing. capacity is deliberately not part of the
	// identity: an already-bound claim cannot change its request, and under the
	// Dynamic shared-root premise a same-class switch keeps serving via its
	// subPath (growth is the expansion TODO, §5.1).
	if !apiequality.Semantic.DeepEqual(existing.Spec.StorageClassName, pvc.Spec.StorageClassName) ||
		!apiequality.Semantic.DeepEqual(existing.Spec.Selector, pvc.Spec.Selector) {
		return &storageIdentityErr{msg: fmt.Sprintf(
			"PVC %s/%s exists with storageClassName %v and selector %v, but the resolved ModelVersion %s requires storageClassName %q and selector %v; a bound claim's storage identity cannot change in place — revert modelRef or delete the service (the replacement path is the design §5.1 target behavior)",
			existing.Namespace, existing.Name, existing.Spec.StorageClassName, existing.Spec.Selector,
			model.Name, sc, pvc.Spec.Selector)}
	}
	return nil
}

// storageIdentityErr marks a provision failure caused by a storage identity
// mismatch of the already-existing owned model PVC (Provisioned reason
// StorageIdentityChanged).
type storageIdentityErr struct{ msg string }

func (e *storageIdentityErr) Error() string { return e.msg }
