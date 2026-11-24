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

package ipam

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	ipamv1alpha1 "github.com/suanova/cubestack/api/ipam/v1alpha1"
	ipamutil "github.com/suanova/cubestack/internal/ipam"
)

// nadNameField indexes IPClaims by their spec.nad, so a NAD event can be mapped
// back to the claim that asked for that name.
//
// By name, not by ownerReference: the case this exists for is a NAD this claim
// does *not* own — a name collision — and an owner-based lookup would find nothing
// to retry when that object finally goes away.
const nadNameField = "spec.nad"

// NADTeardownFinalizer keeps a deleting IPClaim visible until the NAD it minted
// has been removed.
//
// The ledger of held addresses is status.assignedIP on the claims themselves, and
// a NAD's config is a literal static assignment. If the claim vanished first, the
// address would still be published by a NAD while nothing counted it as held, and
// another claim could be handed the same address. Holding the claim until its NAD
// is gone keeps the two in step.
//
// The finalizer ties the claim to the NAD and to nothing else. A pod that attached
// while the NAD existed keeps the address in its network namespace until the pod is
// deleted, and this controller lists no pods: keeping a claim alive until an
// attachment goes is the job of whatever deletes that pod, and a duplicate that
// slips through anyway is what the audit sweep reports.
//
// It is only set on claims that ask for a NAD (spec.nad). An address-only claim
// mints nothing, so nothing can outlive it and it is released as soon as it is
// deleted.
const NADTeardownFinalizer = "ipam.cubestack.io/nad-teardown"

// IPClaimReconciler reconciles an IPClaim: it assigns an address from the
// referenced pool, and mints the claim's NetworkAttachmentDefinition from the
// pool's template when the claim asks for one.
//
// # Why this reconciler mints the NAD
//
// The NAD carries the assigned address, so the address and
// the NAD are one fact. Splitting them across two controllers would give that fact
// two writers that can disagree; keeping both here makes disagreement structurally
// impossible rather than merely unlikely. It also keeps a claim usable on its own:
// a hand-written IPClaim with no environment behind it still gets its NAD.
type IPClaimReconciler struct {
	client.Client

	// APIReader reads directly from the API server, bypassing the manager's cache.
	//
	// It is not an optimisation, it is the allocator's correctness argument: two
	// claims reconciled back to back must not both be handed a snapshot taken before
	// either wrote its assignment (design §10.4). Reading the claim set through the
	// cache would do exactly that, because the cache converges asynchronously.
	APIReader client.Reader

	// NADKindMissing is set by SetupWithManager when the cluster does not serve the
	// NAD kind — Multus is not installed. Address-only claims work either way; a
	// claim naming a NAD is then failed with MultusMissing instead of retrying a read
	// and a create against a kind nothing can serve. False, the zero value, means the
	// kind is there: the probe can only ever subtract from what the reconciler does.
	NADKindMissing bool

	Scheme *runtime.Scheme
}

// Note the absent verbs. The claim controller never creates or deletes an
// IPClaim — that is a user's action, or the environment controller's. It patches
// the claim only to carry the teardown finalizer, and it deletes a NAD only as
// part of that teardown: see NADTeardownFinalizer for why the garbage collector
// cannot do that half.
//
// +kubebuilder:rbac:groups=ipam.cubestack.io,resources=ipclaims,verbs=get;list;watch;patch
// +kubebuilder:rbac:groups=ipam.cubestack.io,resources=ipclaims/status,verbs=get;patch;update
// +kubebuilder:rbac:groups=ipam.cubestack.io,resources=ippools,verbs=get;list;watch
// +kubebuilder:rbac:groups=k8s.cni.cncf.io,resources=network-attachment-definitions,verbs=get;list;watch;create;update;delete

