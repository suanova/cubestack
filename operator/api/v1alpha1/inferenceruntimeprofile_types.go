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
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// AcceleratorVendor identifies the GPU vendor; the controller maps it to a
// Kubernetes GPU extended resource name.
// +kubebuilder:validation:Enum=metax;nvidia
type AcceleratorVendor string

const (
	// AcceleratorVendorMetax maps to the metax-tech.com/gpu extended resource.
	AcceleratorVendorMetax AcceleratorVendor = "metax"

	// AcceleratorVendorNvidia maps to the nvidia.com/gpu extended resource.
	AcceleratorVendorNvidia AcceleratorVendor = "nvidia"
)

// Accelerator specifies the GPU vendor and the allowed GPU models.
type Accelerator struct {
	// Vendor is the GPU vendor, mapped to a Kubernetes GPU extended resource
	// name, e.g. metax -> metax-tech.com/gpu, nvidia -> nvidia.com/gpu.
	Vendor AcceleratorVendor `json:"vendor"`

	// Models restricts the schedulable GPU models, e.g. MXC500. The controller
	// injects node selection constraints based on the declared models.
	// +kubebuilder:validation:MinItems=1
	Models []string `json:"models"`
}

// Engine identifies the inference engine and its validated version.
type Engine struct {
	// Name is the inference engine name, e.g. sglang.
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`

	// Version is the validated engine version, e.g. vendor-0.5.12-rc1.
	// +kubebuilder:validation:MinLength=1
	Version string `json:"version"`
}

// ModelRequirements declares which model architectures and quantizations this
// profile supports; used for the model compatibility check at resolve time.
type ModelRequirements struct {
	// Architectures lists the supported model architectures, e.g. deepseek_v4.
	// +kubebuilder:validation:MinItems=1
	Architectures []string `json:"architectures"`

	// Quantization lists the supported weight quantization methods, e.g. w8a8.
	// +kubebuilder:validation:MinItems=1
	Quantization []string `json:"quantization"`
}

// AssetMount specifies how a rendered ConfigMap is mounted as files.
type AssetMount struct {
	// Path is the absolute path where the ConfigMap files are mounted.
	// +kubebuilder:validation:Pattern="^/"
	Path string `json:"path"`

	// Mode is the file mode applied to the mounted files, e.g. 0755.
	Mode int32 `json:"mode"`
}

// AssetConfigMapRef names the source ConfigMap of an asset.
type AssetConfigMapRef struct {
	// Name is the source ConfigMap name. Assets are always read from the
	// cubestack-system namespace, so no namespace needs to be specified.
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`
}

// Asset declares a ConfigMap template used by the profile. The controller
// renders its data with service-level variables and creates a copy named
// <isvc>-<name> in the service namespace.
// +kubebuilder:validation:XValidation:rule="(has(self.mount) ? 1 : 0) + (has(self.envFrom) ? 1 : 0) == 1",message="exactly one of mount or envFrom must be set"
type Asset struct {
	// Name is the asset alias, unique within the profile; the rendered
	// ConfigMap is named <isvc>-<name>.
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`

	// ConfigMapRef names the source ConfigMap.
	ConfigMapRef AssetConfigMapRef `json:"configMapRef"`

	// Mount mounts the rendered ConfigMap as files at the declared path.
	// +optional
	Mount *AssetMount `json:"mount,omitempty"`

	// EnvFrom injects the rendered ConfigMap keys as environment variables.
	// +optional
	EnvFrom *bool `json:"envFrom,omitempty"`
}

// OverrideType is the parameter type of an override.
// +kubebuilder:validation:Enum=integer;string;boolean
type OverrideType string

const (
	// OverrideTypeInteger is a numeric parameter.
	OverrideTypeInteger OverrideType = "integer"

	// OverrideTypeString is a string parameter.
	OverrideTypeString OverrideType = "string"

	// OverrideTypeBoolean is a boolean parameter.
	OverrideTypeBoolean OverrideType = "boolean"
)

// Override declares a user-adjustable parameter. Users provide values in
// InferenceService.spec.overrides; parameters without a user value use Default.
type Override struct {
	// Name is the parameter name, used as the key in InferenceService.spec.overrides.
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`

	// Type is the parameter type, deciding how override values are parsed.
	Type OverrideType `json:"type"`

	// Enum lists the acceptable values.
	// +optional
	// +kubebuilder:validation:items:Schemaless
	Enum []apiextensionsv1.JSON `json:"enum,omitempty"`

	// Min is the minimum value for numeric parameters.
	// +optional
	Min *int64 `json:"min,omitempty"`

	// Max is the maximum value for numeric parameters.
	// +optional
	Max *int64 `json:"max,omitempty"`

	// Default is the value used when the user does not provide the parameter.
	// +optional
	Default *apiextensionsv1.JSON `json:"default,omitempty"`

	// Description explains the parameter's purpose to users.
	// +optional
	Description string `json:"description,omitempty"`
}

