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

// VMEnvironmentSpec defines the desired state of a virtual machine
// environment.
//
// The spec states what the guest should be — an image, compute, disks,
// network access and ports — and nothing about how the platform arranges it.
// Its vocabulary belongs to this resource alone: there is no shared phase,
// condition or endpoint contract with the container form.
// +kubebuilder:validation:XValidation:rule="!has(self.dataDisks) || self.dataDisks.all(d, (has(d.size) && !has(d.pvcName)) || (!has(d.size) && has(d.pvcName)))",message="exactly one of size and pvcName is required per data disk"
// +kubebuilder:validation:XValidation:rule="!has(self.dataDisks) || self.dataDisks.all(d, !has(d.pvcName) || d.type == 'shared')",message="pvcName is only allowed for type=shared"
// +kubebuilder:validation:XValidation:rule="!has(self.network) || !has(self.network.underlay) || has(self.network.underlay.pool)",message="spec.network.underlay.pool is required when underlay is set"
// +kubebuilder:validation:XValidation:rule="!has(self.ssh) || !has(self.ssh.passwordAuth) || self.ssh.enabled",message="passwordAuth requires ssh.enabled"
type VMEnvironmentSpec struct {
	// Image is the name of a VMImage in the platform catalogue. Only
	// catalogued images are accepted: this is not a container image reference,
	// and no other source exists. It is held to the name syntax of the object
	// it refers to, so a reference the catalogue could never resolve — a
	// registry path with a tag, say — is refused instead of stored.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=253
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`
	Image string `json:"image"`

	// Running is the desired running state.
	// +kubebuilder:default=false
	// +optional
	Running bool `json:"running,omitempty"`

	// Resources is the compute configuration: CPU count, guest memory and the
	// accelerators passed through to the guest.
	Resources ResourcesSpec `json:"resources"`

	// SystemDisk is the guest OS disk.
	SystemDisk VMSystemDisk `json:"systemDisk"`

	// DataDisks are additional disks.
	//
	// Each disk is identified by its name, which must therefore be unique: a
	// repeated one is refused by the API server.
	// +listType=map
	// +listMapKey=name
	// +optional
	DataDisks []VMDataDisk `json:"dataDisks,omitempty"`

	// Network configures the second interface, RDMA access and egress.
	// +optional
	Network *VMNetworkSpec `json:"network,omitempty"`

	// SSH configures SSH access to the guest. It is on by default: the guest
	// image runs sshd whether or not the platform exposes it.
	// +optional
	SSH *VMSSHSpec `json:"ssh,omitempty"`

	// NodeSelector constrains the guest to nodes carrying these labels.
	// +optional
	NodeSelector map[string]string `json:"nodeSelector,omitempty"`

	// SchedulerName names the scheduler that places the guest.
	// +optional
	SchedulerName string `json:"schedulerName,omitempty"`

	// Ports are application ports served from the guest and published through
	// the platform gateway. containerPort is the port inside the guest.
	//
	// Each port is identified by its name, which must therefore be unique: a
	// repeated one is refused by the API server.
	// +listType=map
	// +listMapKey=name
	// +optional
	Ports []PortSpec `json:"ports,omitempty"`
}

// VMSystemDisk is the guest OS disk.
type VMSystemDisk struct {
	// Size is the disk capacity. It must be at least the image's
	// minSystemDisk, and can only grow, and only while the environment is
	// stopped.
	Size resource.Quantity `json:"size"`

	// Retain keeps the disk when the environment is deleted. Default false:
	// the disk is deleted with the environment.
	// +kubebuilder:default=false
	// +optional
	Retain bool `json:"retain,omitempty"`
}

// VMDataDiskType is the kind of data disk.
type VMDataDiskType string

const (
	// VMDataDiskBlock is a block volume owned by this environment.
	VMDataDiskBlock VMDataDiskType = "block"
	// VMDataDiskShared is an existing ReadWriteMany filesystem shared between
	// environments; the platform never deletes it.
	VMDataDiskShared VMDataDiskType = "shared"
)

// VMDataDisk is an additional disk.
type VMDataDisk struct {
	// Name identifies the disk.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=32
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
	Name string `json:"name"`

	// Type is block (default) or shared.
	// +kubebuilder:validation:Enum=block;shared
	// +kubebuilder:default=block
	// +optional
	Type VMDataDiskType `json:"type,omitempty"`

	// Size creates a new disk of this capacity; mutually exclusive with
	// PVCName.
	// +optional
	Size *resource.Quantity `json:"size,omitempty"`

	// PVCName references an existing claim in the project namespace; mutually
	// exclusive with Size.
	// +kubebuilder:validation:MinLength=1
	// +optional
	PVCName string `json:"pvcName,omitempty"`

	// MountPath is where the guest mounts the disk. Absent leaves it attached
	// but unmounted.
	// +optional
	MountPath string `json:"mountPath,omitempty"`

	// ReadOnly mounts the disk read-only.
	// +kubebuilder:default=false
	// +optional
	ReadOnly bool `json:"readOnly,omitempty"`

	// Retain keeps the disk when the environment is deleted. Default false. A
	// shared disk is never deleted, whatever this says.
	// +kubebuilder:default=false
	// +optional
	Retain bool `json:"retain,omitempty"`
}

// VMNetworkSpec configures the VM network.
type VMNetworkSpec struct {
	// RDMAEnabled attaches a device from the fabric the cluster advertises.
	// +kubebuilder:default=false
	// +optional
	RDMAEnabled bool `json:"rdmaEnabled,omitempty"`

	// RDMAType names the fabric; effective when rdmaEnabled=true. Only roce is
	// offered: InfiniBand is refused at admission rather than accepted and
	// reported against the environment later.
	// +kubebuilder:validation:Enum=roce
	// +kubebuilder:default=roce
	// +optional
	RDMAType RDMAType `json:"rdmaType,omitempty"`

	// Egress is what the guest may reach on its own behalf.
	// +optional
	Egress *EgressSpec `json:"egress,omitempty"`

	// Underlay attaches the guest to a layer-2 project network. Absent means
	// pod network only.
	// +optional
	Underlay *VMUnderlaySpec `json:"underlay,omitempty"`
}

// VMUnderlaySpec is the layer-2 attachment.
type VMUnderlaySpec struct {
	// Pool names the cluster-scoped IPPool approved for this project, from
	// which a fixed address is claimed. Required whenever underlay is present:
	// the pool is what supplies the subnet, gateway and bridge, so there is no
	// way to attach a layer-2 network without one.
	// +kubebuilder:validation:MinLength=1
	Pool string `json:"pool"`
}

// VMSSHSpec configures SSH access to the guest.
type VMSSHSpec struct {
	// Enabled exposes SSH. On by default, unlike the container form: the guest
	// image runs sshd either way. It is a pointer so that "unset" (take the
	// default) and an explicit false are distinguishable.
	// +kubebuilder:default=true
	// +optional
	Enabled *bool `json:"enabled,omitempty"`

	// AuthorizedKeysSecret holds the public keys to install in the guest. When
	// omitted the platform mints a client keypair and records the Secret in
	// status.sshClientKeySecret.
	//
	// The Secret holds public keys, and its selected data entry is the file the
	// guest reads, so it must exist at the named key.
	// +kubebuilder:validation:XValidation:rule="size(self.name) > 0 && size(self.key) > 0",message="the Secret name and its data key must both be named"
	// +optional
	AuthorizedKeysSecret *corev1.SecretKeySelector `json:"authorizedKeysSecret,omitempty"`

	// PasswordAuth enables password authentication in the guest sshd. Absent
	// means off: a reachable sshd with password auth is a brute-force target.
	//
	// Public-key authentication is unaffected: with both configured, either
	// method logs in.
	// +optional
	PasswordAuth *VMSSHPasswordAuth `json:"passwordAuth,omitempty"`
}

// VMSSHPasswordAuth names where the login password comes from.
type VMSSHPasswordAuth struct {
	// PasswordSecret holds the password. When omitted the platform mints one
	// into <name>-ssh-password and records it in status.sshPasswordSecret.
	//
	// The password is never written to the resource: the spec carries a
	// reference, the status carries a reference, and what reaches the guest is
	// a hash.
	// +kubebuilder:validation:XValidation:rule="size(self.name) > 0 && size(self.key) > 0",message="the Secret name and its data key must both be named"
	// +optional
	PasswordSecret *corev1.SecretKeySelector `json:"passwordSecret,omitempty"`
}

// VMPhaseName is the running phase of a VM environment. It is this CRD's own
// vocabulary: the five values happen to match the container form's today, but
// the enum belongs to VMEnvironment and changes here are its own.
type VMPhaseName string

const (
	VMPhasePending     VMPhaseName = "Pending"
	VMPhaseRunning     VMPhaseName = "Running"
	VMPhaseStopped     VMPhaseName = "Stopped"
	VMPhaseFailed      VMPhaseName = "Failed"
	VMPhaseTerminating VMPhaseName = "Terminating"
)

// VMPhase describes the current running phase of a VM environment.
type VMPhase struct {
	// Name is the current phase.
	// +kubebuilder:validation:Enum=Pending;Running;Stopped;Failed;Terminating
	Name VMPhaseName `json:"name"`

	// LastTransitionTime is the time the current phase was reached.
	// +optional
	LastTransitionTime *metav1.Time `json:"lastTransitionTime,omitempty"`

	// Reason explains the phase. It carries the guest-runtime faults that
	// belong to no condition — a paused guest, a crash loop, an unavailable
	// launcher image.
	// +optional
	Reason string `json:"reason,omitempty"`

	// Message is the human-readable detail, carrying the underlying
	// virtualization layer's own text for the faults above.
	// +optional
	Message string `json:"message,omitempty"`
}

// VMEnvironmentStatus defines the observed state of VMEnvironment.
type VMEnvironmentStatus struct {
	// ObservedGeneration is the generation of the most recent spec the
	// controller has reconciled. If it is less than metadata.generation, the
	// status may be stale.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Phase describes the current running phase.
	// +optional
	Phase *VMPhase `json:"phase,omitempty"`

	// SSHClientKeySecret is the minted client keypair, absent when the spec
	// names the user's own public keys.
	// +optional
	SSHClientKeySecret *corev1.SecretReference `json:"sshClientKeySecret,omitempty"`

	// SSHPasswordSecret is the minted login password, absent when password
	// auth is off or the spec names the user's own Secret.
	// +optional
	SSHPasswordSecret *corev1.SecretReference `json:"sshPasswordSecret,omitempty"`

	// LastActivityTime is when the environment was last seen active.
	// +optional
	LastActivityTime *metav1.Time `json:"lastActivityTime,omitempty"`

	// Endpoints are the access addresses; withheld while stopped. A VM
	// environment publishes the guest consoles (vnc and serial), ssh, and one
	// entry per spec.ports[] entry under that port's name.
	// +optional
	Endpoints []Endpoint `json:"endpoints,omitempty"`

	// Conditions are the standard conditions of this resource: Accepted /
	// PlatformReady / AssetsReady / StorageReady / PodScheduled / GuestReady /
	// RouteReady / LiveMigratable / Ready.
	//
	// The status of each condition is one of True, False, or Unknown.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// Node is the node the guest currently runs on.
	// +optional
	Node string `json:"node,omitempty"`

	// IP is the guest's underlay address, when one was requested. It is stable
	// across reboots, stop/start and migration.
	// +optional
	IP string `json:"ip,omitempty"`

	// SystemDisk is the state of the guest OS disk.
	// +optional
	SystemDisk *VMDiskStatus `json:"systemDisk,omitempty"`

	// DataDisks are the states of the additional disks, keyed by name.
	// +listType=map
	// +listMapKey=name
	// +optional
	DataDisks []VMDiskStatus `json:"dataDisks,omitempty"`

	// Stopping is true while a graceful stop is in flight.
	// +optional
	Stopping bool `json:"stopping,omitempty"`

	// LastStop records the most recent stop.
	// +optional
	LastStop *VMStopRecord `json:"lastStop,omitempty"`

	// Migration records the most recent migration request.
	// +optional
	Migration *VMMigrationStatus `json:"migration,omitempty"`
}

// VMDiskStatus is the state of one virtual disk.
type VMDiskStatus struct {
	// Name is the disk's identifier: the data disk's spec name, or the system
	// disk's.
	Name string `json:"name"`

	// PVCName is the claim backing the disk.
	PVCName string `json:"pvcName"`

	// Phase is Pending, Importing, Ready, Resizing or Failed.
	Phase string `json:"phase"`

	// ImportProgress is the import percentage while the disk is importing.
	// +optional
	ImportProgress *int32 `json:"importProgress,omitempty"`

	// Message is the human-readable detail, e.g. the import failure.
	// +optional
	Message string `json:"message,omitempty"`
}

// VMStopRecord records one stop.
type VMStopRecord struct {
	// At is when the stop completed.
	At metav1.Time `json:"at"`

	// Forced is true when the graceful stop timed out and the guest was
	// killed.
	// +optional
	Forced bool `json:"forced,omitempty"`

	// Reason is UserRequested, Restart or Forced.
	// +optional
	Reason string `json:"reason,omitempty"`
}

// VMMigrationStatus records one migration request.
type VMMigrationStatus struct {
	// State is Pending, Running, Succeeded, Failed or Rejected.
	State string `json:"state"`

	// SourceNode is where the guest was when the migration started.
	// +optional
	SourceNode string `json:"sourceNode,omitempty"`

	// TargetNode is where the guest landed, or where it was to go.
	// +optional
	TargetNode string `json:"targetNode,omitempty"`

	// Reason is the machine-readable cause when State is Failed or Rejected.
	// +optional
	Reason string `json:"reason,omitempty"`

	// Message is the human-readable detail.
	// +optional
	Message string `json:"message,omitempty"`

	// LastTransitionTime is the time State last changed.
	LastTransitionTime metav1.Time `json:"lastTransitionTime"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=vme
// +kubebuilder:validation:XValidation:rule="self.metadata.name.size() <= 63 && self.metadata.name.matches('^[a-z]([-a-z0-9]*[a-z0-9])?$')",message="metadata.name must be a DNS-1035 label: at most 63 characters, lowercase letters, digits and hyphens, starting with a letter"
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase.name`
// +kubebuilder:printcolumn:name="Reason",type=string,JSONPath=`.status.phase.reason`
// +kubebuilder:printcolumn:name="IP",type=string,JSONPath=`.status.ip`
// +kubebuilder:printcolumn:name="Last activity",type=date,JSONPath=`.status.lastActivityTime`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// VMEnvironment is the Schema for the vmenvironments API.
//
// metadata.name must be a DNS-1035 label: lowercase letters, digits and
// hyphens, starting with a letter, at most 63 characters. It is also the name
// prefix of every object the platform derives for this environment, so a name
// already taken by an object this environment does not own is a conflict
// rather than a rename.
type VMEnvironment struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of VMEnvironment
	// +required
	Spec VMEnvironmentSpec `json:"spec"`

	// status defines the observed state of VMEnvironment
	// +optional
	Status VMEnvironmentStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// VMEnvironmentList contains a list of VMEnvironment
type VMEnvironmentList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []VMEnvironment `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &VMEnvironment{}, &VMEnvironmentList{})
		return nil
	})
}