// Reconcile assigns an address and mints a NAD.
//
// The sequence is deliberate: the address is published first, then the NAD is
// created, and only then is the claim marked Ready. Publishing the address first
// closes the window in which an address exists only in memory — holders reads
// status.assignedIP, so an address that is chosen but not yet written is free for
// the next claim to take. Creating the NAD before marking Ready means Ready implies
// the network exists; the reverse order would advertise a claim as satisfied during
// the window in which its VM is still stuck in FailedCreatePodSandBox.
//
// Every failure path writes a condition and returns without requeueing. Nothing
// here is time-dependent — the fix for each of them is an admin or user editing an
// object, and both objects are watched.
func (r *IPClaimReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	claim := &ipamv1alpha1.IPClaim{}
	// Read through APIReader, like holders: the address this claim already holds is
	// what decides whether it is allocated for again, and a cached copy that has not
	// caught up with this claim's own last write would read as unbound and be given a
	// second address.
	if err := r.APIReader.Get(ctx, req.NamespacedName, claim); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// A deleting claim is not allocated for: re-binding here would write an address
	// onto an object on its way out, and mint a NAD that is about to be collected.
	// Its teardown is the one thing left to do — see NADTeardownFinalizer.
	if !claim.DeletionTimestamp.IsZero() {
		return r.finalize(ctx, claim)
	}

	original := claim.DeepCopy()

	// A cluster without Multus cannot serve the kind a minted NAD would be, and no
	// amount of retrying changes that. Reported as a condition — the fix is the
	// administrator installing Multus — and checked before the finalizer, which would
	// otherwise be held for a NAD that is never created. Address-only claims are
	// unaffected: nothing but spec.nad needs the kind.
	if claim.Spec.NAD != "" && r.NADKindMissing {
		return r.fail(ctx, original, claim, ipamv1alpha1.ReasonMultusMissing,
			fmt.Sprintf("spec.nad is set but the cluster does not serve %s, so NAD %s cannot be minted (Multus is not installed)",
				networkAttachmentDefinitionGVK.GroupKind(), claim.Spec.NAD), nil)
	}

	// Taken before anything is minted, so a claim deleted at any point after its NAD
	// exists still keeps its address in the ledger until that NAD is gone.
	if claim.Spec.NAD != "" {
		if err := r.ensureFinalizer(ctx, claim); err != nil {
			return ctrl.Result{}, err
		}
		original = claim.DeepCopy()
	}

	// Read directly too, and for the namespace gate below: a cached pool that has not
	// caught up with a namespace being taken off the allow-list would still admit a
	// claim that the administrator has just shut out, and the admission is not
	// revisited once the address is bound.
	pool := &ipamv1alpha1.IPPool{}
	switch err := r.APIReader.Get(ctx, client.ObjectKey{Name: claim.Spec.PoolRef}, pool); {
	case apierrors.IsNotFound(err):
		return r.fail(ctx, original, claim, ipamv1alpha1.ReasonPoolNotFound,
			fmt.Sprintf("IPPool %q does not exist", claim.Spec.PoolRef), nil)
	case err != nil:
		return ctrl.Result{}, fmt.Errorf("reading IPPool %s: %w", claim.Spec.PoolRef, err)
	}

	// A pool that failed its own validation cannot be allocated from. Checking it
	// again here rather than trusting status.conditions keeps this reconciler
	// correct when the two run concurrently, and the check is a pure function.
	if err := ipamutil.ValidatePoolRange(pool.Spec); err != nil && poolUnusable(claim, err) {
		// A fully excluded pool is well formed and merely empty; it is reported as an
		// exhausted one so the caller reads the same thing here as it would from the
		// allocator that ran out of addresses.
		reason := ipamv1alpha1.ReasonRangeInvalid
		if errors.Is(err, ipamutil.ErrRangeFullyExcluded) {
			reason = ipamv1alpha1.ReasonRangeExhausted
		}
		return r.fail(ctx, original, claim, reason,
			fmt.Sprintf("IPPool %q is not usable: %s", pool.Name, err), nil)
	}

	// The namespace gate is prospective: it decides who may allocate, not who may
	// keep what they already have. A claim that holds an address keeps it when its
	// namespace is removed from the list, because the NAD on the running VM still
	// carries it.
	if strings.TrimSpace(claim.Status.AssignedIP) == "" && !admitsNamespace(pool, claim.Namespace) {
		return r.fail(ctx, original, claim, ipamv1alpha1.ReasonNamespaceNotAllowed,
			fmt.Sprintf("IPPool %q does not admit namespace %q", pool.Name, claim.Namespace), nil)
	}

	// Captured before assign: it decides whether a failure below may give the address
	// back. A claim that arrived holding an address published it in a NAD already, so
	// only an address picked by this reconcile can be handed back by it.
	wasBound := strings.TrimSpace(claim.Status.AssignedIP) != ""

	addr, err := r.assign(ctx, claim, pool)
	if err != nil {
		if alloc, ok := errors.AsType[*allocError](err); ok {
			return r.fail(ctx, original, claim, alloc.reason, alloc.message, alloc.blockers)
		}
		return ctrl.Result{}, err
	}

	message := fmt.Sprintf("address %s assigned from pool %s", addr, pool.Name)

	if claim.Spec.NAD != "" {
		if pool.Spec.NADTemplate == nil {
			// Named as its own reason rather than left to a generic failure: asking for a
			// NAD against a template-less pool is a misconfiguration the user can fix,
			// and without naming it the claim would look like a broken controller.
			return r.fail(ctx, original, claim, ipamv1alpha1.ReasonTemplateMissing,
				fmt.Sprintf("spec.nad is set but pool %s carries no nadTemplate, so NAD %s cannot be minted",
					pool.Name, claim.Spec.NAD), nil)
		}

		// Checked before the address is reserved, not only when the NAD is created. A
		// name that stays taken would otherwise cost a reservation write and a write
		// clearing it on every reconcile, and each of those re-enqueues this claim: a
		// loop of the controller's own making that no outside change ends. ensureNAD
		// repeats the check, which is what catches a name taken after this read.
		conflict, err := nadNameHeld(ctx, r.Client, claim)
		if err != nil {
			return ctrl.Result{}, err
		}
		if conflict != "" {
			// No reservation was written, so none has to be given back. The NAD watch
			// re-enqueues this claim when the name falls free.
			return r.failNADNotOwned(ctx, original, claim, conflict)
		}

		if err := r.reserve(ctx, original, claim, addr, pool.Name); err != nil {
			return ctrl.Result{}, fmt.Errorf("reserving address %s for claim %s/%s: %w", addr, claim.Namespace, claim.Name, err)
		}
		// The patch above moved the object on; the patches below are diffed against
		// this snapshot and carry its resourceVersion as their precondition.
		original = claim.DeepCopy()

		if err := ensureNAD(ctx, r.Client, claim, pool, addr); err != nil {
			if errors.Is(err, errNADNotOwned) {
				if !wasBound {
					// Nothing carries this address: the claim never came to own a NAD, so
					// the reservation goes back to the pool rather than being held by a name
					// collision. A claim that was already bound keeps its address here — its
					// NAD may exist and a running VM may still be on it.
					claim.Status.AssignedIP = ""
				}
				return r.failNADNotOwned(ctx, original, claim, err.Error())
			}
			if errors.Is(err, errNADTerminating) {
				// The address is kept: its NAD is still on the cluster and may still serve
				// a running VM. Ready is False all the same — the network the claim is
				// about to be handed is on its way out — and the NAD watch re-enqueues this
				// claim once the object is gone and a replacement can be minted.
				apimeta.SetStatusCondition(&claim.Status.Conditions, metav1.Condition{
					Type:               ipamv1alpha1.ConditionReady,
					Status:             metav1.ConditionFalse,
					Reason:             ipamv1alpha1.ReasonReserved,
					Message:            fmt.Sprintf("address %s is held; NAD %s is terminating and is minted again once it is gone", addr, claim.Spec.NAD),
					ObservedGeneration: claim.Generation,
				})
				return ctrl.Result{}, patchStatusIfChanged(ctx, r.Client, original, claim, original.Status, claim.Status)
			}
			return ctrl.Result{}, fmt.Errorf("ensuring NAD %s/%s: %w", claim.Namespace, claim.Spec.NAD, err)
		}
		message += fmt.Sprintf("; NAD %s ready", claim.Spec.NAD)
	}

	return ctrl.Result{}, r.bind(ctx, original, claim, addr, message)
}

