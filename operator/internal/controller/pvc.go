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
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// provisionModelPVC creates the model PVC <isvc>-model-main when the storage
// strategy is PVC (design §3.1: ReadOnlyMany, storageClassName and capacity
// from the ModelVersion, ownerRef to the service). HostPath storage needs no
// PVC. The PVC is create-only in this phase: it is never updated and never
// cleaned up (design §5.1).
func (r *InferenceServiceReconciler) provisionModelPVC(ctx context.Context, isvc *aiv1alpha1.InferenceService, model *aiv1alpha1.ModelVersion) error {
	if model.Spec.Storage.Strategy != aiv1alpha1.StorageStrategyPVC {
		return nil
	}

	sc := model.Spec.Storage.PVC.StorageClassName
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
				Requests: corev1.ResourceList{
					corev1.ResourceStorage: model.Spec.Storage.PVC.Capacity,
				},
			},
		},
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
	return ensureOwned(existing, isvc.UID)
}
