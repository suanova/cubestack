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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// DevEnvironmentType is the container type.
type DevEnvironmentType string

const (
	DevEnvironmentTypeJupyter DevEnvironmentType = "jupyter"
	DevEnvironmentTypeSSH     DevEnvironmentType = "ssh"
	DevEnvironmentTypeVSCode  DevEnvironmentType = "vscode"
)

// DevEnvironmentSpec defines the desired state of DevEnvironment
type DevEnvironmentSpec struct {
	// Type is the container type (single choice): jupyter / ssh / vscode.
	// It decides the container main entry and the image.
	// +kubebuilder:validation:Enum=jupyter;ssh;vscode
	// +kubebuilder:default=ssh
	// +optional
	Type DevEnvironmentType `json:"type,omitempty"`

	// Image is the development image, pulled from any accessible container
	// image registry.
	// +kubebuilder:validation:MinLength=1
	Image string `json:"image"`

	// Running is the desired running state: true=Running, false=Stopped.
	// +kubebuilder:default=false
	// +optional
	Running bool `json:"running,omitempty"`

	// Resources is the compute / resource configuration.
	Resources ResourcesSpec `json:"resources"`

	// Storage is the workspace storage: a PVC created with the environment and
	// mounted at the workspace path (default /workspace). Omit it to avoid
	// creating a managed workspace PVC; to use an existing PVC as the workspace,
	// mount it via spec.volumes at the workspace path (e.g. /workspace).
	// +optional
	Storage *StorageSpec `json:"storage,omitempty"`

	// Volumes are data volume mounts referencing existing PVCs. If spec.storage
	// is omitted, mount an existing PVC at the workspace path (e.g. /workspace)
	// to use it as the environment's workspace.
	// +optional
	Volumes []VolumeMount `json:"volumes,omitempty"`

	// SSH configures SSH access.
	// +optional
	SSH *SSHSpec `json:"ssh,omitempty"`

	// Network configures the network.
	// +optional
	Network *NetworkSpec `json:"network,omitempty"`

	// Runtime customizes the container runtime.
	// +optional
	Runtime *RuntimeSpec `json:"runtime,omitempty"`

	// Lifecycle configures the lifecycle.
	// +optional
	Lifecycle *LifecycleSpec `json:"lifecycle,omitempty"`

	// Ports are extra application ports.
	// +optional
	Ports []PortSpec `json:"ports,omitempty"`
}

// GPUType is the GPU vendor.
type GPUType string

const (
	GPUTypeNVIDIA GPUType = "nvidia"
	GPUTypeMetaX  GPUType = "metax"
)

// ResourcesSpec is the compute / resource configuration.
type ResourcesSpec struct {
	// GPUType is the GPU vendor: nvidia / metax. It decides the GPU extended
	// resource (nvidia.com/gpu / metax-tech.com/gpu) and image brand matching.
	// +kubebuilder:validation:Enum=nvidia;metax
	// +kubebuilder:default=nvidia
	// +optional
	GPUType GPUType `json:"gpuType,omitempty"`

	// GPUCount is the number of GPU cards.
	// +kubebuilder:default=1
	// +kubebuilder:validation:Minimum=1
	// +optional
	GPUCount int32 `json:"gpuCount,omitempty"`

	// CPU is the CPU limit in cores.
	// +optional
	CPU string `json:"cpu,omitempty"`

	// Memory is the memory limit.
	// +optional
	Memory string `json:"memory,omitempty"`
}

// StorageSpec is the workspace storage configuration.
type StorageSpec struct {
	// Size is the workspace PVC capacity.
	// +kubebuilder:default="10Gi"
	// +optional
	Size string `json:"size,omitempty"`

	// PVCRetention is the workspace PVC retention policy, applied only when the
	// environment is deleted. Stopping the environment does not delete the PVC:
	// stopping scales the workload to zero but the workspace data survives
	// stop/start regardless of this field.
	// retain=keep the PVC (default, prevents accidental data loss on deletion)
	// / delete=remove the PVC together with the environment.
	// +kubebuilder:validation:Enum=retain;delete
	// +kubebuilder:default=retain
	// +optional
	PVCRetention PVCRetentionPolicy `json:"pvcRetention,omitempty"`

	// MountPath is the path where the workspace PVC is mounted; defaults to
	// /workspace. The platform's base images set the container home/working
	// directory to this path, so user data persists across restarts. Custom
	// images must either align their home to this path or override mountPath
	// with the image's home directory.
	// +kubebuilder:default="/workspace"
	// +optional
	MountPath string `json:"mountPath,omitempty"`
}