// allocError is a failure that is the user's or admin's to fix rather than a
// transient error, so Reconcile turns it into a condition instead of a retry.
type allocError struct {
	reason   string
	message  string
	blockers []ipamv1alpha1.Blocker
}

func (e *allocError) Error() string { return e.message }

// assign returns the address this claim holds, allocating one if it holds none.
//
// An address already in status is reused rather than re-derived. That is the
// single most important line in this file: re-running the allocator on every
// reconcile would let a newly created claim with a lower address displace a
// running VM, and an address that moves under a live guest is precisely the
// instability this project exists to remove.
func (r *IPClaimReconciler) assign(ctx context.Context, claim *ipamv1alpha1.IPClaim, pool *ipamv1alpha1.IPPool) (netip.Addr, error) {
	addrs, err := ipamutil.ParseRange(pool.Spec.Range.Start, pool.Spec.Range.End)
	if err != nil {
		return netip.Addr{}, &allocError{reason: ipamv1alpha1.ReasonRangeInvalid, message: err.Error()}
	}

	if held := strings.TrimSpace(claim.Status.AssignedIP); held != "" {
		addr, err := netip.ParseAddr(held)
		if err != nil {
			return netip.Addr{}, &allocError{
				reason:  ipamv1alpha1.ReasonRangeInvalid,
				message: fmt.Sprintf("status.assignedIP %q is not a valid address; delete this IPClaim to release it", held),
			}
		}
		// Kept, not silently moved, when the pool's band no longer covers it: the NAD
		// on the running VM still carries this address, and an address that moves
		// under a live guest is worse than one that has drifted out of band. The
		// claim reports the drift and leaves the decision with the admin. The same
		// holds for an address that a later exclude band covers — exclusions are
		// prospective (design §10.5).
		if !slices.Contains(addrs, addr) {
			return netip.Addr{}, &allocError{
				reason: ipamv1alpha1.ReasonRangeInvalid,
				message: fmt.Sprintf("assigned address %s is no longer within pool %s's range %s-%s; "+
					"the address is retained because the NAD still carries it", addr, pool.Name, pool.Spec.Range.Start, pool.Spec.Range.End),
			}
		}
		return addr, nil
	}

	excluded, err := excludedAddrs(pool.Spec.Exclude)
	if err != nil {
		return netip.Addr{}, &allocError{reason: ipamv1alpha1.ReasonRangeInvalid, message: err.Error()}
	}

	held, err := r.holders(ctx, claim)
	if err != nil {
		return netip.Addr{}, err
	}

	if exact, ok := exactAddress(claim.Spec.Allocation); ok {
		return exactAssign(pool, exact, excluded, held)
	}
	if claim.Spec.Allocation != nil && claim.Spec.Allocation.Strategy != "" &&
		claim.Spec.Allocation.Strategy != ipamv1alpha1.AllocationAuto {
		return netip.Addr{}, &allocError{
			reason:  ipamv1alpha1.ReasonAllocationInvalid,
			message: fmt.Sprintf("spec.allocation.strategy %q is not Auto or Exact", claim.Spec.Allocation.Strategy),
		}
	}

	taken := make(map[netip.Addr]struct{}, len(held)+len(excluded))
	for a := range held {
		taken[a] = struct{}{}
	}
	for a := range excluded {
		taken[a] = struct{}{}
	}
	addr, ok := ipamutil.FirstFree(addrs, taken)
	if !ok {
		return netip.Addr{}, &allocError{
			reason: ipamv1alpha1.ReasonRangeExhausted,
			message: fmt.Sprintf("no free address left in pool %s (%s-%s): all %d addresses are claimed or excluded",
				pool.Name, pool.Spec.Range.Start, pool.Spec.Range.End, len(addrs)),
		}
	}
	return addr, nil
}