// WorkloadKind is the workload type of a role.
// +kubebuilder:validation:Enum=LeaderWorkerSet;Deployment
type WorkloadKind string

const (
	// WorkloadKindLeaderWorkerSet hosts model inference; each instance group
	// consists of a leader and several workers.
	WorkloadKindLeaderWorkerSet WorkloadKind = "LeaderWorkerSet"

	// WorkloadKindDeployment is an auxiliary role without groups, e.g. a
	// CPU-only router; each replica is an independent Pod.
	WorkloadKindDeployment WorkloadKind = "Deployment"
)

// Workload defines the instance count and in-group topology of a role.
type Workload struct {
	// Kind selects the workload type.
	Kind WorkloadKind `json:"kind"`

	// Replicas is the number of instance groups (LeaderWorkerSet) or Pods
	// (Deployment). May be a template referencing overrides.
	// +optional
	Replicas *intstr.IntOrString `json:"replicas,omitempty"`

	// Group is the in-group topology, required when kind is LeaderWorkerSet.
	// +optional
	Group *WorkloadGroup `json:"group,omitempty"`
}

// StartupPolicy is the in-group startup order.
// +kubebuilder:validation:Enum=LeaderCreated
type StartupPolicy string

const (
	// StartupPolicyLeaderCreated creates the leader first, then the workers.
	StartupPolicyLeaderCreated StartupPolicy = "LeaderCreated"
)

// WorkloadGroup defines the LeaderWorkerSet group topology.
type WorkloadGroup struct {
	// Size is the number of Pods per group, including the leader. May be a
	// template referencing overrides; 1 is a single-Pod group.
	Size intstr.IntOrString `json:"size"`

	// StartupPolicy is the group startup order; v1alpha1 fixes it to LeaderCreated.
	StartupPolicy StartupPolicy `json:"startupPolicy"`
}

// PodTemplate is the platform-supported subset of a Pod template. Only the
// fields below are allowed, plus platform fields such as gpuPerPod, mounts and
// envFromAssets, to avoid bypassing platform constraints.
type PodTemplate struct {
	// Image is the container image.
	// +kubebuilder:validation:MinLength=1
	Image string `json:"image"`

	// ImagePullPolicy is the image pull policy.
	// +optional
	// +kubebuilder:validation:Enum=Always;Never;IfNotPresent
	ImagePullPolicy corev1.PullPolicy `json:"imagePullPolicy,omitempty"`

	// WorkingDir is the container working directory.
	// +optional
	WorkingDir string `json:"workingDir,omitempty"`

	// ImagePullSecrets references private registry pull secrets.
	// +optional
	ImagePullSecrets []corev1.LocalObjectReference `json:"imagePullSecrets,omitempty"`

	// Command is the container command; supports {{ }} rendering.
	// +optional
	Command []string `json:"command,omitempty"`

	// Args are the container arguments; supports {{ }} rendering.
	// +optional
	Args []string `json:"args,omitempty"`

	// Env lists environment variables, each with either a static value or a fieldRef.
	// +optional
	Env []EnvVar `json:"env,omitempty"`

	// EnvFromAssets injects the listed rendered ConfigMaps as environment variables.
	// +optional
	EnvFromAssets []string `json:"envFromAssets,omitempty"`

	// Resources declares CPU, memory and per-Pod GPU requests.
	// +optional
	Resources *PodResources `json:"resources,omitempty"`

	// SecurityContext is the supported Pod security context subset.
	// +optional
	SecurityContext *PodSecurityContext `json:"securityContext,omitempty"`

	// TerminationGracePeriodSeconds is the grace period before forced termination;
	// defaults to 30.
	// +optional
	// +kubebuilder:default:=30
	TerminationGracePeriodSeconds *int64 `json:"terminationGracePeriodSeconds,omitempty"`

	// Mounts declares the model volume mounts of the role.
	// +optional
	Mounts []ModelMount `json:"mounts,omitempty"`

	// Volumes lists additional volumes from the supported subset, e.g. shm
	// emptyDir or InfiniBand hostPath.
	// +optional
	Volumes []Volume `json:"volumes,omitempty"`

	// NodeSelector constrains scheduling to the declared node labels, e.g. a
	// node pool with the pre-distributed model.
	// +optional
	NodeSelector map[string]string `json:"nodeSelector,omitempty"`

	// Ports lists the container ports.
	// +optional
	Ports []ContainerPort `json:"ports,omitempty"`

	// Probes defines the startup, readiness and liveness probes.
	// +optional
	Probes *Probes `json:"probes,omitempty"`

	// HostNetwork uses the host network namespace. When enabled the controller
	// backfills ports[].containerPort as hostPort.
	// +optional
	HostNetwork *bool `json:"hostNetwork,omitempty"`

	// DNSPolicy is the Pod DNS policy.
	// +optional
	// +kubebuilder:validation:Enum=ClusterFirst;Default;ClusterFirstWithHostNet;None
	DNSPolicy corev1.DNSPolicy `json:"dnsPolicy,omitempty"`

	// Labels are passed through to the Pods.
	// +optional
	Labels map[string]string `json:"labels,omitempty"`

	// Annotations are passed through to the Pods, e.g. Prometheus annotations.
	// +optional
	Annotations map[string]string `json:"annotations,omitempty"`
}

