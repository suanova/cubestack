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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// NOTE ON PLURALS: Whereabouts already owns the `ippools` plural
// (ippools.whereabouts.cni.cncf.io) in kube-system. This type's plural is
// `ippools.ipam.cubestack.io`, so callers listing pools MUST disambiguate with
// the full resource name. There is no short name on purpose — one would make the
// collision worse rather than better.

// IPPoolSpec defines the desired state of IPPool.
//
// An IPPool is created by a cluster admin and declares a bounded band of
// addresses that may be claimed via IPClaim (design §10.2). It is also the policy
// of record for that band: which parts of it are never handed out, whether named
// addresses may be requested, and which namespaces may claim at all.
//
// The fields divide along one line: range, exclude and allowExact are the
// ALLOCATOR's; namespaces is the admission policy; nadTemplate is the CNI's. That
// is why range is the only required field — a pool that never mints a NAD only
// allocates, so it never needs a subnet or a gateway. Everything the minted config
// contains lives in the template, and is required exactly when the template is
// present.
//
// The range MUST be disjoint from any other NAD serving the same subnet, and
// from the MetalLB pool if one exists on it. That is an admin responsibility
// rather than a controller check: with the shared underlay NAD retired, there is
// no longer a live object to audit against, and regular users cannot create
// NADs. See the README.
//
// Only the two containment rules below are CEL: the Kubernetes CEL net library
// exposes cidr(...).containsIP(ip(...)) but defines NO ordering overload on IP
// values, so "start <= end" and "gateway is outside the range" are not
// expressible as schema rules however they are written. They are enforced in Go
// instead — see ipam.ValidatePoolRange, which the reconciler calls.
//
// +kubebuilder:validation:XValidation:rule="!has(self.nadTemplate) || cidr(self.nadTemplate.subnet).containsIP(ip(self.range.start))",message="range.start must lie within the nadTemplate subnet"
// +kubebuilder:validation:XValidation:rule="!has(self.nadTemplate) || cidr(self.nadTemplate.subnet).containsIP(ip(self.range.end))",message="range.end must lie within the nadTemplate subnet"
type IPPoolSpec struct {
	// range is the inclusive band of addresses available to IPClaim requests.
	// It must not overlap any other NAD serving the same subnet. Regular users
	// cannot create NADs, so this is an admin responsibility rather than something
	// the controller can observe — see the README.
	//
	// This is the only required field. A pool with no nadTemplate allocates
	// addresses and mints nothing, so it needs no subnet and no gateway.
	// +required
	Range IPRange `json:"range"`

	// exclude lists bands the allocator never hands out, even though they lie in
	// range: a block reserved for another system, a gateway on a wider band, or an
	// address found to be in use outside the platform.
	//
	// Prospective, not retroactive. Excluding an address does not take it back from
	// a claim that already holds it — the NAD on that VM still carries it — so the
	// procedure for a live collision is to exclude the address and delete the claim
	// holding it (design §10.5). A pool whose exclusions cover its whole range
	// reports Available=False / RangeFullyExcluded.
	//
	// The bands must ascend, must not overlap each other, and must lie inside range.
	// All three are checked by the controller rather than the schema, and a
	// violation reports Available=False / RangeInvalid.
	// +optional
	Exclude []IPRange `json:"exclude,omitempty"`

	// allowExact controls whether claims may ask for one named address
	// (spec.allocation.strategy=Exact) instead of the lowest free one. Defaults to
	// true. Set it to false on a pool where addresses must be handed out rather than
	// chosen — an exact request against such a pool fails with
	// Ready=False / ExactNotAllowed.
	// +optional
	AllowExact *bool `json:"allowExact,omitempty"`

	// namespaces lists the namespaces whose claims may allocate from this pool. The
	// list is the whole allow-list: an empty or absent list admits nobody, so a pool
	// is unusable until it names at least one namespace.
	//
	// Checked when an address is allocated, not continuously: narrowing the list does
	// not revoke an address that is already assigned, and widening it unblocks the
	// claims that were waiting. A claim outside it reports
	// Ready=False / NamespaceNotAllowed.
	// +optional
	Namespaces []string `json:"namespaces,omitempty"`

	// nadTemplate is the network config cloned into every NAD this pool mints,
	// including the addressing that config carries.
	//
	// Optional, because a pool need not serve claims that ask for a NAD. A claim
	// that sets IPClaim.spec.nad against a pool with no template fails with a
	// TemplateMissing reason rather than silently binding without a network.
	//
	// Its fields (subnet, gateway, bridge) are required whenever the template is
	// present, so there is no half-specified template to reason about and no
	// cross-field rule needed to enforce that: the field list IS the rule.
	// +optional
	NADTemplate *NADTemplate `json:"nadTemplate,omitempty"`
}