// exactAddress returns the address an Exact request names.
//
// A strategy of Exact with no address is reported by exactAssign's caller as
// AllocInvalid rather than silently falling back to Auto: an Exact request that
// quietly became an automatic one would hand out an address the caller never
// asked for.
func exactAddress(allocation *ipamv1alpha1.AddressAllocation) (string, bool) {
	if allocation == nil || allocation.Strategy != ipamv1alpha1.AllocationExact {
		return "", false
	}
	return allocation.Address, true
}

// exactAssign honours an Exact request or explains why it cannot.
//
// It never falls back to a nearby address. A one-digit typo has to fail: landing
// on a plausible-looking neighbour is how a guest ends up on a subnet it was not
// meant to be on, which is harder to diagnose than a refusal.
func exactAssign(
	pool *ipamv1alpha1.IPPool,
	exact string,
	excluded map[netip.Addr]struct{},
	held map[netip.Addr][]types.NamespacedName,
) (netip.Addr, error) {
	if pool.Spec.AllowExact != nil && !*pool.Spec.AllowExact {
		return netip.Addr{}, &allocError{
			reason:  ipamv1alpha1.ReasonExactNotAllowed,
			message: fmt.Sprintf("IPPool %q does not accept exact requests (spec.allowExact is false)", pool.Name),
		}
	}
	if strings.TrimSpace(exact) == "" {
		return netip.Addr{}, &allocError{
			reason:  ipamv1alpha1.ReasonAllocationInvalid,
			message: "spec.allocation.strategy is Exact but no address was given",
		}
	}
	addr, err := netip.ParseAddr(exact)
	if err != nil {
		return netip.Addr{}, &allocError{
			reason:  ipamv1alpha1.ReasonAllocationInvalid,
			message: fmt.Sprintf("spec.allocation.address %q is not a valid address: %s", exact, err),
		}
	}

	start, err := netip.ParseAddr(pool.Spec.Range.Start)
	if err != nil {
		return netip.Addr{}, &allocError{reason: ipamv1alpha1.ReasonRangeInvalid, message: err.Error()}
	}
	end, err := netip.ParseAddr(pool.Spec.Range.End)
	if err != nil {
		return netip.Addr{}, &allocError{reason: ipamv1alpha1.ReasonRangeInvalid, message: err.Error()}
	}
	if addr.Compare(start) < 0 || addr.Compare(end) > 0 {
		return netip.Addr{}, &allocError{
			reason:  ipamv1alpha1.ReasonAddressOutOfRange,
			message: fmt.Sprintf("requested address %s is outside pool %s's range %s-%s", addr, pool.Name, pool.Spec.Range.Start, pool.Spec.Range.End),
		}
	}
	if _, isExcluded := excluded[addr]; isExcluded {
		return netip.Addr{}, &allocError{
			reason:  ipamv1alpha1.ReasonAddressExcluded,
			message: fmt.Sprintf("requested address %s is excluded from pool %s", addr, pool.Name),
		}
	}
	if holders := held[addr]; len(holders) > 0 {
		blockers := make([]ipamv1alpha1.Blocker, 0, len(holders))
		for _, h := range holders {
			blockers = append(blockers, ipamv1alpha1.Blocker{
				Kind:      "IPClaim",
				Namespace: h.Namespace,
				Name:      h.Name,
				Address:   addr.String(),
			})
		}
		return netip.Addr{}, &allocError{
			reason:   ipamv1alpha1.ReasonAddressUnavailable,
			message:  fmt.Sprintf("requested address %s is already held in pool %s", addr, pool.Name),
			blockers: blockers,
		}
	}
	return addr, nil
}

