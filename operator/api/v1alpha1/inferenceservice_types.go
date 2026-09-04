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
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// RouteSpec defines the public gateway route of the service.
type RouteSpec struct {
	// Publish exposes the service through the gateway; defaults to false.
	// Unpublished services only provide a ClusterIP internal endpoint.
	// +optional
	// +kubebuilder:default:=false
	Publish bool `json:"publish,omitempty"`

	// ModelName is the public model alias, used to generate the hostname
	// <modelName>.<platform-domain>. It must be a single RFC1123 label.
	// +optional
	// +kubebuilder:validation:Pattern=^[a-z0-9]([-a-z0-9]*[a-z0-9])?$
	ModelName string `json:"modelName,omitempty"`

	// TimeoutSeconds is the gateway request timeout; defaults to 60.
	// +optional
	// +kubebuilder:default:=60
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=86400
	TimeoutSeconds *int64 `json:"timeoutSeconds,omitempty"`
}

// InferenceServiceSpec defines the desired state of InferenceService.
type InferenceServiceSpec struct {
	// ModelRef references the ModelVersion to serve. The ModelVersion spec is
	// immutable, so changing this field switches the model version for
	// upgrade or rollback.
	// +kubebuilder:validation:Pattern=^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$
	ModelRef string `json:"modelRef"`

	// ProfileRef references the InferenceRuntimeProfile to use. The Profile
	// spec is immutable, so changing this field switches the runtime
	// configuration version for upgrade or rollback.
	// +kubebuilder:validation:Pattern=^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$
	ProfileRef string `json:"profileRef"`

	// Overrides provides user values for the parameters declared by the
	// Profile's overrides[]. Unknown keys or invalid values are rejected by
	// the controller at reconcile time.
	// +optional
	Overrides map[string]apiextensionsv1.JSON `json:"overrides,omitempty"`

	// Route defines the public gateway route of the service.
	// +optional
	Route *RouteSpec `json:"route,omitempty"`
}

// ProfileStatus echoes the resolved InferenceRuntimeProfile.
type ProfileStatus struct {
	// Name is the resolved profile name.
	Name string `json:"name"`

	// Revision is the combined hash of the profile spec and asset contents at
	// the last successful apply; the baseline for same-name-recreation detection.
	Revision string `json:"revision"`
}

// ModelStatus echoes the resolved ModelVersion.
type ModelStatus struct {
	// Name is the model name from the resolved ModelVersion.
	Name string `json:"name"`

	// Version is the model version from the resolved ModelVersion.
	Version string `json:"version"`

	// Credentials echoes the synced S3 credentials copy source, only present
	// when the ModelVersion storage strategy is S3 and sets credentialsRef
	// (design §3.3).
	// +optional
	Credentials *ModelCredentialsStatus `json:"credentials,omitempty"`
}

// ModelCredentialsStatus reports which source version the S3 credentials copy
// has been synced to (audit chain, no content hash).
type ModelCredentialsStatus struct {
	// Source is the source credentials Secret name in cubestack-system.
	Source string `json:"source"`

	// ResourceVersion is the source Secret resourceVersion the copy was synced from.
	ResourceVersion string `json:"resourceVersion"`
}

// RoleStatus reports the resolved topology of one role, for billing and quota.
type RoleStatus struct {
	// Name is the role name.
	Name string `json:"name"`

	// Kind is the workload kind of the role.
	Kind WorkloadKind `json:"kind"`

	// Replicas is the desired number of instance groups (LeaderWorkerSet) or
	// Pods (Deployment).
	Replicas int64 `json:"replicas"`

	// GroupSize is the number of Pods per group; only present for
	// LeaderWorkerSet roles.
	// +optional
	GroupSize *int64 `json:"groupSize,omitempty"`

	// WorkloadName is the generated workload name, <isvc>-<role>.
	WorkloadName string `json:"workloadName"`

	// ServiceName is the generated Service name, <isvc>-<role>.
	ServiceName string `json:"serviceName"`

	// ReadyReplicas is the number of ready instance groups (LeaderWorkerSet)
	// or Pods (Deployment).
	ReadyReplicas int64 `json:"readyReplicas"`

	// Ready summarizes whether the role is ready.
	Ready bool `json:"ready"`
}

// EndpointStatus reports the service endpoints.
type EndpointStatus struct {
	// Internal is the internal ClusterIP endpoint, e.g.
	// <isvc>-<role>.<namespace>.svc:8001.
	Internal string `json:"internal"`

	// Public is the public gateway endpoint; only present when publish is true.
	// +optional
	Public string `json:"public,omitempty"`
}

// AssetStatus reports a created asset ConfigMap and its content hash
// (audit chain).
type AssetStatus struct {
	// Name is the asset alias, also the rendered ConfigMap name suffix.
	Name string `json:"name"`

	// Source is the source ConfigMap name in cubestack-system.
	Source string `json:"source"`

	// Hash is the content hash of the rendered ConfigMap data.
	Hash string `json:"hash"`
}

// InferenceServiceStatus defines the observed state of InferenceService.
type InferenceServiceStatus struct {
	// ObservedGeneration is the generation the controller has processed; if
	// it is lower than metadata.generation, the status may still correspond
	// to an older spec.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Profile echoes the resolved InferenceRuntimeProfile.
	// +optional
	Profile *ProfileStatus `json:"profile,omitempty"`

	// Model echoes the resolved ModelVersion.
	// +optional
	Model *ModelStatus `json:"model,omitempty"`

	// conditions represent the current state of the InferenceService resource.
	// Each condition has a unique type and reflects the status of a specific aspect of the resource.
	//
	// Standard condition types include (see conditions.go for the constants):
	// - ConditionResolved: profileRef/modelRef/assets resolve and are compatible
	// - ConditionRendered: overrides are valid and the templates render successfully
	// - ConditionProvisioned: rendered asset ConfigMaps and model PVCs are created
	// - ConditionWorkloadsApplied: desired config is applied to Services and workloads
	// - ConditionEndpointReady: the internal endpoint is actually reachable
	// - ConditionRouteReady: the public route is published (or not requested)
	// - ConditionReady: all roles' workloads and Pods are ready
	// - ConditionProgressing: the controller is still applying the desired config
	//
	// The status of each condition is one of True, False, or Unknown.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// Roles reports the resolved topology of each role.
	// +optional
	Roles []RoleStatus `json:"roles,omitempty"`

	// Endpoint reports the service endpoints.
	// +optional
	Endpoint *EndpointStatus `json:"endpoint,omitempty"`

	// Assets reports the created asset ConfigMaps and their content hashes.
	// +optional
	Assets []AssetStatus `json:"assets,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced
// +kubebuilder:printcolumn:name="Model",type=string,JSONPath=".spec.modelRef"
// +kubebuilder:printcolumn:name="Profile",type=string,JSONPath=".spec.profileRef"

// InferenceService is the Schema for the inferenceservices API
type InferenceService struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of InferenceService
	// +required
	Spec InferenceServiceSpec `json:"spec"`

	// status defines the observed state of InferenceService
	// +optional
	Status InferenceServiceStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// InferenceServiceList contains a list of InferenceService
type InferenceServiceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []InferenceService `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &InferenceService{}, &InferenceServiceList{})
		return nil
	})
}
