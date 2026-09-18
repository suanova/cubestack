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

	// SSH secret data keys. The ssh material is split across two Secrets: the
	// controller-managed host-key Secret holds the ed25519 host keypair, and the
	// authorized-keys source holds the content the workload mounts as
	// authorized_keys — the user's Secret when spec.ssh.keysSecret names one, at
	// the data key its selector names, else the controller-generated one at
	// sshClientPubKeyKey.
	sshHostKeyKey    = "ssh_host_ed25519_key"
	sshHostPubKeyKey = "ssh_host_ed25519_key.pub"

	// sshAuthorizedKeysKey is the copy of the login public key older controller
	// versions wrote into the generated Secret as the entry to mount. The mount
	// takes sshClientPubKeyKey itself now, and a leftover copy is deleted on
	// sight: it would otherwise look like the entry to edit, and editing it
	// changes nothing. It is still the conventional data key in a user's own keys
	// Secret, which spec.ssh.keysSecret names for itself.
	sshAuthorizedKeysKey = "authorized_keys"

	// The generated login keypair, written only into the controller-generated
	// authorized-keys Secret: the private key its owner can retrieve through
	// status.sshKeysSecret, and the public half the workload mounts. Only
	// sshClientPubKeyKey is ever mounted, so the private key never reaches the
	// container.
	sshClientKeyKey    = "id_ed25519"
	sshClientPubKeyKey = "id_ed25519.pub"

	// devEnvSSHKeysDelegatedLabel marks a Secret that explicitly opts in to being
	// used as an environment's SSH authorized_keys source. Only a Secret carrying
	// this label may be referenced by spec.ssh.keysSecret: reading an undelegated
	// Secret would let an environment creator exfiltrate any same-namespace Secret
	// through the managed SSH secret that the workload mounts.
	devEnvSSHKeysDelegatedLabel = "ai.cubestack.io/ssh-keys-delegated"
	devEnvSSHKeysDelegatedValue = "true"

	// workspaceClaimName is the StatefulSet volumeClaimTemplate name. The claim
	// it provisions is <claim>-<set>-<ordinal> (K8s PVC naming), i.e.
	// workspace-<env>-0, created by the StatefulSet controller rather than by
	// this one.
	workspaceClaimName = "workspace"

	// workspaceStorageClassName is the platform-predefined workspace StorageClass.
	// The workspace claim always uses this class — users cannot override it — and
	// requests ReadWriteMany so the volume can be mounted on any node and follow
	// the pod during drift rescheduling (design §7.2).
	workspaceStorageClassName = "cephfs-ephemeral"

	// permissionInitContainerName is the init container that establishes the
	// workspace claim's root ownership before the environment starts.
	permissionInitContainerName = "initialize-managed-volume"

	// permissionInitImage is the image that container runs: the upstream busybox
	// base, mirrored into the platform registry so nodes never reach Docker Hub.
	// It is deliberately not the environment's own image — a bring-your-own image
	// may be distroless, and the init container fails closed, so an image without
	// a shell would leave the environment unable to start at all. An offline
	// deployment mirrors it under the same name/host as its other images.
	permissionInitImage = "harbor.isuanova.com/suanova/busybox:1.38.0"

	// permissionInitMountPath is where that container mounts the workspace claim.
	// It is a path of the init container's own — the claim is also mounted at the
	// environment's workspace path by the main container, and the two mounts are
	// independent.
	permissionInitMountPath = "/managed"

	// The variables permissionInitScript reads. They are passed as environment
	// rather than interpolated into the script so the values the container acted
	// on are visible on the pod itself.
	permissionInitPathEnv = "WORKSPACE_PATH"
	permissionInitUIDEnv  = "WORKSPACE_UID"
	permissionInitGIDEnv  = "WORKSPACE_GID"
)

// permissionInitScript establishes the workspace claim's root ownership: the
// account the environment runs as has to own the directory it works in.
//
// `set -e` is the fail-closed requirement, not decoration: if `stat` or `chown`
// fails — a read-only filesystem, a driver that refuses the change, storage that
// is not there — the init container exits non-zero and the environment never
// starts, rather than coming up with a home it cannot write.
//
// The chown is conditional and recursive — the same pair of choices the
// fsGroupChangePolicy: OnRootMismatch it replaces made: a workspace whose root
// already carries the right owner is left alone, and one whose root does not is
// repaired all the way down. A claim provisioned from the volumeClaimTemplate
// belongs to this environment alone, so everything already in it is the
// environment's to own, and the walk therefore runs once — on the start after an
// ownership change — rather than on every start. The setgid bit is what makes
// everything the account creates afterwards inherit the directory's group.
//
// The chmod comes before the chown because that direction costs nothing on the
// common path: a claim the init container owns — every freshly provisioned one —
// is owned and grouped by the caller, so the mode is set with no capability
// involved and no chance of losing S_ISGID, and a chown preserves S_ISGID on a
// directory (the kernel clears it only on non-directories).
//
// That ordering is not what makes the sequence correct, though, and must not be
// mistaken for it. A claim outlives the identity it was initialized for: edit
// spec.runtime.securityContext on a live environment and the init container
// finds a root owned by the *previous* uid, which is neither the caller nor
// grouped with it. That path needs the container's other two capabilities, and
// both were measured on cs2 against cephfs:
//
//   - Without CAP_FOWNER the chmod is EPERM — root does not own the directory
//     and CAP_CHOWN does not help — so `set -e` takes the environment down and
//     the ownership repair never runs.
//   - With CAP_FOWNER alone it succeeds and silently does not stick: a mode
//     change from outside the file's group drops S_ISGID, leaving 0775.
//
// Measured end state for that path with all three held: 2000:2000 2775, the
// tree chowned, every level writable by the new identity.
const permissionInitScript = `set -e
current="$(stat -c '%u:%g' "$WORKSPACE_PATH")"
if [ "$current" != "$WORKSPACE_UID:$WORKSPACE_GID" ]; then
	echo "permission-init: chown -R $WORKSPACE_PATH $current -> $WORKSPACE_UID:$WORKSPACE_GID"
	chmod 2775 "$WORKSPACE_PATH"
	chown -R "$WORKSPACE_UID:$WORKSPACE_GID" "$WORKSPACE_PATH"
else
	echo "permission-init: $WORKSPACE_PATH already owned by $current"
fi
echo "permission-init: $WORKSPACE_PATH ready"
`

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
		if apierrors.IsNotFound(err) {
			if cerr := r.Create(ctx, cm); cerr == nil {
				// Fresh copy created with the rendered data: nothing to sync.
				statuses = append(statuses, aiv1alpha1.AssetStatus{
					Name:   asset.Name,
					Source: asset.ConfigMapRef.Name,
					Hash:   cm.Annotations[assetHashAnnotationKey],
				})
				continue
			} else if !apierrors.IsAlreadyExists(cerr) {
				return nil, cerr
			}
			// Lost the create race: a concurrent reconcile created the copy in
			// between. Fall through to the sync path against the winner's copy
			// instead of failing the reconcile (self-heals on requeue anyway).
			if err := r.Get(ctx, client.ObjectKey{Name: cm.Name, Namespace: cm.Namespace}, existing); err != nil {
				return nil, err
			}
		} else if err != nil {
			return nil, err
		}

		// Compare the copy's actual data, not the stored hash annotation: an
		// in-place edit of the data leaves the annotation untouched and must
		// still be repaired. A same-name foreign ConfigMap must not be
		// overwritten — only a copy owned by this service may be updated.
		if assetDataHash(existing.Data) != assetDataHash(cm.Data) {
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
