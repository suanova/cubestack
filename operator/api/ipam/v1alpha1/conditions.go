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

// ConditionType aliases the plain string that metav1.Condition.Type is, so the
// constants below assign to it without a conversion. It is an alias, not a
// defined type, precisely so that meta.SetStatusCondition and friends accept them
// directly.
type ConditionType = string

// Condition types set on IPPool and IPClaim.
//
// There is one primary condition per kind — Available for a pool, Ready for a
// claim — and the cause goes in its Reason rather than into a condition type of
// its own. A Degraded condition was considered and deliberately left out: on both
// kinds it would be the exact complement of the primary one, so two entries would
// carry one fact and could disagree.
//
// DuplicateAddress is the one exception, and for the opposite reason: it is not a
// verdict on the object but a report about the cluster, written by the audit
// sweep. It gets its own type so that the two writers — reconciler and auditor —
// never touch the same condition and can retry on a conflicting write without
// either overwriting the other's fact.
const (
	// ConditionAvailable is True when an IPPool is usable — its range parses, its
	// exclusions are coherent with it, and its template (if any) agrees.
	ConditionAvailable ConditionType = "Available"

	// ConditionReady is True when an IPClaim has been satisfied: an address is
	// assigned, and a NAD exists if one was asked for. Every reason an address is
	// not held — a missing pool, a namespace the pool does not admit, an excluded
	// or already-taken address, a template that cannot mint — goes in this
	// condition's reason rather than into a condition type of its own.
	ConditionReady ConditionType = "Ready"

	// ConditionDuplicateAddress is True when the audit sweep found this object
	// implicated in an address collision: two claims holding one address on the
	// same L2, or two pools with overlapping bands. Written by the auditor only,
	// and removed by the next sweep that finds nothing.
	ConditionDuplicateAddress ConditionType = "DuplicateAddress"
)

// Reasons accompanying the conditions above. A Reason is required on every
// metav1.Condition, so these exist to keep them consistent between the code that
// writes a condition and the tests that assert on it.
const (
	ReasonPoolNotFound   = "PoolNotFound"
	ReasonRangeValid     = "RangeValid"
	ReasonRangeInvalid   = "RangeInvalid"
	ReasonRangeExhausted = "RangeExhausted"
	ReasonBound          = "Bound"

	// ReasonRangeFullyExcluded marks a pool whose exclude list covers its whole
	// range. Distinct from RangeInvalid because the pool is well formed — an admin
	// took every address out of use on purpose — and the fix is to widen the range
	// or narrow the exclusions, not to correct a malformed field.
	ReasonRangeFullyExcluded = "RangeFullyExcluded"

	// ReasonNamespaceNotAllowed marks a claim whose namespace is not in the pool's
	// spec.namespaces. The list is prospective: an address already assigned is
	// kept, and only new allocations are refused.
	ReasonNamespaceNotAllowed = "NamespaceNotAllowed"

	// Reasons an exact request is not honoured. Each names a different fix, which is
	// why they are not collapsed into one: the address is outside the band, inside
	// an exclusion, held by another claim, or the pool does not accept exact
	// requests at all.
	ReasonAddressOutOfRange  = "AddressOutOfRange"
	ReasonAddressExcluded    = "AddressExcluded"
	ReasonAddressUnavailable = "AddressUnavailable"

	// ReasonExactNotAllowed marks an exact request against a pool whose
	// spec.allowExact is false.
	ReasonExactNotAllowed = "ExactNotAllowed"

	// ReasonAllocationInvalid marks a spec.allocation that cannot be honoured as
	// written: an unknown strategy, an address that does not parse, or an Exact
	// request with no address.
	ReasonAllocationInvalid = "AllocationInvalid"

	// ReasonTemplateMissing marks a claim that asks for a NAD against a pool with no
	// nadTemplate, so none can be minted.
	ReasonTemplateMissing = "TemplateMissing"

	// ReasonReserved marks a claim whose address is held but whose NAD does not exist
	// yet. Ready is False because the network the address is for is not there; the
	// address is published first anyway, so that a claim whose NAD write fails cannot
	// leave the address looking free to a second claim.
	ReasonReserved = "Reserved"

	// ReasonNADNotOwned marks a spec.nad whose name is already held by an object
	// this claim does not control. Such an object is never adopted or overwritten;
	// the claim retries once the name is free, because the NAD is watched.
	ReasonNADNotOwned = "NADNotOwned"

	// ReasonMultusMissing marks a claim that asks for a NAD on a cluster that does
	// not serve the kind: Multus is not installed, so nothing could mint one. The
	// claim is not retried — the fix is the administrator installing Multus.
	ReasonMultusMissing = "MultusMissing"

	// ReasonDuplicateAddress is the audit's reason on a claim that shares its
	// address with another claim. ReasonPoolOverlap is its counterpart on a pool
	// whose band intersects another pool's on the same subnet.
	ReasonDuplicateAddress = "DuplicateAddress"
	ReasonPoolOverlap      = "PoolOverlap"
)

// Labels written by the controllers.
const (
	// LabelClaim is set on a minted NAD and carries the name of the IPClaim that
	// owns it, shortened when the name is longer than a label value may be. The NAD
	// is always created in its claim's namespace, so the value alone identifies the
	// owner — the audit uses this to find NADs whose claim is gone.
	LabelClaim = "ipam.cubestack.io/claim"
)
