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

package v1alpha1

import (
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// StorageStrategy defines how the model storage is provided.
// +kubebuilder:validation:Enum=HostPath;PVC
type StorageStrategy string

const (
	// StorageStrategyHostPath means the model has been pre-distributed on nodes.
	StorageStrategyHostPath StorageStrategy = "HostPath"

	// StorageStrategyPVC means the controller creates a PVC in the service namespace.
	StorageStrategyPVC StorageStrategy = "PVC"
)

// HostPathStorage specifies the pre-distributed model root directory on nodes.
type HostPathStorage struct {
	// Path is the absolute path of the pre-distributed model root directory.
	// +kubebuilder:validation:Pattern="^/"
	Path string `json:"path"`
}

// PVCStorage specifies the shared-storage configuration used to create the model PVC.
type PVCStorage struct {
	// StorageClassName references a StorageClass created by the platform admin.
	// +kubebuilder:validation:MinLength=1
	StorageClassName string `json:"storageClassName"`

	// SubPath is the model directory within the shared storage, organized as <model>/<version>.
	// +kubebuilder:validation:MinLength=1
	SubPath string `json:"subPath"`

	// Capacity is written to spec.resources.requests.storage of the created PVC.
	Capacity resource.Quantity `json:"capacity"`
}

// ModelStorage defines where and how the model is provided.
// strategy selects one of the storage configurations; the other block must be absent.
// +kubebuilder:validation:XValidation:rule="self.strategy == 'HostPath' ? (has(self.hostPath) && !has(self.pvc)) : (self.strategy == 'PVC' ? (has(self.pvc) && !has(self.hostPath)) : true)",message="strategy HostPath requires hostPath and forbids pvc; strategy PVC requires pvc and forbids hostPath"
type ModelStorage struct {
	// Strategy selects how the model storage is provided.
	// +kubebuilder:validation:Required
	Strategy StorageStrategy `json:"strategy"`

	// HostPath is the pre-distributed model configuration, required when strategy is HostPath.
	// +optional
	HostPath *HostPathStorage `json:"hostPath,omitempty"`

	// PVC is the shared-storage configuration, required when strategy is PVC.
	// +optional
	PVC *PVCStorage `json:"pvc,omitempty"`
}

// ModelVersionSpec defines the desired state of ModelVersion
type ModelVersionSpec struct {
	// Model is the semantic model name; together with version it determines metadata.name.
	// +kubebuilder:validation:MinLength=1
	Model string `json:"model"`

	// Version is the model version. Model names may contain '-', so the version
	// cannot be reliably parsed back from metadata.name and is stored explicitly.
	// +kubebuilder:validation:MinLength=1
	Version string `json:"version"`

	// Architecture is the model architecture identifier, from the model_type of
	// HuggingFace or the internal config.json, e.g. deepseek_v4.
	// +kubebuilder:validation:MinLength=1
	Architecture string `json:"architecture"`

	// Quantization is the weight quantization method, e.g. w8a8.
	// +kubebuilder:validation:MinLength=1
	Quantization string `json:"quantization"`

	// Meta is a free-form map maintained by the admin, e.g. for launcher names
	// that differ from the architecture.
	// +optional
	Meta map[string]string `json:"meta,omitempty"`

	// Storage defines where and how the model is provided.
	Storage ModelStorage `json:"storage"`
}

// ObjectRef identifies an InferenceService referencing this ModelVersion.
type ObjectRef struct {
	// Namespace is the namespace of the referencing InferenceService.
	Namespace string `json:"namespace"`

	// Name is the name of the referencing InferenceService.
	Name string `json:"name"`
}

// ModelVersionStatus defines the observed state of ModelVersion.
type ModelVersionStatus struct {
	// UsedBy lists the InferenceServices currently referencing this ModelVersion.
	// +optional
	UsedBy []ObjectRef `json:"usedBy,omitempty"`

	// conditions represent the current state of the ModelVersion resource.
	// Each condition has a unique type and reflects the status of a specific aspect of the resource.
	//
	// Standard condition types include:
	// - "StorageResolved": the referenced StorageClass exists (PVC strategy only)
	// - "InUse": the ModelVersion is referenced by at least one InferenceService
	//
	// The status of each condition is one of True, False, or Unknown.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Cluster
// +kubebuilder:printcolumn:name="Model",type=string,JSONPath=".spec.model"
// +kubebuilder:printcolumn:name="Version",type=string,JSONPath=".spec.version"

// ModelVersion is the Schema for the modelversions API
type ModelVersion struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of ModelVersion
	// +required
	Spec ModelVersionSpec `json:"spec"`

	// status defines the observed state of ModelVersion
	// +optional
	Status ModelVersionStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// ModelVersionList contains a list of ModelVersion
type ModelVersionList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []ModelVersion `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &ModelVersion{}, &ModelVersionList{})
		return nil
	})
}
