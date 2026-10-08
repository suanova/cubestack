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
	// mounted at the workspace path (spec.storage.mountPath, else derived from
	// spec.runtime). Before the environment starts, the claim's root is made
	// writable by the environment's identity (spec.runtime.securityContext), so
	// an environment with storage always comes up with a usable home. Omit it to
	// avoid creating a managed workspace PVC; to use an existing PVC as the
	// workspace, mount it via spec.volumes at the workspace path (e.g.
	// /workspace).
	// +optional
	Storage *StorageSpec `json:"storage,omitempty"`

	// Volumes are data volume mounts referencing existing PVCs. If spec.storage
	// is omitted, mount an existing PVC at the workspace path (e.g. /workspace)
	// to use it as the environment's workspace. The controller changes the
	// ownership of nothing but the workspace claim spec.storage provisions: a
	// referenced PVC is mounted as it is, so it has to carry permissions the
	// environment's account can work with (spec.runtime.securityContext
	// .runAsUser / runAsGroup) — the platform does not modify storage it merely
	// references.
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

// ResourcesSpec is the compute / resource configuration.
type ResourcesSpec struct {
	// GPU requests accelerators. Absent asks for none: no vendor is named, no
	// vendor GPU resource goes into the pod, and the image brand is not checked,
	// which is what makes the CPU images usable. It is deliberately not defaulted
	// into existence — defaulting it would put an accelerator on every
	// environment and leave "no accelerator" with no way to be expressed.
	// +optional
	GPU *GPUSpec `json:"gpu,omitempty"`

	// CPU is the CPU limit in cores.
	// +optional
	CPU string `json:"cpu,omitempty"`

	// Memory is the memory limit.
	// +optional
	Memory string `json:"memory,omitempty"`
}

// GPUSpec requests accelerators: how many, and of which vendor. It exists only
// when the environment asks for at least one, so a vendor can never describe a
// device that is not there.
type GPUSpec struct {
	// Vendor is the GPU vendor: nvidia / metax. It decides the GPU extended
	// resource (nvidia.com/gpu / metax-tech.com/gpu) and image brand matching.
	// +kubebuilder:default=nvidia
	// +optional
	Vendor AcceleratorVendor `json:"vendor,omitempty"`

	// Count is the number of GPU cards to request. Omit it for the default of 1.
	// There is no zero: omitting the whole gpu block is how an environment asks
	// for no accelerator.
	// +kubebuilder:default=1
	// +kubebuilder:validation:Minimum=1
	// +optional
	Count *int32 `json:"count,omitempty"`
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
	// delete=remove the workspace claim together with the environment (default:
	// the claim is provisioned for the environment from the platform's
	// volumeClaimTemplate, so it is reclaimed with it) / retain=keep the claim.
	// A retained claim outlives the environment: nothing garbage-collects it, and
	// it is identified by its name — workspace-<metadata.name>-0 — and its
	// ai.cubestack.io/dev-environment label. Recreating a DevEnvironment with the
	// same name in the same namespace reuses it, because the new StatefulSet
	// adopts the claim it finds instead of provisioning another; an unwanted
	// claim is reclaimed by deleting it administratively.
	// +kubebuilder:validation:Enum=retain;delete
	// +kubebuilder:default=delete
	// +optional
	PVCRetention PVCRetentionPolicy `json:"pvcRetention,omitempty"`

	// MountPath is the path where the workspace PVC is mounted, and the HOME the
	// container is stated: the controller sets the path it mounts at as HOME on the
	// main container, so where the workspace is and where the container's home is
	// are one decision rather than two. Leave it unset to derive the path from
	// spec.runtime: HOME from spec.runtime.env when it names an absolute path
	// outright, else /root when the container runs as root, else /home/<user> when
	// spec.runtime.user names an account, and /workspace otherwise. Set it to pin a
	// different path — e.g. for a bring-your-own image whose home is somewhere else:
	// the image is told which path that is, so a launcher that serves the home it is
	// handed serves the workspace. Stating HOME says nothing about the working
	// directory, which stays the image's. A declared HOME that this outranks is
	// reported on the Accepted condition.
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

	// AuthorizedKeysSecret is the SSH public key Secret reference. If specified,
	// the controller generates the environment's host identity alone and mounts
	// this Secret's data[key] as the container's authorized_keys, so the Secret
	// must carry the label ai.cubestack.io/ssh-keys-delegated: "true"
	// — only a Secret that names itself for this use is mounted into a workload.
	// Otherwise the controller generates the host identity and a client keypair,
	// and status.sshClientKeySecret names the Secret holding the latter. The
	// plaintext is never stored in spec.
	// +kubebuilder:validation:XValidation:rule="self.key != ''",message="key must name the Secret data entry the container mounts"
	// +optional
	AuthorizedKeysSecret *corev1.SecretKeySelector `json:"authorizedKeysSecret,omitempty"`
}