// holders collects every address held by claims against the same pool, across all
// namespaces — the pool is cluster-scoped, so the ledger is too — along with who
// holds it.
//
// This reads IPClaims rather than a pool-owned ledger, because the claim set is
// the only authoritative record (design §10.4). A second list on the pool would be
// a second thing to keep in step, and the two would eventually disagree.
//
// Read through APIReader, directly from the API server. That closes the window in
// which two claims reconciled back to back both see a snapshot from before either
// wrote its assignment: with MaxConcurrentReconciles at 1 and a direct read, the
// second claim's listing includes the first's write. It is not airtight — a
// concurrent write from outside this process could still interleave — which is why
// the audit's DuplicateAddress exists rather than an assumption that this cannot
// happen.
func (r *IPClaimReconciler) holders(ctx context.Context, claim *ipamv1alpha1.IPClaim) (map[netip.Addr][]types.NamespacedName, error) {
	var claims ipamv1alpha1.IPClaimList
	if err := r.APIReader.List(ctx, &claims); err != nil {
		return nil, fmt.Errorf("listing IPClaims: %w", err)
	}

	held := map[netip.Addr][]types.NamespacedName{}
	for i := range claims.Items {
		other := &claims.Items[i]
		// Compared by UID rather than name: the claim in hand may not have one yet.
		if other.Spec.PoolRef != claim.Spec.PoolRef || other.UID == claim.UID {
			continue
		}
		addr, err := netip.ParseAddr(strings.TrimSpace(other.Status.AssignedIP))
		if err != nil {
			// Pending and failed claims hold nothing, and one claim's malformed status
			// must not block every other claim in the pool; it is that claim's own
			// condition, and the audit's, to report.
			continue
		}
		held[addr] = append(held[addr], types.NamespacedName{Namespace: other.Namespace, Name: other.Name})
	}
	return held, nil
}

// excludedAddrs turns a validated pool's exclusion list into a set.
func excludedAddrs(bands []ipamv1alpha1.IPRange) (map[netip.Addr]struct{}, error) {
	if len(bands) == 0 {
		return nil, nil
	}
	out := make(map[netip.Addr]struct{})
	for _, band := range bands {
		addrs, err := ipamutil.ParseRange(band.Start, band.End)
		if err != nil {
			return nil, fmt.Errorf("exclude %s-%s: %w", band.Start, band.End, err)
		}
		for _, a := range addrs {
			out[a] = struct{}{}
		}
	}
	return out, nil
}

// admitsNamespace reports whether a pool's allow-list covers namespace.
//
// An empty list admits nobody. The policy is default-deny on purpose: a pool is an
// address band reserved by a network administrator, and a pool that admitted every
// namespace by omission would quietly become the cluster-wide one.
func admitsNamespace(pool *ipamv1alpha1.IPPool, namespace string) bool {
	return slices.Contains(pool.Spec.Namespaces, namespace)
}

// poolUnusable reports whether a validation error stops this claim.
//
// A malformed pool refuses everyone. A fully excluded one is well formed and
// merely empty, and emptiness only refuses NEW allocations: a claim that already
// holds an address keeps it, because assign keeps any address inside the band and
// the NAD on the running VM still carries it. That is the same prospective reading
// the namespace gate and the exclusion list get.
func poolUnusable(claim *ipamv1alpha1.IPClaim, err error) bool {
	if !errors.Is(err, ipamutil.ErrRangeFullyExcluded) {
		return true
	}
	return strings.TrimSpace(claim.Status.AssignedIP) == ""
}

// failNADNotOwned reports a NAD name held by an object this claim does not control.
//
// The object is never adopted and never overwritten: a name collision means two
// claims believe they own one network, and taking it over would give the loser a VM
// with no network and no explanation. The NAD watch re-enqueues the claim when the
// name falls free, so the failure needs no retry loop of its own.
func (r *IPClaimReconciler) failNADNotOwned(ctx context.Context, original, claim *ipamv1alpha1.IPClaim, message string) (ctrl.Result, error) {
	return r.fail(ctx, original, claim, ipamv1alpha1.ReasonNADNotOwned, message,
		[]ipamv1alpha1.Blocker{{
			Kind:      networkAttachmentDefinitionGVK.Kind,
			Namespace: claim.Namespace,
			Name:      claim.Spec.NAD,
		}})
}

// ensureFinalizer puts NADTeardownFinalizer on a claim that asks for a NAD.
func (r *IPClaimReconciler) ensureFinalizer(ctx context.Context, claim *ipamv1alpha1.IPClaim) error {
	if controllerutil.ContainsFinalizer(claim, NADTeardownFinalizer) {
		return nil
	}

	original := claim.DeepCopy()
	controllerutil.AddFinalizer(claim, NADTeardownFinalizer)
	if err := r.Patch(ctx, claim, client.MergeFromWithOptions(original, client.MergeFromWithOptimisticLock{})); err != nil {
		return fmt.Errorf("adding finalizer to claim %s/%s: %w", claim.Namespace, claim.Name, err)
	}
	return nil
}

