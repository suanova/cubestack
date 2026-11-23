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

// AllocationStrategy selects how a claim's address is chosen.
//
// +kubebuilder:validation:Enum=Auto;Exact
type AllocationStrategy string

const (
	// AllocationAuto takes the lowest free address in the pool's range that is not
	// excluded and not held by another claim. The default.
	AllocationAuto AllocationStrategy = "Auto"

	// AllocationExact asks for the address in Address. It never falls back to a
	// nearby address: a typo must fail rather than land somewhere plausible.
	AllocationExact AllocationStrategy = "Exact"
)

// AddressAllocation is a claim's request for a particular address.
//
// The second rule tests the length rather than comparing against a pair of
// single quotes: gofmt's doc-comment formatter rewrites that pair into a
// typographic quotation mark, which the CRD's CEL compiler then rejects.
// +kubebuilder:validation:XValidation:rule="!has(self.address) || self.strategy == 'Exact'",message="address may only be set when strategy is Exact"
// +kubebuilder:validation:XValidation:rule="self.strategy != 'Exact' || (has(self.address) && size(self.address) > 0)",message="strategy Exact requires address"
type AddressAllocation struct {
	// strategy is Auto or Exact.
	// +kubebuilder:default=Auto
	// +optional
	Strategy AllocationStrategy `json:"strategy,omitempty"`

	// address is the IPv4 address to claim. Only meaningful, and only allowed, when
	// strategy is Exact. It must lie inside the pool's range, outside its
	// exclusions, and not be held by another claim.
	// +kubebuilder:validation:Pattern=`^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$`
	// +optional
	Address string `json:"address,omitempty"`
}

// Blocker names something standing between a claim and its address.
//
// Structured rather than a sentence because the next step for a reader is usually
// "go and look at that object", and an address or a range is often what they were
// searching for.
type Blocker struct {
	// kind is the kind of the object in the way, e.g. "IPClaim" or
	// "NetworkAttachmentDefinition".
	// +required
	Kind string `json:"kind"`

	// namespace is the blocker's namespace. Empty for cluster-scoped objects.
	// +optional
	Namespace string `json:"namespace,omitempty"`

	// name is the blocker's name.
	// +required
	Name string `json:"name"`

	// address is the address at issue, when the blocker holds one.
	// +optional
	Address string `json:"address,omitempty"`

	// range is the band at issue, when the blocker is a band rather than an address.
	// +optional
	Range string `json:"range,omitempty"`
}

// IPClaimSpec defines the desired state of IPClaim.
//
// An IPClaim asks for one address from an IPPool, and — when nad is set — for a
// per-claim NetworkAttachmentDefinition carrying that address. The claim is
// created by whoever needs the address: a VM environment's controller, or a user
// by hand (design §10.2). IPAM does not assume the claim has a VM owner.
type IPClaimSpec struct {
	// poolRef names the IPPool to claim from. IPPool is cluster-scoped, so this is
	// a bare name with no namespace.
	//
	// Immutable once an address is bound, as are nad and allocation: the CRD
	// refuses a change to any of the three while status.assignedIP is set. The
	// bounded fields are the binding, and the NAD already carries the address, so
	// a change can only make the claim and its network disagree. Before binding
	// they are ordinary fields, because a typo is worth fixing rather than
	// deleting. To move a bound address to another pool, delete the claim and
	// create a new one.
	// +kubebuilder:validation:MinLength=1
	// +required
	PoolRef string `json:"poolRef"`

	// nad optionally names the NetworkAttachmentDefinition to mint for this claim,
	// in the IPClaim's own namespace. The generated NAD takes this name verbatim,
	// which is what lets a VM manifest be written before the claim is satisfied —
	// the VM references the NAD by a name it already knows.
	//
	// Omit it for an address-only claim: an address is bound and nothing is created.
	// The referenced pool must carry a nadTemplate, otherwise the claim fails with
	// reason TemplateMissing.
	//
	// Immutable once an address is bound, like poolRef: renaming it then would mint
	// a second NAD carrying the same address and leave the first one behind until
	// the claim is deleted.
	// +kubebuilder:validation:MaxLength=253
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`
	// +optional
	NAD string `json:"nad,omitempty"`

	// allocation optionally asks for a named address instead of the lowest free
	// one. Absent means Auto.
	//
	// Immutable once an address is bound, like poolRef. That is not merely
	// conservative: the assigned address is kept, never re-derived, so a change
	// after binding could not take effect even if it were allowed.
	// +optional
	Allocation *AddressAllocation `json:"allocation,omitempty"`
}

// IPClaimStatus defines the observed state of IPClaim.
type IPClaimStatus struct {
	// assignedIP is the address this claim holds, once bound.
	// +optional
	AssignedIP string `json:"assignedIP,omitempty"`

	// blockers names what stood in the way of the requested address, when the claim
	// asked for a specific one and did not get it.
	// +optional
	Blockers []Blocker `json:"blockers,omitempty"`

	// conditions represent the current state of the IPClaim resource.
	// Each condition has a unique type and reflects the status of a specific aspect of the resource.
	//
	// Condition types set here:
	// - "Ready": True once an address is assigned and, if spec.nad was set, its NAD exists.
	//   The cause of a False goes in the condition's reason -- "PoolNotFound",
	//   "NamespaceNotAllowed", "RangeInvalid", "RangeExhausted", "TemplateMissing",
	//   "NADNotOwned", "AddressOutOfRange", "AddressExcluded", "AddressUnavailable",
	//   "ExactNotAllowed", "AllocationInvalid" -- rather than into a condition type of
	//   its own.
	// - "DuplicateAddress": written by the audit sweep when this claim shares its
	//   address with another claim on the same subnet. A separate type because a
	//   different writer owns it; removed by the next sweep that finds nothing.
	//
	// The status of each condition is one of True, False, or Unknown.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=ipc
// +kubebuilder:validation:XValidation:rule="!has(oldSelf.status) || !has(oldSelf.status.assignedIP) || (self.spec.poolRef == oldSelf.spec.poolRef && has(self.spec.nad) == has(oldSelf.spec.nad) && (!has(self.spec.nad) || self.spec.nad == oldSelf.spec.nad) && has(self.spec.allocation) == has(oldSelf.spec.allocation) && (!has(self.spec.allocation) || (self.spec.allocation.strategy == oldSelf.spec.allocation.strategy && has(self.spec.allocation.address) == has(oldSelf.spec.allocation.address) && (!has(self.spec.allocation.address) || self.spec.allocation.address == oldSelf.spec.allocation.address))))",message="poolRef, nad and allocation are immutable once status.assignedIP is set"
// +kubebuilder:printcolumn:name="Pool",type=string,JSONPath=`.spec.poolRef`
// +kubebuilder:printcolumn:name="Assigned",type=string,JSONPath=`.status.assignedIP`
// +kubebuilder:printcolumn:name="NAD",type=string,JSONPath=`.spec.nad`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Reason",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].reason`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// IPClaim is the Schema for the ipclaims API
type IPClaim struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of IPClaim
	// +required
	Spec IPClaimSpec `json:"spec"`

	// status defines the observed state of IPClaim
	// +optional
	Status IPClaimStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// IPClaimList contains a list of IPClaim
type IPClaimList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []IPClaim `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &IPClaim{}, &IPClaimList{})
		return nil
	})
}