// NetworkSpec configures the network.
//
// RDMA access is granted per fabric: an environment is given a device the
// cluster advertises for the fabric it names. How that device is attached to
// the environment, and what else it takes, is the platform's to arrange — it
// is deliberately not part of this API, so the arrangement can change without
// the environment changing with it.
type NetworkSpec struct {
	// RDMAEnabled gives the environment access to an RDMA device on the node it
	// runs on.
	//
	// The device is advertised by the cluster, so which one an environment
	// requests is cluster configuration rather than a field here; an
	// environment whose requested device no node advertises stays Pending.
	//
	// Registering a memory region locks pages, and the capability that permits
	// it is outside the set the Baseline Pod Security Standard allows, so the
	// namespace has to admit the privileged standard. That holds whichever
	// fabric is selected.
	// +kubebuilder:default=false
	// +optional
	RDMAEnabled bool `json:"rdmaEnabled,omitempty"`

	// RDMAType names the fabric the environment joins; effective when
	// rdmaEnabled=true.
	//
	// The fabric is what addresses the peers: an InfiniBand fabric assigns the
	// addresses a device uses, a RoCE fabric derives them from the host's own
	// networking, so an environment is reachable only on the fabric it names.
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
	// HOME is also an input to where the workspace mounts: an absolute path named
	// outright precedes the home the runtime identity implies, so it decides both
	// the mount path (spec.storage.mountPath) and what the container is told its
	// home is. A valueFrom HOME and a $(VAR) HOME are not inputs — neither is
	// resolvable when the workload is rendered — so the mount follows the identity
	// instead and the entry is reported on the Accepted condition.
	//
	// An environment with a workspace claim is told where it is: the controller
	// states the mount path as HOME on the main container, whatever type and
	// whichever account the image runs, so a launcher that serves HOME serves the
	// workspace without having to know what its own image bakes. It states it
	// ahead of the entries here, so one of them may name it — `PROJECT=$(HOME)/project`
	// resolves rather than naming that text. An environment without a claim is
	// told no home of the controller's: a HOME declared here stands as written,
	// and the image's home applies only where this list declares none.
	//
	// Some values are the controller's rather than the spec's on a jupyter
	// environment, and an entry declaring one is dropped and replaced: JUPYTER_TOKEN;
	// any --ServerApp.base_url inside NOTEBOOK_ARGS, which has to name the prefix
	// the route publishes; and — when securityContext.runAsUser is 0 — the launcher
	// settings a root container needs (NB_USER, NB_UID, NB_GID, and --allow-root
	// inside NOTEBOOK_ARGS). A root environment therefore declares nothing for any
	// of them. Each substitution is reported on the Accepted condition, which names
	// the value the controller applied instead; the one entry it cannot substitute
	// is a NOTEBOOK_ARGS fed by valueFrom, which refuses the environment instead.
	// +optional
	Env []corev1.EnvVar `json:"env,omitempty"`

	// User is the container account the environment runs as — the account the
	// image's own sshd serves — and the account the SSH endpoint advertises. It
	// defaults to the platform's conventional account "user"; set it when the
	// image runs as something else (e.g. "jovyan" for a docker-stacks image),
	// since a non-root sshd can only serve the uid it runs as, and
	// securityContext.runAsUser has to name that same account. An environment
	// running as root is advertised as "root" whatever this field says: that is
	// the account its sshd runs as, where which family account a root sshd admits
	// beside it is the image's to decide. Such an environment has its Accepted
	// condition report this field as ignored.
	// +kubebuilder:validation:MaxLength=32
	// +kubebuilder:validation:Pattern=`^[a-z_][a-z0-9_-]*$`
	// +optional
	User string `json:"user,omitempty"`

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
	// set 0 to run as root. Running as root is the whole of the request: the
	// controller supplies whatever the image needs to start as root, so nothing
	// has to be declared for it in spec.runtime.env.
	// +optional
	RunAsUser *int64 `json:"runAsUser,omitempty"`

	// RunAsGroup is the group ID to run the container as. Together with
	// runAsUser it is the identity the workspace claim is initialized to, so
	// everything the environment creates in its workspace — including the
	// workspace root itself — belongs to that group.
	// +optional
	RunAsGroup *int64 `json:"runAsGroup,omitempty"`
}