// finalize removes a claim's NAD and then lets the claim go.
//
// The NAD is deleted here rather than left to the garbage collector because
// background cascade deletion never removes a dependent while its owner still
// exists — and with the finalizer the owner exists until this removal completes, so
// waiting for the collector would deadlock the claim. The claim is released only
// once the NAD has actually left the API server: a delete request alone proves
// nothing about an object that carries finalizers of its own.
//
// Only an object this claim controls is deleted: a foreign NAD that happens to hold
// the name is not ours to remove, and the claim never took an address on its
// account.
func (r *IPClaimReconciler) finalize(ctx context.Context, claim *ipamv1alpha1.IPClaim) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(claim, NADTeardownFinalizer) {
		return ctrl.Result{}, nil
	}

	if claim.Spec.NAD != "" {
		// Read directly: the NAD this claim minted may be younger than the cache.
		nad := newNAD(claim.Namespace, claim.Spec.NAD)
		switch err := r.APIReader.Get(ctx, client.ObjectKeyFromObject(nad), nad); {
		case apierrors.IsNotFound(err):
		case err != nil:
			return ctrl.Result{}, fmt.Errorf("reading NAD %s/%s: %w", claim.Namespace, claim.Spec.NAD, err)
		case metav1.IsControlledBy(nad, claim):
			// The delete names the object this read proved is ours, by identity rather
			// than by name: a NAD someone else created in the meantime has a different
			// UID and fails the precondition instead of being deleted.
			uid, rv := nad.GetUID(), nad.GetResourceVersion()
			pre := client.Preconditions{UID: &uid, ResourceVersion: &rv}
			if err := r.Delete(ctx, nad, pre); client.IgnoreNotFound(err) != nil {
				return ctrl.Result{}, fmt.Errorf("deleting NAD %s/%s: %w", claim.Namespace, claim.Spec.NAD, err)
			}
			// A delete request only records the deletion. A NAD with a finalizer of its
			// own stays — readable, and still publishing the address — until something
			// removes that finalizer, so the claim waits for the object itself to go.
			// The NAD watch brings this claim back when it does.
			gone, err := r.nadGone(ctx, claim.Namespace, claim.Spec.NAD)
			if err != nil {
				return ctrl.Result{}, err
			}
			if !gone {
				return ctrl.Result{}, nil
			}
		}
	}

	original := claim.DeepCopy()
	controllerutil.RemoveFinalizer(claim, NADTeardownFinalizer)
	if err := r.Patch(ctx, claim, client.MergeFromWithOptions(original, client.MergeFromWithOptimisticLock{})); err != nil {
		return ctrl.Result{}, fmt.Errorf("removing finalizer from claim %s/%s: %w", claim.Namespace, claim.Name, err)
	}
	return ctrl.Result{}, nil
}

// nadGone reports whether the named NAD has actually left the API server. A delete
// that returned without error only proves the deletion was recorded: an object
// carrying finalizers of its own stays readable, deletionTimestamp and all, and
// until it goes the static address in its config is still what a pod on that
// network would be given.
func (r *IPClaimReconciler) nadGone(ctx context.Context, namespace, name string) (bool, error) {
	nad := newNAD(namespace, name)
	switch err := r.APIReader.Get(ctx, client.ObjectKeyFromObject(nad), nad); {
	case apierrors.IsNotFound(err):
		return true, nil
	case err != nil:
		return false, fmt.Errorf("reading NAD %s/%s after deleting it: %w", namespace, name, err)
	}
	return false, nil
}

// fail records a claim that could not be satisfied.
//
// status.assignedIP is left untouched. A claim that was bound and later broke —
// its pool deleted, its template withdrawn — still holds its address, and the NAD
// it owns still carries it. Clearing the field would hand that address to someone
// else while the VM on it is still running.
func (r *IPClaimReconciler) fail(
	ctx context.Context, original, claim *ipamv1alpha1.IPClaim,
	reason, message string, blockers []ipamv1alpha1.Blocker,
) (ctrl.Result, error) {
	claim.Status.Blockers = blockers
	apimeta.SetStatusCondition(&claim.Status.Conditions, metav1.Condition{
		Type:               ipamv1alpha1.ConditionReady,
		Status:             metav1.ConditionFalse,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: claim.Generation,
	})
	return ctrl.Result{}, patchStatusIfChanged(ctx, r.Client, original, claim, original.Status, claim.Status)
}

// reserve publishes an address before the NAD carrying it exists.
//
// holders reads status.assignedIP, so an address that is chosen but not written is
// free as far as the next claim is concerned. If the NAD write then fails, that
// claim takes the same address and mints a second NAD with it — and the first
// claim's retry fails with RangeExhausted while its NAD keeps the address alive.
// Writing the address here makes the hold real at the moment it is chosen.
//
// Ready goes False rather than staying whatever it was last time: the address is
// held, the network it is for is not there yet. bind turns it True once the NAD
// exists. The write is skipped when the address is already published, so a bound
// claim reconciling again does not flicker.
func (r *IPClaimReconciler) reserve(
	ctx context.Context, original, claim *ipamv1alpha1.IPClaim, addr netip.Addr, poolName string,
) error {
	if claim.Status.AssignedIP == addr.String() {
		return nil
	}
	claim.Status.AssignedIP = addr.String()
	apimeta.SetStatusCondition(&claim.Status.Conditions, metav1.Condition{
		Type:               ipamv1alpha1.ConditionReady,
		Status:             metav1.ConditionFalse,
		Reason:             ipamv1alpha1.ReasonReserved,
		Message:            fmt.Sprintf("address %s reserved from pool %s; its NAD is not ready yet", addr, poolName),
		ObservedGeneration: claim.Generation,
	})
	return patchStatusIfChanged(ctx, r.Client, original, claim, original.Status, claim.Status)
}

