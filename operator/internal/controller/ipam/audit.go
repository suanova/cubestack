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
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strings"
	"time"

	"github.com/go-logr/logr"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/events"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/manager"

	ipamv1alpha1 "github.com/suanova/cubestack/api/ipam/v1alpha1"
	ipamutil "github.com/suanova/cubestack/internal/ipam"
)

// DefaultAuditInterval is how often the auditor sweeps a cluster with no
// configured interval.
//
// Minutes, not seconds: every check here reports a state that only a human
// changes, and the sweep lists whole kinds. Running it on the reconcile
// timescale would be work with nothing to find.
const DefaultAuditInterval = 10 * time.Minute

// conditionWriteAttempts bounds the retries when a status patch loses a race.
const conditionWriteAttempts = 5

// Finding is one inconsistency the auditor noticed.
type Finding struct {
	// GVK, Namespace, Name and UID identify the object the finding is attached to,
	// so it can be reported as an event on the thing itself rather than only in a
	// log nobody reads. The UID is what makes that work: kubectl describe selects
	// events by the live object's UID, so an event filed against a reference
	// without one never appears on the object it is about.
	GVK       schema.GroupVersionKind
	Namespace string
	Name      string
	UID       types.UID
	// Reason is the event reason, in CamelCase, matching the convention of the
	// conditions the reconcilers write.
	Reason string
	// Message explains the inconsistency and, where it is obvious, what to do.
	Message string
}

// ref builds the object an event about this finding is recorded against. It is
// deliberately a stub — only the reference, which includes the UID, matters to the
// event recorder.
func (f Finding) ref() *unstructured.Unstructured {
	obj := &unstructured.Unstructured{}
	obj.SetGroupVersionKind(f.GVK)
	obj.SetNamespace(f.Namespace)
	obj.SetName(f.Name)
	obj.SetUID(f.UID)
	return obj
}

// Findings are reported as events on the objects they concern, which is the only
// way an admin sees one without reading this process's log.
//
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=ipam.cubestack.io,resources=ipclaims,verbs=get;list;watch
// +kubebuilder:rbac:groups=ipam.cubestack.io,resources=ipclaims/status,verbs=get;patch;update
// +kubebuilder:rbac:groups=ipam.cubestack.io,resources=ippools,verbs=get;list;watch
// +kubebuilder:rbac:groups=ipam.cubestack.io,resources=ippools/status,verbs=get;patch;update
// +kubebuilder:rbac:groups=k8s.cni.cncf.io,resources=network-attachment-definitions,verbs=get;list;watch

// Auditor is a manager.Runnable that periodically checks the invariants no single
// reconcile can observe from the object it is working on.
//
// This is the part that must not be skipped. Every reconciler here sees one object
// and its direct dependencies, so an inconsistency that is spread across two
// objects — or whose owning object is gone — is invisible to all of them. The
// sweep is the only thing that reads the whole picture, and with static addressing
// nothing in the CNI stands behind it: a duplicate address is not a loud failure at
// pod start, it is intermittent connectivity nobody attributes to an address.
//
// It therefore reports twice, and the second time is the one that matters. Every
// finding becomes an event, which is how an admin sees it now; DuplicateAddress
// additionally becomes a persistent condition on every object implicated. Events
// expire after an hour, and the symptom they describe does not.
//
// Writing status does make the auditor a second writer on objects a reconciler also
// writes. That is bounded by using a condition type of its own — DuplicateAddress,
// which no reconciler touches — and by patching with an optimistic lock so that a
// losing write retries against the winner's version instead of overwriting the
// Ready or Available condition that changed underneath it.
type Auditor struct {
	Client   client.Client
	Recorder events.EventRecorder
	// Interval is the time between sweeps. Zero means DefaultAuditInterval.
	Interval time.Duration
}

// Compile-time check that the auditor can be handed to mgr.Add.
var _ manager.Runnable = (*Auditor)(nil)

// NeedLeaderElection keeps the sweep to a single replica. Findings are advisory,
// so duplicated events would be noise rather than a correctness problem — but it
// is noise on the objects users are looking at, and this is now also a status
// writer.
func (a *Auditor) NeedLeaderElection() bool { return true }