// NADTemplate is the NetworkAttachmentDefinition config cloned into every NAD a
// pool mints.
//
// Only the fields this project actually sets are modelled. A CNI feature that is
// not here cannot be expressed at all — that is the accepted cost of typing the
// template rather than embedding an opaque JSON blob. In exchange, a missing
// bridge, an out-of-range VLAN or an unknown plugin type is rejected by the CRD
// at admission, instead of surfacing later as a VM stuck in FailedCreatePodSandBox.
//
// Addressing lives here rather than on IPPoolSpec because it is addressing OF
// THE MINTED CONFIG, and is meaningless without one. subnet supplies the address's
// prefix length and the containment check, and gateway becomes that address's
// gateway. The claim's own address is not here: it is injected per claim, from the
// address the controller assigned it.
//
// There is no addressing-mode field. A minted NAD always carries its address as a
// literal assignment, which is what lets two pods hold one address at once and
// therefore what makes live migration possible (design §10.1).
type NADTemplate struct {
	// subnet is the CIDR the minted NAD's address belongs to, e.g. "10.66.3.0/24".
	// It gives the generated config its prefix length, and is what the assigned
	// address is checked against for containment.
	//
	// This is not the allocatable band — that is IPPool.spec.range, which must lie
	// within this subnet. Several pools may share one subnet as long as their bands
	// are disjoint.
	// +kubebuilder:validation:Pattern=`^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])/(3[0-2]|[12]?[0-9])$`
	// +required
	Subnet string `json:"subnet"`

	// gateway is the default gateway handed to VMs whose address comes from this
	// pool. It must sit inside subnet — a bridge binding needs it on the same L2 —
	// and outside the allocatable range in IPPool.spec.range.
	// +kubebuilder:validation:Pattern=`^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$`
	// +required
	Gateway string `json:"gateway"`

	// type is the CNI plugin type. cnv-bridge is the linux bridge binding used on
	// this cluster's underlay.
	// +kubebuilder:validation:Enum=cnv-bridge;bridge
	// +kubebuilder:default=cnv-bridge
	// +optional
	Type string `json:"type,omitempty"`

	// bridge is the linux bridge the VM's interface is enslaved to, e.g. "br0".
	// +kubebuilder:validation:MinLength=1
	// +required
	Bridge string `json:"bridge"`

	// vlan is the VLAN id, when the bridge is VLAN-filtered. Omit for an untagged
	// bridge.
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=4094
	// +optional
	VLAN *int32 `json:"vlan,omitempty"`

	// macspoofchk enables MAC spoof checking on the interface.
	// +optional
	MacSpoofChk *bool `json:"macspoofchk,omitempty"`

	// dns is handed to the guest alongside its address.
	// +optional
	DNS *NADDNS `json:"dns,omitempty"`

	// routes are injected into the guest alongside the default gateway.
	// +optional
	Routes []NADRoute `json:"routes,omitempty"`
}

// NADDNS is the DNS config handed to the guest.
type NADDNS struct {
	// nameservers is the list of resolvers.
	// +optional
	Nameservers []string `json:"nameservers,omitempty"`

	// domain is the local domain the guest resolves within.
	// +optional
	Domain string `json:"domain,omitempty"`

	// search is the list of search domains.
	// +optional
	Search []string `json:"search,omitempty"`
}

// NADRoute is a route injected into the guest.
type NADRoute struct {
	// dst is the destination CIDR, e.g. "0.0.0.0/0".
	// +kubebuilder:validation:MinLength=1
	// +required
	Dst string `json:"dst"`

	// gw is the next hop. Omit to route via the interface's own gateway.
	// +optional
	GW string `json:"gw,omitempty"`
}

// IPRange is an inclusive address band. Both bounds are required. A band holding
// a single address is expressed as start == end — that is the shape the
// controller generates per-VM NADs from, so it is deliberately representable.
type IPRange struct {
	// start is the first address in the band (inclusive).
	// +kubebuilder:validation:Pattern=`^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$`
	// +required
	Start string `json:"start"`

	// end is the last address in the band (inclusive).
	// +kubebuilder:validation:Pattern=`^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$`
	// +required
	End string `json:"end"`
}

// IPPoolStatus defines the observed state of IPPool.
//
// DELIBERATE OMISSION: there is no status.allocated[] ledger here. The set of
// IPClaims is the ONLY authoritative record of who holds what, and modelling a
// second list would create exactly the two-ledger drift this project exists to
// avoid — the allocator derives "who holds what" from the claim set on every
// allocation, under the single-writer discipline described in design §10.4.
type IPPoolStatus struct {
	// conditions represent the current state of the IPPool resource.
	// Each condition has a unique type and reflects the status of a specific aspect of the resource.
	//
	// Condition types set here:
	// - "Available": True when the pool is usable -- its range parses, its exclusions
	//   are ordered, non-overlapping and inside the range, and, when it has a
	//   nadTemplate, that template's subnet and gateway are coherent with the range.
	//   A False carries the cause in its reason, e.g. "RangeInvalid" or
	//   "RangeFullyExcluded"; there is no separate "Degraded" type, which would be
	//   its exact complement.
	// - "DuplicateAddress": written by the audit sweep when this pool's band
	//   overlaps another pool's on the same subnet, with reason "PoolOverlap". It is
	//   a separate type because a different writer owns it, and it is removed by the
	//   next sweep that finds nothing.
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
// +kubebuilder:printcolumn:name="Subnet",type=string,JSONPath=`.spec.nadTemplate.subnet`
// +kubebuilder:printcolumn:name="Start",type=string,JSONPath=`.spec.range.start`
// +kubebuilder:printcolumn:name="End",type=string,JSONPath=`.spec.range.end`
// +kubebuilder:printcolumn:name="Gateway",type=string,JSONPath=`.spec.nadTemplate.gateway`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// IPPool is the Schema for the ippools API
type IPPool struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of IPPool
	// +required
	Spec IPPoolSpec `json:"spec"`

	// status defines the observed state of IPPool
	// +optional
	Status IPPoolStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// IPPoolList contains a list of IPPool
type IPPoolList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []IPPool `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &IPPool{}, &IPPoolList{})
		return nil
	})
}