// bind records a satisfied claim.
func (r *IPClaimReconciler) bind(ctx context.Context, original, claim *ipamv1alpha1.IPClaim, addr netip.Addr, message string) error {
	claim.Status.AssignedIP = addr.String()
	claim.Status.Blockers = nil
	apimeta.SetStatusCondition(&claim.Status.Conditions, metav1.Condition{
		Type:               ipamv1alpha1.ConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             ipamv1alpha1.ReasonBound,
		Message:            message,
		ObservedGeneration: claim.Generation,
	})
	return patchStatusIfChanged(ctx, r.Client, original, claim, original.Status, claim.Status)
}

// claimsForPool maps a pool to the claims that reference it.
//
// This is the useful direction of the pool/claim dependency: fixing a pool — a
// widened band, a template added, a namespace added to the allow-list — is what
// unblocks claims that previously failed. Without it the fix would appear to do
// nothing until each claim was touched by hand.
func (r *IPClaimReconciler) claimsForPool(ctx context.Context, obj client.Object) []reconcile.Request {
	pool, ok := obj.(*ipamv1alpha1.IPPool)
	if !ok {
		return nil
	}

	var claims ipamv1alpha1.IPClaimList
	if err := r.List(ctx, &claims); err != nil {
		// Nothing to do but wait for the next pool event: a map function has nowhere
		// to report an error, and returning nil simply enqueues nothing.
		ctrl.LoggerFrom(ctx).Error(err, "Could not list IPClaims for IPPool", "pool", pool.Name)
		return nil
	}

	var reqs []reconcile.Request
	for i := range claims.Items {
		claim := &claims.Items[i]
		if claim.Spec.PoolRef != pool.Name {
			continue
		}
		reqs = append(reqs, reconcile.Request{NamespacedName: types.NamespacedName{
			Namespace: claim.Namespace,
			Name:      claim.Name,
		}})
	}
	return reqs
}

// claimsForNAD maps a NAD to the claims that asked to mint a NAD of that name.
//
// The lookup is by spec.nad, not by ownerReference, because the case this exists
// for is a NAD the claim does not own: the name was taken, the claim reported
// NADNotOwned, and it has to try again when the squatter finally goes away. That
// object carries no ownerReference to the claim, so an ownership-based mapping
// would never fire. A NAD the claim does own is covered by the same lookup.
func (r *IPClaimReconciler) claimsForNAD(ctx context.Context, obj client.Object) []reconcile.Request {
	var claims ipamv1alpha1.IPClaimList
	if err := r.List(ctx, &claims,
		client.InNamespace(obj.GetNamespace()),
		client.MatchingFields{nadNameField: obj.GetName()},
	); err != nil {
		ctrl.LoggerFrom(ctx).Error(err, "Could not list IPClaims for NAD", "nad", client.ObjectKeyFromObject(obj))
		return nil
	}

	reqs := make([]reconcile.Request, 0, len(claims.Items))
	for i := range claims.Items {
		reqs = append(reqs, reconcile.Request{NamespacedName: types.NamespacedName{
			Namespace: claims.Items[i].Namespace,
			Name:      claims.Items[i].Name,
		}})
	}
	return reqs
}

// pendingClaimsForPool maps a claim that has just given its address back to the
// claims in the same pool that hold none.
//
// The primary watch enqueues only the object that changed, and a release changes
// only the releasing claim. A claim that failed with RangeExhausted would therefore
// stay failed after the holder was deleted, with the address sitting free: no NAD
// and no pool changed, so nothing would wake it. AddressUnavailable — an Exact
// request blocked by a holder — is woken by the same event.
//
// Only unbound claims are enqueued. A bound claim is not waiting for anything, and
// reconciling it would be work that changes nothing.
func (r *IPClaimReconciler) pendingClaimsForPool(ctx context.Context, obj client.Object) []reconcile.Request {
	releasing, ok := obj.(*ipamv1alpha1.IPClaim)
	if !ok {
		return nil
	}

	var claims ipamv1alpha1.IPClaimList
	if err := r.List(ctx, &claims); err != nil {
		ctrl.LoggerFrom(ctx).Error(err, "Could not list IPClaims for IPPool", "pool", releasing.Spec.PoolRef)
		return nil
	}

	var reqs []reconcile.Request
	for i := range claims.Items {
		claim := &claims.Items[i]
		if claim.Spec.PoolRef != releasing.Spec.PoolRef || strings.TrimSpace(claim.Status.AssignedIP) != "" {
			continue
		}
		reqs = append(reqs, reconcile.Request{NamespacedName: types.NamespacedName{
			Namespace: claim.Namespace,
			Name:      claim.Name,
		}})
	}
	return reqs
}

