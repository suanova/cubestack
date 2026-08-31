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
	"crypto/sha256"
	"fmt"
	"slices"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/internal/renderer"
)

// Label and annotation keys of the resources created by this controller
// (design §4.3–4.4).
const (
	inferenceServiceLabelKey = "ai.cubestack.io/inference-service"
	assetLabelKey            = "ai.cubestack.io/asset"
	modelLabelKey            = "ai.cubestack.io/model"
	profileLabelKey          = "ai.cubestack.io/profile"
	managedByLabelKey        = "ai.cubestack.io/managed-by"
	managedByValue           = "inference-Controller"

	assetSourceAnnotationKey = "ai.cubestack.io/asset-source"
	assetHashAnnotationKey   = "ai.cubestack.io/asset-hash"
)

// provisionAssets creates or updates the rendered asset ConfigMaps in the
// service namespace, deletes copies whose asset is no longer declared, and
// returns the audit statuses. A copy whose rendered data hash changed is
// updated; an unchanged copy is left alone.
func (r *InferenceServiceReconciler) provisionAssets(ctx context.Context, isvc *aiv1alpha1.InferenceService, profile *aiv1alpha1.InferenceRuntimeProfile, rendered *renderer.Result) ([]aiv1alpha1.AssetStatus, error) {
	desired := make(map[string]bool, len(profile.Spec.Assets))
	var statuses []aiv1alpha1.AssetStatus

	for _, asset := range profile.Spec.Assets {
		desired[asset.Name] = true
		data := rendered.Assets[asset.Name]
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{
				Name:      fmt.Sprintf("%s-%s", isvc.Name, asset.Name),
				Namespace: isvc.Namespace,
				Labels: map[string]string{
					inferenceServiceLabelKey: isvc.Name,
					assetLabelKey:            asset.Name,
					profileLabelKey:          isvc.Spec.ProfileRef,
					managedByLabelKey:        managedByValue,
				},
				Annotations: map[string]string{
					assetSourceAnnotationKey: asset.ConfigMapRef.Name,
					assetHashAnnotationKey:   assetDataHash(data),
				},
			},
			Data: data,
		}
		if err := ctrl.SetControllerReference(isvc, cm, r.Scheme); err != nil {
			return nil, err
		}

		existing := &corev1.ConfigMap{}
		err := r.Get(ctx, client.ObjectKey{Name: cm.Name, Namespace: cm.Namespace}, existing)
		switch {
		case apierrors.IsNotFound(err):
			if err := r.Create(ctx, cm); err != nil {
				return nil, err
			}
		case err != nil:
			return nil, err
		// Compare the copy's actual data, not the stored hash annotation: an
		// in-place edit of the data leaves the annotation untouched and must
		// still be repaired.
		case assetDataHash(existing.Data) != assetDataHash(cm.Data):
			cm.ResourceVersion = existing.ResourceVersion
			if err := r.Update(ctx, cm); err != nil {
				return nil, err
			}
		}

		statuses = append(statuses, aiv1alpha1.AssetStatus{
			Name:   asset.Name,
			Source: asset.ConfigMapRef.Name,
			Hash:   cm.Annotations[assetHashAnnotationKey],
		})
	}

	if err := r.cleanupOrphanAssets(ctx, isvc, desired); err != nil {
		return nil, err
	}

	return statuses, nil
}

// cleanupOrphanAssets deletes asset ConfigMaps this service owns whose asset
// is no longer declared by the profile (design §5.1: asset copies are cleaned
// up; model PVCs are not).
func (r *InferenceServiceReconciler) cleanupOrphanAssets(ctx context.Context, isvc *aiv1alpha1.InferenceService, desired map[string]bool) error {
	var list corev1.ConfigMapList
	if err := r.List(ctx, &list, client.InNamespace(isvc.Namespace),
		client.MatchingLabels{inferenceServiceLabelKey: isvc.Name, managedByLabelKey: managedByValue}); err != nil {
		return err
	}
	for i := range list.Items {
		asset := list.Items[i].Labels[assetLabelKey]
		if asset == "" || desired[asset] {
			continue
		}
		// The design-mandated predicate is ownerRef pointing at this service
		// AND the managed-by label: a foreign object with matching labels must
		// not be deleted.
		if owner := metav1.GetControllerOf(&list.Items[i]); owner == nil || owner.UID != isvc.UID {
			continue
		}
		if err := r.Delete(ctx, &list.Items[i]); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}

// assetDataHash is the sha256 hash of the rendered asset data, using the
// sorted k=v lines so it is deterministic.
func assetDataHash(data map[string]string) string {
	keys := make([]string, 0, len(data))
	for k := range data {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	h := sha256.New()
	for _, k := range keys {
		_, _ = fmt.Fprintf(h, "%s=%s\n", k, data[k])
	}
	return fmt.Sprintf("sha256:%x", h.Sum(nil))
}

// setProvisionedCondition sets the Provisioned condition from the provision
// outcome: True when every created resource exists, False with the matching
// reason on an API-level failure.
func setProvisionedCondition(conditions *[]metav1.Condition, reason string, provisionErr error) {
	if provisionErr == nil {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionProvisioned,
			Status:  metav1.ConditionTrue,
			Reason:  "Provisioned",
			Message: "Rendered asset ConfigMaps and model PVCs are provisioned",
		})
		return
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type:    aiv1alpha1.ConditionProvisioned,
		Status:  metav1.ConditionFalse,
		Reason:  reason,
		Message: provisionErr.Error(),
	})
}
