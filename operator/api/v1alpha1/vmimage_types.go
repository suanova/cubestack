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
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// VMImageSpec describes one guest OS image in the platform catalogue. The
// catalogue is cluster-scoped and maintained by administrators; an environment
// references an entry by name and cannot name any other source.
// +kubebuilder:validation:XValidation:rule="(has(self.source.registry) && size(self.source.registry) > 0 && !has(self.source.pvc)) || (!has(self.source.registry) && has(self.source.pvc))",message="exactly one of source.registry and source.pvc is required"
type VMImageSpec struct {
	// DisplayName is the human-readable name.
	DisplayName string `json:"displayName"`

	// OS is the guest operating system family, e.g. ubuntu.
	OS string `json:"os"`

	// OSVersion is the guest operating system version, e.g. 24.04.
	OSVersion string `json:"osVersion"`

	// Architecture is the guest architecture, e.g. amd64.
	Architecture string `json:"architecture"`

	// MinSystemDisk is the smallest system disk this image can run on.
	MinSystemDisk resource.Quantity `json:"minSystemDisk"`

	// GuestAgent is whether the image already runs the guest agent.
	GuestAgent bool `json:"guestAgent"`

	// Source is where the disk comes from: a registry artifact (a container
	// image holding a disk file) or an already-imported PVC.
	Source VMImageSource `json:"source"`

	// Deprecated refuses new environments; existing ones are unaffected.
	// +optional
	Deprecated bool `json:"deprecated,omitempty"`
}

// VMImageSource is the origin of an image's disk. Exactly one of the two
// fields is set.
type VMImageSource struct {
	// Registry is a container image holding the disk.
	// +kubebuilder:validation:MinLength=1
	// +optional
	Registry string `json:"registry,omitempty"`

	// PVC is a claim in the platform namespace.
	// +kubebuilder:validation:XValidation:rule="size(self.name) > 0",message="the claim name must be set"
	// +optional
	PVC *corev1.LocalObjectReference `json:"pvc,omitempty"`
}

// VMImageStatus reports whether the golden disk itself is usable. An
// environment's own import progress is reported on its own status.
type VMImageStatus struct {
	// DataVolume is the platform's copy of the golden disk.
	// +optional
	DataVolume string `json:"dataVolume,omitempty"`

	// Conditions are the standard conditions of this resource. Ready is True
	// once the golden disk is usable; while it is still being imported Ready is
	// False with reason Importing, and an import that failed sets reason
	// ImportFailed.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Cluster,shortName=vmimage

// VMImage is the Schema for the vmimages API.
type VMImage struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of VMImage
	// +required
	Spec VMImageSpec `json:"spec"`

	// status defines the observed state of VMImage
	// +optional
	Status VMImageStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// VMImageList contains a list of VMImage
type VMImageList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []VMImage `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &VMImage{}, &VMImageList{})
		return nil
	})
}