// addressReleased lets through the two events that make a pool address free: a
// claim giving its address back, and a claim holding one being deleted. Anything
// else a claim does — being created, binding, having its condition rewritten — can
// only take an address away, which is no reason to wake the claims left waiting.
func addressReleased() predicate.Funcs {
	return predicate.Funcs{
		CreateFunc:  func(event.CreateEvent) bool { return false },
		GenericFunc: func(event.GenericEvent) bool { return false },
		UpdateFunc: func(e event.UpdateEvent) bool {
			return claimedAddress(e.ObjectOld) != "" && claimedAddress(e.ObjectNew) == ""
		},
		DeleteFunc: func(e event.DeleteEvent) bool { return claimedAddress(e.Object) != "" },
	}
}

func claimedAddress(obj client.Object) string {
	claim, ok := obj.(*ipamv1alpha1.IPClaim)
	if !ok {
		return ""
	}
	return strings.TrimSpace(claim.Status.AssignedIP)
}

// SetupWithManager sets up the controller with the Manager.
//
// MaxConcurrentReconciles is pinned at 1. That is not a default left unset, it is
// half of the exclusivity argument: address allocation is a read-modify-write over
// the claim set, and running two of them at once is the race the direct read
// through APIReader also exists to shrink (design §10.4). The other half is leader
// election, so that a second replica does not do it from another process.
func (r *IPClaimReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if r.APIReader == nil {
		// Failing here rather than falling back to the cache: a silent fallback would
		// leave the allocator reading stale snapshots while looking correct, which is
		// the exact defect APIReader is here to prevent.
		return errors.New("IPClaimReconciler.APIReader must be set: allocation reads the claim set directly from the API server")
	}

	if err := mgr.GetFieldIndexer().IndexField(context.Background(), &ipamv1alpha1.IPClaim{}, nadNameField,
		func(o client.Object) []string {
			claim, ok := o.(*ipamv1alpha1.IPClaim)
			if !ok || claim.Spec.NAD == "" {
				return nil
			}
			return []string{claim.Spec.NAD}
		}); err != nil {
		return fmt.Errorf("indexing IPClaims by %s: %w", nadNameField, err)
	}

	// The NAD kind is Multus's, not this project's, so it is probed before it is
	// watched: a watch on a kind the server does not serve fails the manager at
	// startup, which would take every controller in the binary down with it — the
	// address-only half of IPAM works on a cluster with no Multus at all. Absent, the
	// watch is skipped and a claim that asks for a NAD is failed with MultusMissing;
	// any other probe failure fails setup rather than silently dropping the watch for
	// the manager's lifetime.
	served, err := crdServed(mgr, networkAttachmentDefinitionGVK)
	if err != nil {
		return fmt.Errorf("probing whether the %s kind is served: %w", networkAttachmentDefinitionGVK.Kind, err)
	}
	r.NADKindMissing = !served

	watches := ctrl.NewControllerManagedBy(mgr).
		For(&ipamv1alpha1.IPClaim{}).
		// A claim that gives an address back wakes the claims waiting on that pool, so
		// a RangeExhausted or AddressUnavailable claim does not need a retry loop to
		// notice the address it wanted is free.
		Watches(&ipamv1alpha1.IPClaim{},
			handler.EnqueueRequestsFromMapFunc(r.pendingClaimsForPool),
			builder.WithPredicates(addressReleased())).
		Watches(&ipamv1alpha1.IPPool{}, handler.EnqueueRequestsFromMapFunc(r.claimsForPool))
	if served {
		// A deleted or hand-edited NAD comes back, and a NAD whose name the claim was
		// refused re-triggers it when it goes. Deleting a NAD does not disturb a
		// running VM immediately — no CNI DEL is issued until the pod goes — which is
		// why the drift has to be corrected here rather than noticed later (design R4).
		watches = watches.Watches(newNAD("", ""), handler.EnqueueRequestsFromMapFunc(r.claimsForNAD))
	}

	return watches.
		WithOptions(controller.Options{MaxConcurrentReconciles: 1}).
		Named("ipclaim").
		Complete(r)
}

// crdServed reports whether the cluster serves the given kind, so a watch is only
// registered for kinds the server actually has.
//
// Only "no such kind" means absent. Every other discovery failure is returned: the
// probe runs once, at startup, and a watch skipped here is skipped for the manager's
// lifetime.
func crdServed(mgr ctrl.Manager, gvk schema.GroupVersionKind) (bool, error) {
	_, err := mgr.GetRESTMapper().RESTMapping(gvk.GroupKind(), gvk.Version)
	if err == nil {
		return true, nil
	}
	if apimeta.IsNoMatchError(err) {
		return false, nil
	}
	return false, err
}
