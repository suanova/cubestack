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
	"slices"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// resolveResult carries the referenced objects and the outcome of the Resolved
// checks. failures is non-empty when the service does not resolve; reason is
// the first failing check's reason (see design §3.3).
type resolveResult struct {
	profile  *aiv1alpha1.InferenceRuntimeProfile
	model    *aiv1alpha1.ModelVersion
	assets   map[string]map[string]string // asset name → source ConfigMap data
	failures []string
	reason   string
}

// resolved reports whether all reference checks passed.
func (rr *resolveResult) resolved() bool { return len(rr.failures) == 0 }

// resolve runs the Resolved checks in order: profile exists, model exists and
// is compatible, all asset sources exist in cubestack-system, and Static model
// storage is resolved. All checks run so the message aggregates every failure;
// reason is the first one (design §3.3).
func (r *InferenceServiceReconciler) resolve(ctx context.Context, isvc *aiv1alpha1.InferenceService) (*resolveResult, error) {
	rr := &resolveResult{assets: map[string]map[string]string{}}

	profile := &aiv1alpha1.InferenceRuntimeProfile{}
	if err := r.Get(ctx, types.NamespacedName{Name: isvc.Spec.ProfileRef}, profile); err != nil {
		if apierrors.IsNotFound(err) {
			rr.failures = append(rr.failures, fmt.Sprintf("ProfileRef %q does not exist", isvc.Spec.ProfileRef))
			rr.reason = "ProfileNotFound"
		} else {
			return nil, err
		}
	} else {
		rr.profile = profile
	}

	model := &aiv1alpha1.ModelVersion{}
	if err := r.Get(ctx, types.NamespacedName{Name: isvc.Spec.ModelRef}, model); err != nil {
		if apierrors.IsNotFound(err) {
			rr.failures = append(rr.failures, fmt.Sprintf("ModelRef %q does not exist", isvc.Spec.ModelRef))
			if rr.reason == "" {
				rr.reason = "ModelNotFound"
			}
		} else {
			return nil, err
		}
	} else {
		rr.model = model
	}

	if rr.profile != nil && rr.model != nil {
		if !slices.Contains(rr.profile.Spec.ModelRequirements.Architectures, rr.model.Spec.Architecture) ||
			!slices.Contains(rr.profile.Spec.ModelRequirements.Quantization, rr.model.Spec.Quantization) {
			rr.failures = append(rr.failures, fmt.Sprintf(
				"Model %s/%s is not supported by profile %s (requires architecture in %v and quantization in %v)",
				rr.model.Spec.Architecture, rr.model.Spec.Quantization, rr.profile.Name,
				rr.profile.Spec.ModelRequirements.Architectures, rr.profile.Spec.ModelRequirements.Quantization))
			if rr.reason == "" {
				rr.reason = "ModelIncompatible"
			}
		}

		// S3 storage is consumed by URI, never by a mounted volume: a profile
		// declaring podTemplate mounts[] is incompatible with an S3 ModelVersion.
		// Checked before the asset sources so the reason priority follows the
		// documented order (design §3.3 Resolved).
		if rr.model.Spec.Storage.Strategy == aiv1alpha1.StorageStrategyS3 {
			for _, role := range rr.profile.Spec.Roles {
				if len(role.PodTemplate.Mounts) > 0 {
					rr.failures = append(rr.failures, fmt.Sprintf(
						"ModelVersion %s uses S3 storage but profile %s declares podTemplate mounts[] (an S3 engine consumes the model by URI, design §4.5)",
						rr.model.Name, rr.profile.Name))
					if rr.reason == "" {
						rr.reason = "ModelStorageIncompatible"
					}
					break
				}
			}
		}
	}

	if rr.profile != nil {
		for _, asset := range rr.profile.Spec.Assets {
			cm := &corev1.ConfigMap{}
			if err := r.Get(ctx, types.NamespacedName{Namespace: systemNamespace, Name: asset.ConfigMapRef.Name}, cm); err != nil {
				if apierrors.IsNotFound(err) {
					rr.failures = append(rr.failures, fmt.Sprintf("Asset source ConfigMap %q not found in %s", asset.ConfigMapRef.Name, systemNamespace))
					if rr.reason == "" {
						rr.reason = "AssetNotFound"
					}
				} else {
					return nil, err
				}
			} else {
				rr.assets[asset.Name] = cm.Data
			}
		}
	}

	// Static/S3 strategy: require StorageResolved=True on the ModelVersion
	// (the storage unit resolved by the storage-side integration or patched
	// manually; design §3.3 Resolved). This check runs last so the reason
	// priority follows the documented order: ProfileNotFound → ModelNotFound
	// → ModelIncompatible → ModelStorageIncompatible → AssetNotFound →
	// ModelStorageUnresolved.
	if rr.model != nil && (rr.model.Spec.Storage.Strategy == aiv1alpha1.StorageStrategyStatic ||
		rr.model.Spec.Storage.Strategy == aiv1alpha1.StorageStrategyS3) {
		if !meta.IsStatusConditionTrue(rr.model.Status.Conditions, aiv1alpha1.ConditionStorageResolved) {
			rr.failures = append(rr.failures, fmt.Sprintf(
				"ModelVersion %s storage is not resolved (StorageResolved is not True)",
				rr.model.Name))
			if rr.reason == "" {
				rr.reason = "ModelStorageUnresolved"
			}
		}
	}

	return rr, nil
}

// setResolvedCondition sets the Resolved condition from the resolve outcome.
func setResolvedCondition(conditions *[]metav1.Condition, rr *resolveResult) {
	if rr.resolved() {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionResolved,
			Status:  metav1.ConditionTrue,
			Reason:  "Resolved",
			Message: "References resolve and the model is compatible",
		})
		return
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type:    aiv1alpha1.ConditionResolved,
		Status:  metav1.ConditionFalse,
		Reason:  rr.reason,
		Message: strings.Join(rr.failures, "; "),
	})
}
