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
// +kubebuilder:validation:Enum=HostPath;Dynamic;Static;S3
type StorageStrategy string

const (
	// StorageStrategyHostPath means the model has been pre-distributed on nodes.
	StorageStrategyHostPath StorageStrategy = "HostPath"

	// StorageStrategyDynamic means the controller creates a PVC in the service namespace.
	StorageStrategyDynamic StorageStrategy = "Dynamic"

	// StorageStrategyStatic means the model data is pre-provisioned; the controller creates
	// a PVC with a selector that binds to a statically created PV. (CephFS subvolume for now)
	StorageStrategyStatic StorageStrategy = "Static"

	// StorageStrategyS3 means the model data lives under an S3 object prefix and the
	// engine pulls it directly by URI; the platform only passes location and identity
	// (design §3.1 S3 strategy).
	StorageStrategyS3 StorageStrategy = "S3"
)

// HostPathStorage specifies the pre-distributed model root directory on nodes.
type HostPathStorage struct {
	// Path is the absolute path of the pre-distributed model root directory.
	// +kubebuilder:validation:Pattern="^/"
	Path string `json:"path"`
}

// DynamicStorage holds the configuration for the Dynamic storage strategy:
// the controller creates a PVC from the named StorageClass (design §3.1).
type DynamicStorage struct {
	// StorageClassName references a StorageClass created by the platform admin.
	// +kubebuilder:validation:MinLength=1
	StorageClassName string `json:"storageClassName"`

	// SubPath is the model directory within the shared storage, organized as <model>/<version>.
	// +kubebuilder:validation:MinLength=1
	SubPath string `json:"subPath"`

	// Capacity is written to spec.resources.requests.storage of the created PVC.
	Capacity resource.Quantity `json:"capacity"`
}

// StaticStorage holds the configuration for the Static storage strategy:
// the controller creates a PVC with a selector to bind to a pre-created PV (design §3.1).
type StaticStorage struct {
	// StorageClassName references the no-provisioner StorageClass of the pre-created PVs.
	// +kubebuilder:validation:MinLength=1
	StorageClassName string `json:"storageClassName"`

	// Capacity declares the model storage size; it is written to the PVC request and
	// validated against the storage-side quota by the storage integration.
	Capacity resource.Quantity `json:"capacity"`
}

// S3CredentialsRef names the platform-held credentials Secret in
// cubestack-system; the controller copies it into the service namespace.
type S3CredentialsRef struct {
	// Name is the credentials Secret name in cubestack-system, scoped read-only
	// to the model's uri prefix by the platform admin.
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`
}

// S3Storage holds the configuration for the S3 strategy: the engine pulls the
// model directly from the object prefix; the platform passes location and
// identity only (design §3.1 S3 strategy).
type S3Storage struct {
	// URI is the S3 prefix of the model data, <bucket>/<prefix>/<model>/<version>.
	// +kubebuilder:validation:Pattern="^s3://"
	URI string `json:"uri"`

	// CredentialsRef optionally names the credentials Secret in cubestack-system
	// that the controller copies into the service namespace. Absent means
	// anonymous reads or node-level identity.
	// +optional
	CredentialsRef *S3CredentialsRef `json:"credentialsRef,omitempty"`
}

// ModelStorage defines where and how the model is provided.
// strategy selects one of the storage configurations; the other blocks must be absent.
// +kubebuilder:validation:XValidation:rule="self.strategy == 'HostPath' ? (has(self.hostPath) && !has(self.dynamic) && !has(self.static) && !has(self.s3)) : (self.strategy == 'Dynamic' ? (has(self.dynamic) && !has(self.hostPath) && !has(self.static) && !has(self.s3)) : (self.strategy == 'Static' ? (has(self.static) && !has(self.hostPath) && !has(self.dynamic) && !has(self.s3)) : (self.strategy == 'S3' ? (has(self.s3) && !has(self.hostPath) && !has(self.dynamic) && !has(self.static)) : true)))",message="Exactly one of hostPath, dynamic, static, or s3 must be set for the chosen strategy"
type ModelStorage struct {
	// Strategy selects how the model storage is provided.
	// +kubebuilder:validation:Required
	Strategy StorageStrategy `json:"strategy"`

	// HostPath is the pre-distributed model configuration, required when strategy is HostPath.
	// +optional
	HostPath *HostPathStorage `json:"hostPath,omitempty"`

	// Dynamic is the shared-storage configuration, required when strategy is Dynamic.
	// +optional
	Dynamic *DynamicStorage `json:"dynamic,omitempty"`

	// Static is the pre-provisioned PV configuration, required when strategy is Static.
	// +optional
	Static *StaticStorage `json:"static,omitempty"`

	// S3 is the direct-S3 configuration, required when strategy is S3.
	// +optional
	S3 *S3Storage `json:"s3,omitempty"`
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

	// RootPath is the resolved storage unit identifier for the Static strategy
	// (design §3.1): the real path (including the storage-generated uuid) parsed
	// by the storage-side integration (currently patched manually for testing).
	// Empty for Dynamic/HostPath/S3 — S3 has no storage-side resolution product.
	// +optional
	RootPath string `json:"rootPath,omitempty"`

	// conditions represent the current state of the ModelVersion resource.
	// Each condition has a unique type and reflects the status of a specific aspect of the resource.
	//
	// Standard condition types include (see conditions.go for the constants):
	// - ConditionStorageResolved: Dynamic — the referenced StorageClass exists;
	//   Static/S3 — the storage unit is resolvable (handled by storage-side
	//   integration, currently patched manually); HostPath — always True.
	// - ConditionInUse: the ModelVersion is referenced by at least one InferenceService
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