// Start runs the sweep loop until the context is cancelled.
func (a *Auditor) Start(ctx context.Context) error {
	interval := a.Interval
	if interval <= 0 {
		interval = DefaultAuditInterval
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		// The first sweep runs immediately: starting the process is exactly when a
		// stale or half-migrated cluster is worth looking at.
		findings, err := a.RunOnce(ctx)
		if err != nil {
			a.log().Error(err, "audit sweep failed")
		}
		for _, f := range findings {
			a.log().Info("audit finding", "reason", f.Reason, "namespace", f.Namespace, "name", f.Name, "message", f.Message)
			recordEvent(a.Recorder, f.ref(), corev1.EventTypeWarning, f.Reason, "Audit", f.Message)
		}

		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

// log returns the auditor's logger. logf.Log is the logger the binary installs,
// which is what a component wired from main should use; the manager's own
// context carries no logger for a Runnable.
func (a *Auditor) log() logr.Logger { return logf.Log.WithName("audit") }

// RunOnce runs every check, applies the resulting DuplicateAddress conditions, and
// returns what it found. Exported so it can be tested without running the loop.
func (a *Auditor) RunOnce(ctx context.Context) ([]Finding, error) {
	claims, err := a.listClaims(ctx)
	if err != nil {
		return nil, err
	}
	pools, err := a.listPools(ctx)
	if err != nil {
		return nil, err
	}
	nads, err := a.listClaimNADs(ctx)
	if err != nil {
		return nil, err
	}

	findings := a.collect(claims, pools, nads)

	if err := a.applyConditions(ctx, claims, pools, findings); err != nil {
		return findings, err
	}
	return findings, nil
}

// collect runs the checks over one snapshot and returns what they found.
//
// Every check reads the same three lists. They ask different questions of one
// picture — which pools exist, how each NAD is addressed, which claims hold what —
// and listing twice would only invite the answers to disagree.
func (a *Auditor) collect(claims []ipamv1alpha1.IPClaim, pools map[string]ipamv1alpha1.IPPool, nads []unstructured.Unstructured) []Finding {
	findings := a.orphanedNADs(claims, nads)
	findings = append(findings, a.duplicateAddresses(claims, pools, nads)...)
	findings = append(findings, a.overlappingPools(pools)...)
	findings = append(findings, a.danglingPoolRefs(claims, pools)...)
	return findings
}

// listPools returns every IPPool by name. The name is what a claim's poolRef holds,
// so a claim can be matched to its pool without a second lookup.
func (a *Auditor) listPools(ctx context.Context) (map[string]ipamv1alpha1.IPPool, error) {
	var pools ipamv1alpha1.IPPoolList
	if err := a.Client.List(ctx, &pools); err != nil {
		return nil, fmt.Errorf("listing IPPools: %w", err)
	}
	out := make(map[string]ipamv1alpha1.IPPool, len(pools.Items))
	for i := range pools.Items {
		out[pools.Items[i].Name] = pools.Items[i]
	}
	return out, nil
}

func (a *Auditor) listClaims(ctx context.Context) ([]ipamv1alpha1.IPClaim, error) {
	var claims ipamv1alpha1.IPClaimList
	if err := a.Client.List(ctx, &claims); err != nil {
		return nil, fmt.Errorf("listing IPClaims: %w", err)
	}
	return claims.Items, nil
}

// listClaimNADs returns every NAD carrying this project's label — the ones a claim
// minted, whether or not that claim still exists.
func (a *Auditor) listClaimNADs(ctx context.Context) ([]unstructured.Unstructured, error) {
	var nads unstructured.UnstructuredList
	nads.SetGroupVersionKind(networkAttachmentDefinitionGVK.GroupVersion().WithKind("NetworkAttachmentDefinitionList"))
	if err := a.Client.List(ctx, &nads, client.HasLabels{ipamv1alpha1.LabelClaim}); err != nil {
		return nil, fmt.Errorf("listing NetworkAttachmentDefinitions: %w", err)
	}
	return nads.Items, nil
}

// orphanedNADs finds NADs carrying this project's label whose claim is gone.
//
// The direction matters. A NAD is normally collected by the garbage collector
// through its ownerReference, so an orphan means that chain was broken — most
// likely the ownerReference was stripped by hand. The address it carries is no
// longer held by any claim, so the allocator considers it free and can hand it to
// a new claim. If the orphaned NAD's VM is still running, the two now share an
// address and nothing will refuse it.
func (a *Auditor) orphanedNADs(claims []ipamv1alpha1.IPClaim, nads []unstructured.Unstructured) []Finding {
	// Indexed by namespace/label value: the NAD is always created in its claim's
	// namespace, so the label value alone would not be enough to identify it. The
	// value is the claim's name only up to a length — a longer one is truncated and
	// digested — so the set has to hold what the label actually says.
	known := make(map[types.NamespacedName]struct{}, len(claims))
	for i := range claims {
		known[types.NamespacedName{Namespace: claims[i].Namespace, Name: ipamutil.ClaimLabelValue(claims[i].Name)}] = struct{}{}
	}

	var findings []Finding
	for i := range nads {
		nad := &nads[i]
		owner := nad.GetLabels()[ipamv1alpha1.LabelClaim]
		if owner == "" {
			continue
		}
		key := types.NamespacedName{Namespace: nad.GetNamespace(), Name: owner}
		if _, ok := known[key]; ok {
			continue
		}
		findings = append(findings, Finding{
			GVK:       networkAttachmentDefinitionGVK,
			Namespace: nad.GetNamespace(),
			Name:      nad.GetName(),
			UID:       nad.GetUID(),
			Reason:    "OrphanedNAD",
			Message: fmt.Sprintf("owned by IPClaim %s/%s, which no longer exists; "+
				"its address is held by no claim and can be reassigned to another",
				key.Namespace, key.Name),
		})
	}
	return findings
}

// duplicateAddresses finds two claims holding the same address on one L2.
//
// Grouped by the network the address is served on — its subnet together with the
// bridge and VLAN carrying it — not by the pool: the same address on two VLANs is
// legal and routine, and a pool-keyed check would report the one case that is fine
// while missing two pools that happen to serve one subnet with disjoint bands. The
// network is read from the NAD the claim minted, because that is what the CNI will
// actually configure; a pool's template is only a fallback for a claim that mints
// no NAD at all.
//
// This is the only detector. Nothing in the CNI refuses a duplicate: both VMs come
// up on the address and the symptom is intermittent connectivity, so the finding —
// and the condition it is written into — is where the collision is stated at all.
// Naming every holder is what makes it fixable, since neither claim's own Ready
// condition shows anything wrong.
func (a *Auditor) duplicateAddresses(claims []ipamv1alpha1.IPClaim, pools map[string]ipamv1alpha1.IPPool, nads []unstructured.Unstructured) []Finding {
	networks := nadNetworks(nads)

	holders := map[string][]ipamv1alpha1.IPClaim{}
	where := map[string]string{}
	for i := range claims {
		claim := claims[i]
		addr, err := netip.ParseAddr(strings.TrimSpace(claim.Status.AssignedIP))
		if err != nil {
			// No address, or one nothing can be concluded about. The claim's own
			// Ready condition covers it.
			continue
		}
		// The L2 a claim sits on: its NAD's network, else its pool's, else unknown. An
		// unknown network is keyed by pool so two claims on one pool still compare —
		// the conservative direction, since a missed duplicate is worse than a
		// duplicate reported across two VLANs.
		l2, phrase := claimL2(claim, networks, pools)
		where[l2] = phrase
		key := l2 + "\x00" + addr.String()
		holders[key] = append(holders[key], claim)
	}

	var findings []Finding
	for key, group := range holders {
		if len(group) < 2 {
			continue
		}
		l2, addr, _ := strings.Cut(key, "\x00")

		names := make([]string, 0, len(group))
		for _, claim := range group {
			names = append(names, claim.Namespace+"/"+claim.Name)
		}
		slices.Sort(names)

		message := fmt.Sprintf("address %s%s is held by %d claims: %s; "+
			"nothing on the network refuses a duplicate, so these VMs share an address and the symptom is intermittent connectivity, not a failed start",
			addr, where[l2], len(group), strings.Join(names, ", "))

		// Reported on each claim, not once: whichever one a reader is looking at
		// should say what is wrong with it.
		for _, claim := range group {
			findings = append(findings, Finding{
				GVK:       ipamv1alpha1.GroupVersion.WithKind("IPClaim"),
				Namespace: claim.Namespace,
				Name:      claim.Name,
				UID:       claim.UID,
				Reason:    ipamv1alpha1.ReasonDuplicateAddress,
				Message:   message,
			})
		}
	}
	return findings
}

// l2Identity names the layer 2 an address is served on: its subnet together with
// the bridge and VLAN carrying it.
//
// The prefix alone is not the network. NADTemplate lets a pool place its subnet on
// a VLAN-filtered bridge, and the API is explicit that reuse across VLANs is legal
// — two pools may serve 10.66.3.0/24 on br0 with VLAN 100 and VLAN 200, which are
// two isolated segments. Keying a collision check on the prefix alone would report
// exactly that sanctioned shape, on both pools' conditions.
type l2Identity struct {
	Subnet string
	Bridge string
	VLAN   int32
}

// untaggedVLAN stands in for an absent VLAN so that a template and a rendered NAD
// which both omit it compare equal. It is -1 rather than 0 because 0 is a real and
// different value: a priority-tagged interface.
const untaggedVLAN int32 = -1

func (l l2Identity) String() string {
	if l.VLAN == untaggedVLAN {
		return fmt.Sprintf("subnet %s on bridge %s", l.Subnet, l.Bridge)
	}
	return fmt.Sprintf("subnet %s on bridge %s, VLAN %d", l.Subnet, l.Bridge, l.VLAN)
}

// key is the form the duplicate check groups on. Opaque on purpose: only equality
// is asked of it, and the message names the network through String.
func (l l2Identity) key() string {
	return fmt.Sprintf("%s\x00%s\x00%d", l.Subnet, l.Bridge, l.VLAN)
}

// templateL2 reads a pool template's network. It fails when the subnet does not
// parse, which is the only field of the identity the template supplies unparsed.
func templateL2(tmpl *ipamv1alpha1.NADTemplate) (l2Identity, error) {
	subnet, err := maskedSubnet(tmpl.Subnet)
	if err != nil {
		return l2Identity{}, err
	}
	return l2Identity{Subnet: subnet, Bridge: tmpl.Bridge, VLAN: vlanFrom(tmpl.VLAN)}, nil
}

func vlanFrom(v *int32) int32 {
	if v == nil {
		return untaggedVLAN
	}
	return *v
}

// claimL2 resolves the network a claim's address is served on — the NAD it minted,
// else its pool's template, else nothing — and returns both the grouping key and the
// phrase a finding names it by.
func claimL2(claim ipamv1alpha1.IPClaim, networks map[types.NamespacedName]l2Identity, pools map[string]ipamv1alpha1.IPPool) (key, where string) {
	nn := types.NamespacedName{Namespace: claim.Namespace, Name: ipamutil.ClaimLabelValue(claim.Name)}
	l2, known := networks[nn]
	if !known {
		if pool, found := pools[claim.Spec.PoolRef]; found && pool.Spec.NADTemplate != nil {
			if fromTemplate, err := templateL2(pool.Spec.NADTemplate); err == nil {
				l2, known = fromTemplate, true
			}
		}
	}
	if known {
		return l2.key(), " on " + l2.String()
	}
	// Unknown network: compared within the pool, which at least catches two claims
	// holding one address from one band.
	return "pool:" + claim.Spec.PoolRef, " in pool " + claim.Spec.PoolRef
}

// nadNetworks reads each labelled NAD's network from its rendered config, keyed by
// its claim's namespace and label value, which is what the NAD records (see
// ClaimLabelValue).
func nadNetworks(nads []unstructured.Unstructured) map[types.NamespacedName]l2Identity {
	out := make(map[types.NamespacedName]l2Identity, len(nads))
	for i := range nads {
		nad := &nads[i]
		owner := nad.GetLabels()[ipamv1alpha1.LabelClaim]
		if owner == "" {
			continue
		}
		config, _, err := unstructured.NestedString(nad.Object, "spec", "config")
		if err != nil || config == "" {
			continue
		}
		// Only the network-identifying fields are read. The rest of the config is the
		// renderer's business and re-deriving it here would be a second opinion on a
		// shape this package already owns.
		var parsed struct {
			Bridge string `json:"bridge"`
			VLAN   *int32 `json:"vlan"`
			IPAM   struct {
				Addresses []struct {
					Address string `json:"address"`
				} `json:"addresses"`
			} `json:"ipam"`
		}
		if err := json.Unmarshal([]byte(config), &parsed); err != nil || len(parsed.IPAM.Addresses) == 0 {
			continue
		}
		prefix, err := netip.ParsePrefix(parsed.IPAM.Addresses[0].Address)
		if err != nil {
			continue
		}
		out[types.NamespacedName{Namespace: nad.GetNamespace(), Name: owner}] = l2Identity{
			Subnet: prefix.Masked().String(),
			Bridge: parsed.Bridge,
			VLAN:   vlanFrom(parsed.VLAN),
		}
	}
	return out
}

// overlappingPools finds two pools whose bands intersect on one network.
//
// Only the sweep can see this: neither pool is wrong on its own, and the allocator
// works one pool at a time. The consequence is the same as a duplicate address,
// reached without anyone making a mistake — an address handed out by each pool looks
// free to the other, so two VMs eventually get it.
func (a *Auditor) overlappingPools(pools map[string]ipamv1alpha1.IPPool) []Finding {
	names := make([]string, 0, len(pools))
	for name := range pools {
		names = append(names, name)
	}
	slices.Sort(names)

	var findings []Finding
	for i := 0; i < len(names); i++ {
		for j := i + 1; j < len(names); j++ {
			first, second := pools[names[i]], pools[names[j]]
			overlaps, network := poolsOverlap(&first, &second)
			if !overlaps {
				continue
			}
			// Both pools are implicated, so both carry the finding: a reader looking at
			// either one should see why its band cannot be used as written.
			for _, pair := range [][2]*ipamv1alpha1.IPPool{{&first, &second}, {&second, &first}} {
				findings = append(findings, Finding{
					GVK:    ipamv1alpha1.GroupVersion.WithKind("IPPool"),
					Name:   pair[0].Name,
					UID:    pair[0].UID,
					Reason: ipamv1alpha1.ReasonPoolOverlap,
					Message: fmt.Sprintf("range %s-%s overlaps IPPool %q (%s-%s) on %s; "+
						"the allocator works one pool at a time, so an address handed out by one looks free to the other",
						pair[0].Spec.Range.Start, pair[0].Spec.Range.End,
						pair[1].Name, pair[1].Spec.Range.Start, pair[1].Spec.Range.End, network),
				})
			}
		}
	}
	return findings
}

// poolsOverlap reports whether two pools share a network — subnet, bridge and VLAN —
// and an address band.
//
// A pool with no nadTemplate is skipped: without a network there is no statement
// about which L2 its addresses land on, and ranges that intersect across two
// undisclosed networks are not necessarily a collision. Two pools on one subnet but
// different VLANs are exactly that case, only declared: the API sanctions the
// arrangement, so the band comparison has to be conditioned on the whole identity
// rather than the prefix alone.
func poolsOverlap(first, second *ipamv1alpha1.IPPool) (bool, l2Identity) {
	if first.Spec.NADTemplate == nil || second.Spec.NADTemplate == nil {
		return false, l2Identity{}
	}
	firstL2, err := templateL2(first.Spec.NADTemplate)
	if err != nil {
		return false, l2Identity{}
	}
	secondL2, err := templateL2(second.Spec.NADTemplate)
	if err != nil || firstL2 != secondL2 {
		return false, l2Identity{}
	}

	firstStart, err := netip.ParseAddr(first.Spec.Range.Start)
	if err != nil {
		return false, l2Identity{}
	}
	firstEnd, err := netip.ParseAddr(first.Spec.Range.End)
	if err != nil {
		return false, l2Identity{}
	}
	secondStart, err := netip.ParseAddr(second.Spec.Range.Start)
	if err != nil {
		return false, l2Identity{}
	}
	secondEnd, err := netip.ParseAddr(second.Spec.Range.End)
	if err != nil {
		return false, l2Identity{}
	}

	return firstStart.Compare(secondEnd) <= 0 && secondStart.Compare(firstEnd) <= 0, firstL2
}

func maskedSubnet(cidr string) (string, error) {
	prefix, err := netip.ParsePrefix(cidr)
	if err != nil {
		return "", err
	}
	return prefix.Masked().String(), nil
}

// danglingPoolRefs finds claims left behind by a deleted pool.
//
// Reported once per missing pool rather than once per claim. The per-claim IPClaim
// reconciler already sets PoolNotFound on each of them, so repeating that here
// would add nothing; what no single reconcile can say is how many claims a deletion
// stranded, and that is the number an admin deciding whether to recreate the pool
// needs.
func (a *Auditor) danglingPoolRefs(claims []ipamv1alpha1.IPClaim, pools map[string]ipamv1alpha1.IPPool) []Finding {
	groups := groupByPoolRef(claims, pools)
	findings := make([]Finding, 0, len(groups))
	for pool, group := range groups {
		names := make([]string, 0, len(group))
		for _, claim := range group {
			names = append(names, claim.Namespace+"/"+claim.Name)
		}
		slices.Sort(names)

		first := group[0]
		findings = append(findings, Finding{
			GVK:       ipamv1alpha1.GroupVersion.WithKind("IPClaim"),
			Namespace: first.Namespace,
			Name:      first.Name,
			UID:       first.UID,
			Reason:    "PoolDeleted",
			Message:   fmt.Sprintf("IPPool %q does not exist but %d claim(s) still reference it: %s", pool, len(group), strings.Join(names, ", ")),
		})
	}
	sortFindings(findings)
	return findings
}

func groupByPoolRef(claims []ipamv1alpha1.IPClaim, pools map[string]ipamv1alpha1.IPPool) map[string][]ipamv1alpha1.IPClaim {
	groups := map[string][]ipamv1alpha1.IPClaim{}
	for i := range claims {
		claim := claims[i]
		if _, ok := pools[claim.Spec.PoolRef]; ok {
			continue
		}
		groups[claim.Spec.PoolRef] = append(groups[claim.Spec.PoolRef], claim)
	}
	return groups
}

// sortFindings orders findings so that a sweep is reproducible. Map iteration is
// randomised, and an audit whose output order changes between runs is an audit
// whose diffs cannot be read.
func sortFindings(findings []Finding) {
	slices.SortFunc(findings, func(a, b Finding) int {
		return cmp.Or(
			cmp.Compare(a.Reason, b.Reason),
			cmp.Compare(a.Namespace, b.Namespace),
			cmp.Compare(a.Name, b.Name),
		)
	})
}

// applyConditions turns the two status-shaped findings into persistent conditions
// and clears the ones whose cause is gone.
//
// Only these two get a condition. OrphanedNAD and PoolDeleted are about objects
// that are already gone or already reporting their own Ready=False — a condition on
// a surviving object would be a fact about something else, and it would have to be
// removed by hand once the real object was fixed.
func (a *Auditor) applyConditions(ctx context.Context, claims []ipamv1alpha1.IPClaim, pools map[string]ipamv1alpha1.IPPool, findings []Finding) error {
	claimConditions := map[types.NamespacedName]*metav1.Condition{}
	poolConditions := map[string]*metav1.Condition{}

	for _, f := range findings {
		// Filtered on the reason rather than the kind alone, because a claim can carry
		// a finding that is not about the claim: PoolDeleted is filed against a claim
		// that merely references a missing pool, holds no address, and would otherwise
		// come out DuplicateAddress=True — or, where the claim also collides, lose the
		// duplicate message to the later finding.
		//
		// The finding's reason is the condition's reason: DuplicateAddress on a claim,
		// PoolOverlap on a pool. Both are written as the DuplicateAddress condition
		// type, which is the one no reconciler touches.
		cond := &metav1.Condition{
			Type:    ipamv1alpha1.ConditionDuplicateAddress,
			Status:  metav1.ConditionTrue,
			Reason:  f.Reason,
			Message: f.Message,
		}
		switch f.Reason {
		case ipamv1alpha1.ReasonDuplicateAddress:
			claimConditions[types.NamespacedName{Namespace: f.Namespace, Name: f.Name}] = cond
		case ipamv1alpha1.ReasonPoolOverlap:
			poolConditions[f.Name] = cond
		}
	}

	var errs []error
	for i := range claims {
		key := types.NamespacedName{Namespace: claims[i].Namespace, Name: claims[i].Name}
		// A claim with no finding is walked only to clear a condition a previous sweep
		// set, so the nil desired is the removal.
		if err := a.syncClaimCondition(ctx, key, claimConditions[key], claims[i].Generation); err != nil {
			errs = append(errs, err)
		}
	}
	for _, name := range sortedNames(pools) {
		if err := a.syncPoolCondition(ctx, name, poolConditions[name], pools[name].Generation); err != nil {
			errs = append(errs, err)
		}
	}

	return errors.Join(errs...)
}

// syncClaimCondition sets desired on a claim's conditions, or removes the audit's
// condition when desired is nil. It is a no-op when the object already agrees.
//
// The object is re-read on every attempt and patched with an optimistic lock: the
// reconcilers write Ready on the same status subresource, so an unlocked merge
// patch would replace the whole conditions list and silently drop a condition
// written a moment earlier. A conflict is retried, and is the expected outcome
// rather than an error.
//
// The condition's observedGeneration is the generation of the snapshot the finding
// was computed from, not the one this re-read returned: the finding describes the
// object as it was listed, and an edit that landed since would otherwise be
// reported as already observed.
func (a *Auditor) syncClaimCondition(ctx context.Context, key types.NamespacedName, desired *metav1.Condition, generation int64) error {
	for range conditionWriteAttempts {
		claim := &ipamv1alpha1.IPClaim{}
		if err := a.Client.Get(ctx, key, claim); err != nil {
			return client.IgnoreNotFound(err)
		}
		before := claim.DeepCopy()

		changed := false
		if desired == nil {
			changed = apimeta.RemoveStatusCondition(&claim.Status.Conditions, ipamv1alpha1.ConditionDuplicateAddress)
		} else {
			cond := *desired
			cond.ObservedGeneration = generation
			changed = apimeta.SetStatusCondition(&claim.Status.Conditions, cond)
		}
		if !changed {
			return nil
		}
		err := a.Client.Status().Patch(ctx, claim, client.MergeFromWithOptions(before, client.MergeFromWithOptimisticLock{}))
		if apierrors.IsConflict(err) {
			continue
		}
		return err
	}
	return fmt.Errorf("patching IPClaim %s after %d conflicts", key, conditionWriteAttempts)
}

// syncPoolCondition is syncClaimCondition for a pool. Kept as a separate function
// rather than parameterised over the kind: the two status types share no interface,
// and a type switch here would cost more than the twenty duplicated lines.
func (a *Auditor) syncPoolCondition(ctx context.Context, name string, desired *metav1.Condition, generation int64) error {
	key := types.NamespacedName{Name: name}
	for range conditionWriteAttempts {
		pool := &ipamv1alpha1.IPPool{}
		if err := a.Client.Get(ctx, key, pool); err != nil {
			return client.IgnoreNotFound(err)
		}
		before := pool.DeepCopy()

		changed := false
		if desired == nil {
			changed = apimeta.RemoveStatusCondition(&pool.Status.Conditions, ipamv1alpha1.ConditionDuplicateAddress)
		} else {
			cond := *desired
			cond.ObservedGeneration = generation
			changed = apimeta.SetStatusCondition(&pool.Status.Conditions, cond)
		}
		if !changed {
			return nil
		}
		err := a.Client.Status().Patch(ctx, pool, client.MergeFromWithOptions(before, client.MergeFromWithOptimisticLock{}))
		if apierrors.IsConflict(err) {
			continue
		}
		return err
	}
	return fmt.Errorf("patching IPPool %s after %d conflicts", name, conditionWriteAttempts)
}

func sortedNames(pools map[string]ipamv1alpha1.IPPool) []string {
	names := make([]string, 0, len(pools))
	for name := range pools {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}