// PVCRetentionPolicy is the workspace PVC deletion policy.
type PVCRetentionPolicy string

const (
	PVCRetentionRetain PVCRetentionPolicy = "retain"
	PVCRetentionDelete PVCRetentionPolicy = "delete"
)

// VolumeMount is a data volume mount referencing an existing PVC.
type VolumeMount struct {
	// Name is the volume identifier.
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`

	// PVCName is the name of the referenced existing PVC.
	// +kubebuilder:validation:MinLength=1
	PVCName string `json:"pvcName"`

	// MountPath is the mount path (e.g. /data, /models).
	// +kubebuilder:validation:MinLength=1
	MountPath string `json:"mountPath"`

	// SubPath is the sub path (optional).
	// +optional
	SubPath string `json:"subPath,omitempty"`

	// ReadOnly indicates whether the volume is read-only (default false).
	// +optional
	ReadOnly bool `json:"readOnly,omitempty"`
}

// SSHSpec configures SSH access.
type SSHSpec struct {
	// Enabled exposes SSH access to the environment: the controller opens the
	// SSH endpoint. It does not start an sshd server — SSH only works if the
	// image itself runs one. The ssh container type always has SSH exposed.
	// +kubebuilder:default=false
	// +optional
	Enabled bool `json:"enabled,omitempty"`

	// KeysSecret is the SSH public key Secret reference. If specified, the
	// controller uses the provided Secret (Secret.data[key] holds multi-line
	// public keys, i.e. authorized_keys content); otherwise the controller
	// generates and manages one. The plaintext is never stored in spec.
	// +optional
	KeysSecret *corev1.SecretKeySelector `json:"keysSecret,omitempty"`
}

// NetworkSpec configures the network.
type NetworkSpec struct {
	// RDMAEnabled enables the RDMA network (Multus).
	// +kubebuilder:default=false
	// +optional
	RDMAEnabled bool `json:"rdmaEnabled,omitempty"`

	// RDMAType is the RDMA network type: infiniband (requires IB switches) /
	// roce (RoCEv2, reuses lossless ethernet); effective when rdmaEnabled=true.
	// +kubebuilder:validation:Enum=infiniband;roce
	// +kubebuilder:default=roce
	// +optional
	RDMAType RDMAType `json:"rdmaType,omitempty"`
}

// RDMAType is the RDMA network type.
type RDMAType string

const (
	RDMATypeInfiniBand RDMAType = "infiniband"
	RDMATypeRoCE       RDMAType = "roce"
)

// RuntimeSpec customizes the container runtime.
type RuntimeSpec struct {
	// Command overrides the startup command.
	// +optional
	Command []string `json:"command,omitempty"`

	// Args overrides the startup arguments.
	// +optional
	Args []string `json:"args,omitempty"`

	// Env is the environment variables (name/value or valueFrom: secretKeyRef).
	// +optional
	Env []corev1.EnvVar `json:"env,omitempty"`

	// SecurityContext controls the container user: non-root by default
	// (runAsUser=1000); set runAsUser=0 to run as root. The controller enforces
	// the non-root default and injects any capabilities the environment needs
	// (e.g. RDMA); capability and privileged settings are not user-settable.
	// +optional
	SecurityContext *RuntimeSecurityContext `json:"securityContext,omitempty"`
}

// RuntimeSecurityContext is the user-settable subset of the container security
// context. Privileged, capability, and escalation settings are not exposed to
// users and are injected by the controller as needed (e.g. RDMA); the
// controller also enforces the non-root default based on RunAsUser.
type RuntimeSecurityContext struct {
	// RunAsUser is the user ID to run the container as. Non-root by default;
	// set 0 to run as root.
	// +optional
	RunAsUser *int64 `json:"runAsUser,omitempty"`

	// RunAsGroup is the group ID to run the container as.
	// +optional
	RunAsGroup *int64 `json:"runAsGroup,omitempty"`
}

// LifecycleSpec configures the lifecycle.
type LifecycleSpec struct {
	// IdleTimeout is the idle auto-shutdown timeout in seconds; 0 disables it.
	// +kubebuilder:default=0
	// +kubebuilder:validation:Minimum=0
	// +optional
	IdleTimeout int32 `json:"idleTimeout,omitempty"`
}

// PortSpec is an extra application port.
type PortSpec struct {
	// Name is the port identifier (unique, used for sub path / status display).
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`

	// Type is the exposure form: http (web over sub path) / tcp (port range +
	// TCPRoute) / udp (UDPRoute).
	// +kubebuilder:validation:Enum=http;tcp;udp
	// +kubebuilder:default=http
	// +optional
	Type PortType `json:"type,omitempty"`

	// ContainerPort is the in-container application port.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	ContainerPort int32 `json:"containerPort"`
}

