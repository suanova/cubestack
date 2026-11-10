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

// DatasetStorage defines where and how a dataset version is provided.
// strategy selects one of the storage configurations; the other blocks must be absent.
// +kubebuilder:validation:XValidation:rule="self.strategy == 'HostPath' ? (has(self.hostPath) && !has(self.dynamic) && !has(self.static) && !has(self.s3)) : (self.strategy == 'Dynamic' ? (has(self.dynamic) && !has(self.hostPath) && !has(self.static) && !has(self.s3)) : (self.strategy == 'Static' ? (has(self.static) && !has(self.hostPath) && !has(self.dynamic) && !has(self.s3)) : (self.strategy == 'S3' ? (has(self.s3) && !has(self.hostPath) && !has(self.dynamic) && !has(self.static)) : true)))",message="Exactly one of hostPath, dynamic, static, or s3 must be set for the chosen strategy"
type DatasetStorage struct {
	// Strategy selects how the dataset storage is provided.
	// +kubebuilder:validation:Required
	Strategy StorageStrategy `json:"strategy"`

	// HostPath is the pre-distributed dataset configuration, required when strategy is HostPath.
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

// DatasetSpec defines the desired state of a dataset version.
type DatasetSpec struct {
	// Dataset is the semantic dataset name; versions of the same dataset share it.
	// +kubebuilder:validation:MinLength=1
	Dataset string `json:"dataset"`

	// Version is the dataset version. Dataset names may contain '-', so the version
	// cannot be reliably parsed back from metadata.name and is stored explicitly.
	// +kubebuilder:validation:MinLength=1
	Version string `json:"version"`

	// Format is the physical data format, e.g. Parquet, JSONL, WebDataset or DICOM.
	// +kubebuilder:validation:MinLength=1
	Format string `json:"format"`

	// Size is the total size of the dataset version. Optional because some
	// registries only know it after the data has been materialized.
	// +optional
	Size *resource.Quantity `json:"size,omitempty"`

	// RecordCount is the number of rows, samples or images in the dataset version.
	// +optional
	// +kubebuilder:validation:Minimum=0
	RecordCount *int64 `json:"recordCount,omitempty"`

	// Meta is a free-form map maintained by the admin.
	// +optional
	Meta map[string]string `json:"meta,omitempty"`

	// Storage defines where and how the dataset is provided.
	Storage DatasetStorage `json:"storage"`
}

// +kubebuilder:object:root=true
// +kubebuilder:resource:scope=Cluster
// +kubebuilder:printcolumn:name="Dataset",type=string,JSONPath=".spec.dataset"
// +kubebuilder:printcolumn:name="Version",type=string,JSONPath=".spec.version"
// +kubebuilder:printcolumn:name="Format",type=string,JSONPath=".spec.format"

// Dataset is the Schema for the datasets API
type Dataset struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of Dataset
	// +required
	Spec DatasetSpec `json:"spec"`
}

// +kubebuilder:object:root=true

// DatasetList contains a list of Dataset
type DatasetList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Dataset `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &Dataset{}, &DatasetList{})
		return nil
	})
}