// EnvVar is an environment variable with either a static value or a fieldRef.
// +kubebuilder:validation:XValidation:rule="(has(self.value) ? 1 : 0) + (has(self.fieldRef) ? 1 : 0) == 1",message="exactly one of value or fieldRef must be set"
type EnvVar struct {
	// Name is the environment variable name.
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`

	// Value is the static value; may contain templates.
	// +optional
	Value *string `json:"value,omitempty"`

	// FieldRef selects a downward API field, e.g. status.hostIP.
	// +optional
	FieldRef *ObjectFieldSelector `json:"fieldRef,omitempty"`
}

// ObjectFieldSelector selects a downward API field.
type ObjectFieldSelector struct {
	// FieldPath is the path of the field to select, e.g. status.hostIP.
	// +kubebuilder:validation:MinLength=1
	FieldPath string `json:"fieldPath"`
}

// PodResources specifies CPU, memory and per-Pod GPU requests.
type PodResources struct {
	// CPU is written to requests.cpu.
	// +optional
	CPU *resource.Quantity `json:"cpu,omitempty"`

	// Memory is written to requests.memory.
	// +optional
	Memory *resource.Quantity `json:"memory,omitempty"`

	// GPUPerPod is the number of GPUs per Pod, mapped to the vendor's extended
	// resource and written to both requests and limits.
	// +optional
	// +kubebuilder:validation:Minimum=1
	GPUPerPod *int64 `json:"gpuPerPod,omitempty"`
}

// PodSecurityContext is the supported subset of a Pod security context.
type PodSecurityContext struct {
	// Privileged runs the container in privileged mode.
	// +optional
	Privileged *bool `json:"privileged,omitempty"`

	// RunAsUser is the user ID of the container process.
	// +optional
	RunAsUser *int64 `json:"runAsUser,omitempty"`

	// RunAsGroup is the group ID of the container process.
	// +optional
	RunAsGroup *int64 `json:"runAsGroup,omitempty"`
}

// ModelMount declares the model volume mount of a role. v1alpha1 supports a
// single main model; the profile fixes the in-container path while the
// ModelVersion fixes the storage strategy.
// +kubebuilder:validation:XValidation:rule="self.model == 'main' && self.readOnly == true",message="model must be 'main' and readOnly must be true"
type ModelMount struct {
	// Model is the model key; v1alpha1 fixes it to main.
	// +kubebuilder:validation:Enum=main
	Model string `json:"model"`

	// At is the in-container mount path.
	// +kubebuilder:validation:Pattern="^/"
	At string `json:"at"`

	// ReadOnly is fixed to true in v1alpha1; the model volume does not support writes.
	ReadOnly bool `json:"readOnly"`
}

// Volume is a supported subset of Kubernetes Volumes: emptyDir and hostPath.
// +kubebuilder:validation:XValidation:rule="(has(self.emptyDir) ? 1 : 0) + (has(self.hostPath) ? 1 : 0) == 1",message="exactly one of emptyDir or hostPath must be set"
type Volume struct {
	// Name is the volume name.
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`

	// EmptyDir is an empty directory volume, e.g. for /dev/shm.
	// +optional
	EmptyDir *EmptyDirVolume `json:"emptyDir,omitempty"`

	// HostPath is a host path volume, e.g. for InfiniBand devices.
	// +optional
	HostPath *HostPathVolume `json:"hostPath,omitempty"`
}

