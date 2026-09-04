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
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
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

	// modelVersionLabelKey is used on static PVs for PVC selector binding (design §3.1).
	modelVersionLabelKey = "ai.cubestack.io/model-version"

	// Labels, finalizer, and SSH secret data keys of the resources created for
	// a DevEnvironment (design §4.3–4.4, §6.2–6.3).
	devEnvironmentLabelKey = "ai.cubestack.io/dev-environment"
	devEnvManagedByValue   = "devenv-controller"
	devEnvFinalizer        = "ai.cubestack.io/dev-env-finalizer"

	// SSH secret data keys: the managed secret holds the ed25519 host keypair
	// plus the authorized_keys content assembled from spec.ssh.keysSecret (data
	// key "keys" by default, per the design's sample CR).
	sshHostKeyKey         = "ssh_host_ed25519_key"
	sshHostPubKeyKey      = "ssh_host_ed25519_key.pub"
	sshAuthorizedKeysKey  = "authorized_keys"
	sshUserKeysDefaultKey = "keys"

	// devEnvSSHKeysDelegatedLabel marks a Secret that explicitly opts in to being
	// used as an environment's SSH authorized_keys source. Only a Secret carrying
	// this label may be referenced by spec.ssh.keysSecret: reading an undelegated
	// Secret would let an environment creator exfiltrate any same-namespace Secret
	// through the managed SSH secret that the workload mounts.
	devEnvSSHKeysDelegatedLabel = "ai.cubestack.io/ssh-keys-delegated"
	devEnvSSHKeysDelegatedValue = "true"

	// workspaceClaimName is the StatefulSet volumeClaimTemplate name; the
	// controller creates the PVC <env>-workspace-0 from it (K8s PVC naming:
	// <sts>-<claim>-<ordinal>).
	workspaceClaimName = "workspace"
)

// modelKeyMain is the model key of the main model; model volumes are named
// model-<key> (design §4.5, v1alpha1 fixes the key to main).
const modelKeyMain = "main"

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
		// still be repaired. A same-name foreign ConfigMap must not be
		// overwritten — only a copy owned by this service may be updated.
		case assetDataHash(existing.Data) != assetDataHash(cm.Data):
			if err := ensureOwned(existing, isvc.UID); err != nil {
				return nil, err
			}
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
// canonical JSON form (json.Marshal sorts map keys) so it is deterministic
// and injective: a k=v\n concatenation would collide across values such as
// {"a":"x\nb=y"} and {"a":"x","b":"y"}.
func assetDataHash(data map[string]string) string {
	h := sha256.New()
	h.Write(mustJSON(data))
	return fmt.Sprintf("sha256:%x", h.Sum(nil))
}

// ensureOwned verifies that an existing resource is controlled by the given
// InferenceService. A same-name resource owned by someone else — or not owned
// at all — must never be updated or accepted; the caller returns a conflict
// so the reconcile fails visibly instead of mutating foreign objects.
func ensureOwned(existing client.Object, uid types.UID) error {
	if owner := metav1.GetControllerOf(existing); owner == nil || owner.UID != uid {
		gvk := existing.GetObjectKind().GroupVersionKind()
		return apierrors.NewConflict(schema.GroupResource{Group: gvk.Group, Resource: strings.ToLower(gvk.Kind) + "s"}, existing.GetName(),
			fmt.Errorf("resource is not controlled by InferenceService %q", uid))
	}
	return nil
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
			Message: "Rendered asset ConfigMaps, model PVCs and S3 credentials copies are provisioned",
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
