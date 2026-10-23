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
	"slices"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// AIGatewayRouterName names one of the platform's pre-installed shared
// AIGatewayRoutes (Agent Router catalog surfaces).
// +kubebuilder:validation:Enum=cubestack-ai-gateway;cubestack-ai-gateway-private
type AIGatewayRouterName string

const (
	// AIGatewayRouterPublic is the public model catalog route.
	AIGatewayRouterPublic AIGatewayRouterName = "cubestack-ai-gateway"
	// AIGatewayRouterPrivate is the private model catalog route.
	AIGatewayRouterPrivate AIGatewayRouterName = "cubestack-ai-gateway-private"
)

// CatalogPath is a client request path a published service exposes on the
// platform's model catalog.
// +kubebuilder:validation:Enum=/v1/chat/completions;/v1/responses;/v1/messages;/v1/images
type CatalogPath string

const (
	// CatalogPathChatCompletions is the OpenAI chat-completions endpoint.
	CatalogPathChatCompletions CatalogPath = "/v1/chat/completions"
	// CatalogPathResponses is the OpenAI responses endpoint.
	CatalogPathResponses CatalogPath = "/v1/responses"
	// CatalogPathMessages is the Anthropic messages endpoint. It is served by
	// the Agent Router (through the AIServiceBackend whose schema is Anthropic).
	CatalogPathMessages CatalogPath = "/v1/messages"
	// CatalogPathImages is the OpenAI images endpoint.
	CatalogPathImages CatalogPath = "/v1/images"
)

// CatalogPaths are all supported catalog paths, in display order.
var CatalogPaths = []CatalogPath{
	CatalogPathChatCompletions,
	CatalogPathResponses,
	CatalogPathMessages,
	CatalogPathImages,
}

// RouteSpec defines the public gateway route of the service: the platform
// model catalog entry a published service joins.
type RouteSpec struct {
	// AIGatewayRouter selects the platform's shared AIGatewayRoute this
	// service's catalog rule is attached to. The operator maintains that route
	// in full from all published services. Empty (or an absent route) means the
	// service is not published and only provides a ClusterIP internal endpoint.
	// +optional
	AIGatewayRouter AIGatewayRouterName `json:"aigatewayRouter,omitempty"`

	// ModelName is the catalog model name: what clients send as the request
	// body's "model" field, which the Agent Router's ext_proc turns into the
	// x-ai-eg-model header the shared route matches on. It is the identity of a
	// published service and must be unique among services published to the same
	// route.
	// +optional
	// +kubebuilder:validation:Pattern=`^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$`
	ModelName string `json:"modelName,omitempty"`

	// Paths lists the client paths the catalog entry exposes. Unset means all
	// supported paths; an explicitly empty list exposes none. The empty list
	// must survive a round trip through a typed client, which omitempty would
	// silently turn back into "unset" (all paths).
	// +optional
	// +kubebuilder:validation:MaxItems=4
	// +listType=set
	Paths []CatalogPath `json:"paths"`

	// TimeoutSeconds caps the total duration of a request at the gateway,
	// including every streamed chunk. 0 (the default) disables the cap.
	// +optional
	// +kubebuilder:default:=0
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=86400
	TimeoutSeconds *int64 `json:"timeoutSeconds,omitempty"`

	// IdleTimeoutSeconds cuts a request whose upstream sent no bytes for this
	// long; defaults to 0, which disables the cut. Non-streaming generations
	// send nothing until the response completes, so a non-zero value bounds
	// them too — at the cost of killing a long stream that pauses.
	// +optional
	// +kubebuilder:default:=0
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=86400
	IdleTimeoutSeconds *int64 `json:"idleTimeoutSeconds,omitempty"`
}

// Published reports whether the service requests a catalog entry.
func (r *RouteSpec) Published() bool {
	return r != nil && r.AIGatewayRouter != ""
}

// ExposedPaths returns the client paths the service publishes. An unset list
// means every supported path (services created before the field existed); an
// explicitly empty list means none.
func (r *RouteSpec) ExposedPaths() []CatalogPath {
	if r == nil {
		return nil
	}
	if r.Paths == nil {
		return CatalogPaths
	}
	return r.Paths
}

// Exposes reports whether the service publishes the given path.
func (r *RouteSpec) Exposes(path CatalogPath) bool {
	return slices.Contains(r.ExposedPaths(), path)
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
	// +optional
	Revision string `json:"revision,omitempty"`
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

	// Public is the public gateway endpoint; only present when published.
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

// InferenceServicePhaseName is an observed phase of an InferenceService.
type InferenceServicePhaseName string

const (
	// InferenceServicePhasePending is a service the controller has not
	// reported on yet: no spec has been applied and no verdict reached, either
	// because the first reconcile has not landed or because one of its reads
	// keeps failing.
	InferenceServicePhasePending InferenceServicePhaseName = "Pending"
	// InferenceServicePhaseProgressing is a service whose desired state is
	// being applied — first creation, a rollout, a scale, or a wait on
	// another role's workload.
	InferenceServicePhaseProgressing InferenceServicePhaseName = "Progressing"
	// InferenceServicePhaseReady is a service whose every role's workload is
	// ready and whose workloads report no new generation to apply.
	InferenceServicePhaseReady InferenceServicePhaseName = "Ready"
	// InferenceServicePhaseFailed is a service that needs a human: the spec
	// could not be applied, or applying it converged on a workload that never
	// became ready.
	InferenceServicePhaseFailed InferenceServicePhaseName = "Failed"
)

// InferenceServicePhase describes the current phase of the service.
//
// It is a summary of the conditions, not a further observation: the same
// reconcile that writes Conditions derives the phase from them, so a client
// that renders the phase and a client that reads Conditions cannot disagree
// about what state the service is in. The two conditions the phase is mostly
// made of — Ready and Progressing — are written together from the same role
// readiness, so the phase never has to choose between them.
type InferenceServicePhase struct {
	// Name is the current phase.
	// +kubebuilder:validation:Enum=Pending;Progressing;Ready;Failed
	Name InferenceServicePhaseName `json:"name"`

	// LastTransitionTime is the time the current phase was reached.
	// +optional
	LastTransitionTime *metav1.Time `json:"lastTransitionTime,omitempty"`

	// Reason explains the current phase: the failing condition's own reason on
	// a Failed phase, and the Progressing condition's reason (Reconciling,
	// Rollout or Scaling) on a Progressing one.
	// +optional
	Reason string `json:"reason,omitempty"`
}

// InferenceServiceStatus defines the observed state of InferenceService.
type InferenceServiceStatus struct {
	// ObservedGeneration is the generation the controller has processed; if
	// it is lower than metadata.generation, the status may still correspond
	// to an older spec.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Phase is the service's state in one word, summarized from the
	// conditions below. It is absent until the controller has reached a
	// verdict — see InferenceServicePhasePending.
	// +optional
	Phase *InferenceServicePhase `json:"phase,omitempty"`

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
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=".status.phase.name"
// +kubebuilder:printcolumn:name="Reason",type=string,JSONPath=".status.phase.reason"
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