// LifecycleSpec configures the lifecycle.
type LifecycleSpec struct {
	// IdleTimeout is the idle auto-shutdown timeout in seconds; 0 disables it.
	//
	// An environment idle for this long is stopped without its spec being
	// touched: the workload is scaled to zero and status.phase reports Stopped
	// with reason IdleTimeout, while spec.running stays as the user left it. The
	// stop is marked with the annotation ai.cubestack.io/auto-stopped on the
	// DevEnvironment, and that mark — not spec.running — is what says the
	// environment is stopped.
	//
	// A client starting an environment must therefore clear that annotation.
	// With spec.running already true a start changes nothing this platform can
	// observe, so an environment left marked stays stopped.
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

	// Type is the exposure form.
	//
	// http publishes the port as a sub path of the Gateway's HTTP listener —
	// /dev/<namespace>/<name>/port/<this port's name>/ — and the request
	// reaches the container in cleartext. It is not a way to expose a port that
	// serves TLS: the container would receive a plain HTTP request where it
	// expects a TLS handshake, and the Gateway does not re-encrypt to it.
	//
	// tcp publishes the port over L4 instead — a listener of the environment's
	// own, on a port from the platform's L4 range, plus a TCPRoute — with
	// nothing above it interpreting the stream.
	//
	// A port that serves TLS is exposed as tcp, and as tcp only: the handshake
	// crosses the Gateway untouched and the client validates the certificate
	// the container itself presents, so the address in status.endpoints is
	// reached by prefixing the scheme — an app terminating TLS on 8443 is
	// published with type tcp and containerPort 8443, and reached at
	// https://<address>. The platform neither terminates nor re-originates TLS,
	// and what it publishes is an address, not a hostname: matching an endpoint
	// by SNI (a TLSRoute on a shared TLS listener) is not implemented, so the
	// certificate has to cover the address the client dials.
	//
	// udp publishes the port over L4 the same way, as a listener and a UDPRoute
	// of its own, and the address in status.endpoints is reached by prefixing
	// udp://. tcp and udp draw on the same pool, and a number is held by one
	// protocol only: the two cannot be published on the same port number.
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

	// SSHClientKeySecret is the client keypair the controller minted, recorded so
	// the environment's owner can retrieve the private half and log in. It holds
	// id_ed25519, the private half, and id_ed25519.pub, which is what the container
	// mounts as authorized_keys.
	//
	// Absent when spec.ssh.authorizedKeysSecret names the user's own Secret. That
	// Secret holds public keys rather than a client key, and its name is already in
	// the spec, so there is nothing generated to point at. The environment's host
	// key is not here either: it lives in the separate <env>-ssh-host-key Secret.
	// +optional
	SSHClientKeySecret *corev1.SecretReference `json:"sshClientKeySecret,omitempty"`

	// JupyterTokenSecret is the Secret the environment's Jupyter token comes from,
	// for a jupyter environment: the managed <env>-jupyter-token Secret the controller
	// generates, holding the token under the data key "token". It is recorded in
	// status so the user can retrieve the token, which the web route requires.
	// Absent for every other environment type, which serves no authenticated web
	// path.
	// +optional
	JupyterTokenSecret *corev1.SecretReference `json:"jupyterTokenSecret,omitempty"`

	// LastActivityTime is when the environment was last seen active, which is
	// what the idle timeout is measured against. It is reported by the
	// environment's own activity agent, which writes the pod annotation
	// ai.cubestack.io/last-activity while it sees activity — so the value
	// standing still is the signal, and it is absent until the environment has
	// been active at least once.
	// +optional
	LastActivityTime *metav1.Time `json:"lastActivityTime,omitempty"`

	// Endpoints are the access addresses of the environment: the web (Jupyter)
	// URL, the SSH address, and any extra application port exposures. The list is
	// withheld while the environment is stopped: nothing is listening behind the
	// routes, so an address published then would lead nowhere. It is restored when
	// the environment starts again, the SSH address on the port it held.
	// +optional
	Endpoints []Endpoint `json:"endpoints,omitempty"`

	// Conditions: Accepted / PodScheduled / RouteReady / Ready (type constants
	// below).
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
	// http://<gw-ip>:<port>/dev/<ns>/<env>/), or a host:port for SSH and tcp/udp
	// ports (e.g. ssh://user@<gw-ip>:<port>). The port is the one the address is
	// reachable on, which is not ListenerPort when the Gateway's dataplane
	// Service is a NodePort Service.
	Address string `json:"address"`

	// ListenerPort is the Gateway listener port the endpoint is published on: the
	// port the environment's ListenerSet declares, or the Gateway's HTTP listener
	// port for the web endpoint. The controller reuses it across reconciles, so
	// the environment's listener allocation is stable for as long as the exposure
	// exists. It is not necessarily the port in Address: a NodePort dataplane
	// renumbers each listener onto a port from the cluster's node-port range, and
	// that renumbering is not part of the allocation — a dataplane Service
	// recreated with different nodePorts changes Address while this does not.
	// Address says where the endpoint is reachable now, not where it will stay.
	// +optional
	ListenerPort int32 `json:"listenerPort,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=devenv

// DevEnvironment is the Schema for the devenvironments API.
//
// An environment with spec.storage starts from an init container that takes
// ownership of its workspace claim, running as root with every capability
// dropped and CAP_CHOWN, CAP_FOWNER and CAP_FSETID added back, so a namespace
// hosting it has to be at the Baseline Pod Security Standard: root and any
// capability beyond NET_BIND_SERVICE are rejected at Restricted, and Pod
// Security Admission has no per-container exemption.
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