// EmptyDirVolume is an emptyDir volume.
type EmptyDirVolume struct{}

// HostPathVolume is a hostPath volume.
type HostPathVolume struct {
	// Path is the absolute host path.
	// +kubebuilder:validation:Pattern="^/"
	Path string `json:"path"`
}

// ContainerPort declares a container port.
type ContainerPort struct {
	// Name is the port name, referenced by service targetPort.
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`

	// ContainerPort is the port number.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	ContainerPort int32 `json:"containerPort"`
}

// Probes defines the startup, readiness and liveness probes.
type Probes struct {
	// Startup is the startup probe.
	// +optional
	Startup *Probe `json:"startup,omitempty"`

	// Readiness is the readiness probe.
	// +optional
	Readiness *Probe `json:"readiness,omitempty"`

	// Liveness is the liveness probe.
	// +optional
	Liveness *Probe `json:"liveness,omitempty"`
}

// Probe is a probe with either httpGet or tcpSocket.
// +kubebuilder:validation:XValidation:rule="(has(self.httpGet) ? 1 : 0) + (has(self.tcpSocket) ? 1 : 0) == 1",message="exactly one of httpGet or tcpSocket must be set"
type Probe struct {
	// HTTPGet performs an HTTP GET probe.
	// +optional
	HTTPGet *HTTPGetAction `json:"httpGet,omitempty"`

	// TCPSocket performs a TCP connect probe.
	// +optional
	TCPSocket *TCPSocketAction `json:"tcpSocket,omitempty"`

	// InitialDelaySeconds is the delay before the first probe.
	// +optional
	InitialDelaySeconds *int32 `json:"initialDelaySeconds,omitempty"`

	// PeriodSeconds is the probe period.
	// +optional
	PeriodSeconds *int32 `json:"periodSeconds,omitempty"`

	// TimeoutSeconds is the probe timeout.
	// +optional
	TimeoutSeconds *int32 `json:"timeoutSeconds,omitempty"`

	// FailureThreshold is the consecutive failure count before giving up.
	// +optional
	FailureThreshold *int32 `json:"failureThreshold,omitempty"`
}

// HTTPGetAction performs an HTTP GET probe.
type HTTPGetAction struct {
	// Path is the HTTP path.
	// +optional
	Path string `json:"path,omitempty"`

	// Port is the port to probe, either a number or a container port name.
	Port intstr.IntOrString `json:"port"`
}

// TCPSocketAction performs a TCP connect probe.
type TCPSocketAction struct {
	// Port is the port to probe, either a number or a container port name.
	Port intstr.IntOrString `json:"port"`
}

// RoleService defines the Kubernetes Service of a role.
type RoleService struct {
	// Ports lists the Service ports.
	// +optional
	Ports []ServicePort `json:"ports,omitempty"`

	// Headless additionally creates a headless Service <isvc>-<role>-hl
	// (ClusterIP: None) for per-Pod discovery.
	// +optional
	Headless *bool `json:"headless,omitempty"`
}

// ServicePort is a Service port.
type ServicePort struct {
	// Name is the port name, referenced by endpoint.portName.
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`

	// Port is the Service port number.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	Port int32 `json:"port"`

	// TargetPort is the target port, either a number or a container port name.
	// +optional
	TargetPort *intstr.IntOrString `json:"targetPort,omitempty"`
}