// PortType is the extra application port exposure form.
type PortType string

const (
	PortTypeHTTP PortType = "http"
	PortTypeTCP  PortType = "tcp"
	PortTypeUDP  PortType = "udp"
)

// PhaseName is the running phase of the environment.
type PhaseName string

const (
	PhasePending     PhaseName = "Pending"
	PhaseRunning     PhaseName = "Running"
	PhaseStopped     PhaseName = "Stopped"
	PhaseFailed      PhaseName = "Failed"
	PhaseTerminating PhaseName = "Terminating"
)

// Phase describes the current running phase of the environment.
type Phase struct {
	// Name is the current phase.
	// +kubebuilder:validation:Enum=Pending;Running;Stopped;Failed;Terminating
	Name PhaseName `json:"name"`

	// LastTransitionTime is the time the current phase was reached.
	// +optional
	LastTransitionTime *metav1.Time `json:"lastTransitionTime,omitempty"`

	// Reason explains the current phase, e.g. the error when Failed.
	// +optional
	Reason string `json:"reason,omitempty"`
}

// DevEnvironmentStatus defines the observed state of DevEnvironment.
type DevEnvironmentStatus struct {
	// ObservedGeneration is the generation of the most recent spec the
	// controller has reconciled. If it is less than metadata.generation, the
	// status may be stale.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Phase describes the current running phase.
	// +optional
	Phase *Phase `json:"phase,omitempty"`

	// SSHKeysSecret is the Secret holding the SSH keys in use: the user-provided
	// one from spec.ssh.keysSecret, or a controller-generated one. It is
	// recorded in status so the user can retrieve generated keys.
	// +optional
	SSHKeysSecret *corev1.SecretKeySelector `json:"sshKeysSecret,omitempty"`

	// LastActivityTime is the last activity time, used for idle timeout
	// determination.
	// +optional
	LastActivityTime *metav1.Time `json:"lastActivityTime,omitempty"`

	// Endpoints are the access addresses of the environment: the web (Jupyter)
	// URL, the SSH address, and any extra application port exposures.
	// +optional
	Endpoints []Endpoint `json:"endpoints,omitempty"`

	// Conditions: PodScheduled / StorageReady / BrandMatchValid / Ready (type
	// constants below).
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// Endpoint describes an access address of the environment: the web (Jupyter)
// URL, the SSH address, or an extra application port exposure.
type Endpoint struct {
	// Name identifies the endpoint: "jupyter", "ssh", or the spec.ports[].name
	// for an extra application port.
	Name string `json:"name"`

	// Address is the access address: a URL for web (e.g.
	// http://<gw-ip>:80/dev/<ns>/<env>/), or a host:port for SSH and tcp/udp
	// ports (e.g. ssh://user@<gw-ip>:<port>).
	Address string `json:"address"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced

// DevEnvironment is the Schema for the devenvironments API
type DevEnvironment struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of DevEnvironment
	// +required
	Spec DevEnvironmentSpec `json:"spec"`

	// status defines the observed state of DevEnvironment
	// +optional
	Status DevEnvironmentStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// DevEnvironmentList contains a list of DevEnvironment
type DevEnvironmentList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []DevEnvironment `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &DevEnvironment{}, &DevEnvironmentList{})
		return nil
	})
}
