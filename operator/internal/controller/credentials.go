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
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// Annotation keys of the S3 credentials copy (design §3.1 S3 strategy): the
// audit chain records which source version the copy was synced from, echoed
// into InferenceService status.model.credentials.
const (
	credentialsSourceAnnotationKey  = "ai.cubestack.io/credentials-source"
	credentialsVersionAnnotationKey = "ai.cubestack.io/credentials-source-version"
)

// credentialsVolumeName is the volume name of the S3 credentials copy inside
// the pods of roles that reference {{ model.credentialsPath }} (design §4.5).
const credentialsVolumeName = "model-credentials"

// provisionModelCredentials creates or syncs the S3 credentials Secret copy
// <isvc>-model-<key>-credentials in the service namespace (design §3.1 S3
// strategy): content copied verbatim from the source Secret in
// cubestack-system, ownerRef to the service, annotations recording the source
// name and resourceVersion. Rotation of the source Secret re-syncs the copy;
// the copy is create/update-only — never deleted here, the ownerRef GC removes
// it with the service. It returns the synced source echo, or nil when not
// applicable (non-S3 storage or no credentialsRef).
func (r *InferenceServiceReconciler) provisionModelCredentials(ctx context.Context, isvc *aiv1alpha1.InferenceService, model *aiv1alpha1.ModelVersion) (*aiv1alpha1.ModelCredentialsStatus, error) {
	if model.Spec.Storage.Strategy != aiv1alpha1.StorageStrategyS3 ||
		model.Spec.Storage.S3 == nil || model.Spec.Storage.S3.CredentialsRef == nil {
		return nil, nil
	}

	source := &corev1.Secret{}
	if err := r.Get(ctx, types.NamespacedName{Namespace: systemNamespace, Name: model.Spec.Storage.S3.CredentialsRef.Name}, source); err != nil {
		return nil, err
	}
	// The single-key contract is enforced here rather than at the mount: the
	// pod volume maps the key to the fixed single file, so a source Secret
	// without it would only fail at kubelet time.
	if _, ok := source.Data[aiv1alpha1.ModelCredentialsKey]; !ok {
		return nil, fmt.Errorf("source credentials Secret %q in %s must contain data key %q",
			source.Name, systemNamespace, aiv1alpha1.ModelCredentialsKey)
	}

	secretType := source.Type
	if secretType == "" {
		secretType = corev1.SecretTypeOpaque
	}
	name := fmt.Sprintf("%s-model-%s-credentials", isvc.Name, modelKeyMain)
	copy := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: isvc.Namespace,
			Labels: map[string]string{
				inferenceServiceLabelKey: isvc.Name,
				modelLabelKey:            modelKeyMain,
				profileLabelKey:          isvc.Spec.ProfileRef,
				managedByLabelKey:        managedByValue,
			},
			Annotations: map[string]string{
				credentialsSourceAnnotationKey:  source.Name,
				credentialsVersionAnnotationKey: source.ResourceVersion,
			},
		},
		Type: secretType,
		Data: source.Data,
	}
	if err := ctrl.SetControllerReference(isvc, copy, r.Scheme); err != nil {
		return nil, err
	}

	existing := &corev1.Secret{}
	err := r.Get(ctx, client.ObjectKey{Name: copy.Name, Namespace: copy.Namespace}, existing)
	switch {
	case apierrors.IsNotFound(err):
		if err := r.Create(ctx, copy); err != nil {
			return nil, err
		}
	case err != nil:
		return nil, err
	default:
		// A same-name Secret not controlled by this service must never be
		// accepted silently: the pod volumes would consume a foreign secret.
		if err := ensureOwned(existing, isvc.UID); err != nil {
			return nil, err
		}
		// Re-sync on content or source-version change (rotation). Compare the
		// copy's actual data, not the annotation: an in-place edit of the copy
		// must still be repaired.
		if !apiequality.Semantic.DeepEqual(existing.Data, copy.Data) ||
			existing.Annotations[credentialsSourceAnnotationKey] != source.Name ||
			existing.Annotations[credentialsVersionAnnotationKey] != source.ResourceVersion {
			copy.ResourceVersion = existing.ResourceVersion
			if err := r.Update(ctx, copy); err != nil {
				return nil, err
			}
		}
	}

	return &aiv1alpha1.ModelCredentialsStatus{Source: source.Name, ResourceVersion: source.ResourceVersion}, nil
}

// addCredentialsVolume injects the S3 credentials Secret volume of
// <isvc>-model-<key>-credentials into the pod spec of a role that referenced
// {{ model.credentialsPath }} (design §4.5): the single credentials key is
// mounted read-only as the fixed file ModelCredentialsFilePath.
func addCredentialsVolume(spec *corev1.PodSpec, isvcName string) {
	volume := corev1.Volume{
		Name: credentialsVolumeName,
		VolumeSource: corev1.VolumeSource{
			Secret: &corev1.SecretVolumeSource{
				SecretName: fmt.Sprintf("%s-model-%s-credentials", isvcName, modelKeyMain),
				// 0444: the engine container may run as a non-root user.
				DefaultMode: ptr(int32(0444)),
				Items: []corev1.KeyToPath{
					{Key: aiv1alpha1.ModelCredentialsKey, Path: aiv1alpha1.ModelCredentialsFile},
				},
			},
		},
	}
	spec.Volumes = append(spec.Volumes, volume)
	spec.Containers[0].VolumeMounts = append(spec.Containers[0].VolumeMounts, corev1.VolumeMount{
		Name:      credentialsVolumeName,
		MountPath: aiv1alpha1.ModelCredentialsDir,
		ReadOnly:  true,
	})
}