// Role defines one workload of the profile. The generated resources are named
// <isvc>-<role>; the role name is the reference anchor for endpoint.role,
// dependsOn and templates.
type Role struct {
	// Name is the role name, unique within the profile.
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`

	// DependsOn lists roles that must be ready before this one is created,
	// forming a DAG.
	// +optional
	DependsOn []string `json:"dependsOn,omitempty"`

	// Workload defines the instance count and in-group topology.
	Workload Workload `json:"workload"`

	// PodTemplate is the Pod template of the role.
	PodTemplate PodTemplate `json:"podTemplate"`

	// Service defines the role's Kubernetes Service.
	// +optional
	Service *RoleService `json:"service,omitempty"`
}

// EndpointSpec selects the role serving as the service endpoint.
type EndpointSpec struct {
	// Role is the endpoint role name; it must exist in roles and define a service.
	// +kubebuilder:validation:MinLength=1
	Role string `json:"role"`

	// PortName is the endpoint Service port name; defaults to http.
	// +optional
	// +kubebuilder:default:=http
	PortName string `json:"portName,omitempty"`
}

// ReadinessPolicy aggregates the service readiness condition.
// +kubebuilder:validation:XValidation:rule="self.requireAllRoles == true",message="requireAllRoles is fixed to true in v1alpha1"
type ReadinessPolicy struct {
	// RequireAllRoles requires all roles' workloads and Pods to be ready
	// before the InferenceService is marked Ready; fixed to true in v1alpha1.
	// +kubebuilder:default:=true
	RequireAllRoles bool `json:"requireAllRoles"`
}

// InferenceRuntimeProfileSpec defines the desired state of InferenceRuntimeProfile.
type InferenceRuntimeProfileSpec struct {
	// Accelerator specifies the GPU vendor and the allowed GPU models.
	Accelerator Accelerator `json:"accelerator"`

	// Engine identifies the inference engine and its validated version.
	Engine Engine `json:"engine"`

	// ModelRequirements declares the supported model architectures and quantizations.
	ModelRequirements ModelRequirements `json:"modelRequirements"`

	// Vars are admin-defined template constants, referenced as {{ profile.vars.<key> }}.
	// +optional
	Vars map[string]string `json:"vars,omitempty"`

	// Assets lists the ConfigMap templates used by the profile.
	// +optional
	Assets []Asset `json:"assets,omitempty"`

	// Overrides declares the user-adjustable parameters.
	// +optional
	Overrides []Override `json:"overrides,omitempty"`

	// Roles defines the workloads of the profile.
	// +kubebuilder:validation:MinItems=1
	Roles []Role `json:"roles"`

	// Endpoint selects the role serving as the service endpoint.
	Endpoint EndpointSpec `json:"endpoint"`

	// ReadinessPolicy aggregates the service readiness condition.
	// +optional
	ReadinessPolicy *ReadinessPolicy `json:"readinessPolicy,omitempty"`
}

// InferenceRuntimeProfileStatus defines the observed state of InferenceRuntimeProfile.
type InferenceRuntimeProfileStatus struct {
	// UsedBy lists the InferenceServices currently referencing this
	// InferenceRuntimeProfile.
	// +optional
	UsedBy []ObjectRef `json:"usedBy,omitempty"`

	// conditions represent the current state of the InferenceRuntimeProfile resource.
	// Each condition has a unique type and reflects the status of a specific aspect of the resource.
	//
	// Standard condition types include (see conditions.go for the constants):
	// - ConditionAssetsResolved: all assets[].configMapRef.name exist in cubestack-system
	// - ConditionInUse: the InferenceRuntimeProfile is referenced by at least one InferenceService
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
// +kubebuilder:printcolumn:name="Vendor",type=string,JSONPath=".spec.accelerator.vendor"
// +kubebuilder:printcolumn:name="Engine",type=string,JSONPath=".spec.engine.name"

// InferenceRuntimeProfile is the Schema for the inferenceruntimeprofiles API
type InferenceRuntimeProfile struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of InferenceRuntimeProfile
	// +required
	Spec InferenceRuntimeProfileSpec `json:"spec"`

	// status defines the observed state of InferenceRuntimeProfile
	// +optional
	Status InferenceRuntimeProfileStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// InferenceRuntimeProfileList contains a list of InferenceRuntimeProfile
type InferenceRuntimeProfileList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []InferenceRuntimeProfile `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &InferenceRuntimeProfile{}, &InferenceRuntimeProfileList{})
		return nil
	})
}
