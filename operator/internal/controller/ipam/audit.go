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

// maxEventNote is the longest note the Events API accepts. Every finding is recorded
// as one, so a message that enumerates every object implicated can outgrow it — and a
// rejected event is the finding nobody sees, precisely where the most objects share
// the problem.
const maxEventNote = 1024

// boundedNote clamps a finding's message to that limit. It is a backstop: the
// enumerations below are bounded already, and this catches a message that grew long
// for some other reason — a bridge name, say, which is itself up to 253 characters.
func boundedNote(message string) string {
	if len(message) <= maxEventNote {
		return message
	}
	const marker = " … (truncated)"
	return message[:maxEventNote-len(marker)] + marker
}

// nameBudget is how much of a finding's message the names it lists may take. It
// leaves room for the rest of the sentence inside maxEventNote.
const nameBudget = 400

// nameList renders object names for a finding, stopping before the list eats the
// message and counting the rest. A duplicate can involve any number of claims, and
// the message still has to be recordable as one event note.
func nameList(names []string) string {
	var b strings.Builder
	listed := 0
	for _, name := range names {
		if listed > 0 && b.Len()+len(", ")+len(name) > nameBudget {
			break
		}
		if listed > 0 {
			b.WriteString(", ")
		}
		b.WriteString(name)
		listed++
	}
	if omitted := len(names) - listed; omitted > 0 {
		fmt.Fprintf(&b, ", and %d more", omitted)
	}
	return b.String()
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
			// The message is data — it names objects this process did not author — so
			// it is an argument, never the format.
			recordEvent(a.Recorder, f.ref(), corev1.EventTypeWarning, f.Reason, "Audit", "%s", f.Message)
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

	// Every finding is recorded as an event, whose note the API caps well below the
	// condition's own limit. Bounding here covers the checks now and any added later.
	for i := range findings {
		findings[i].Message = boundedNote(findings[i].Message)
	}
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
	// Indexed by namespace and the name the label records — the claim's name, or the
	// truncated, digested form a long one takes (see ClaimLabelValue). The value is
	// the UID: a name is reusable, so a NAD left behind by a deleted claim and a new
	// claim given that name share the label, and only the UID tells them apart.
	known := make(map[types.NamespacedName]types.UID, len(claims))
	for i := range claims {
		known[types.NamespacedName{Namespace: claims[i].Namespace, Name: ipamutil.ClaimLabelValue(claims[i].Name)}] = claims[i].UID
	}

	var findings []Finding
	for i := range nads {
		nad := &nads[i]
		label := nad.GetLabels()[ipamv1alpha1.LabelClaim]
		if label == "" {
			continue
		}
		key := types.NamespacedName{Namespace: nad.GetNamespace(), Name: label}
		uid, live := known[key]
		control, owner := nadController(nad)
		if live && (control != controlClaim || owner == uid) {
			continue
		}
		message := fmt.Sprintf("owned by IPClaim %s/%s, which no longer exists; "+
			"its address is held by no claim and can be reassigned to another", key.Namespace, key.Name)
		if live {
			// The name exists, but it belongs to a different claim than the one that
			// minted this NAD — the UID is what the garbage collector would have
			// followed, and a label cannot express it.
			message = fmt.Sprintf("kept by an earlier IPClaim %s/%s that no longer exists — "+
				"the name now belongs to a different claim (uid %s) — so its address is held by no claim and can be reassigned to another",
				key.Namespace, key.Name, uid)
		}
		findings = append(findings, Finding{
			GVK:       networkAttachmentDefinitionGVK,
			Namespace: nad.GetNamespace(),
			Name:      nad.GetName(),
			UID:       nad.GetUID(),
			Reason:    "OrphanedNAD",
			Message:   message,
		})
	}
	return findings
}

// nadControl says what controls a NAD: nothing, an IPClaim, or a controller that is
// not an IPClaim.
type nadControl int

const (
	// controlNone is a NAD with no controller reference — an older object, or one
	// whose reference was stripped by hand. Its name and label are all there is to
	// go on.
	controlNone nadControl = iota
	// controlClaim is a NAD this operator minted.
	controlClaim
	// controlForeign is a NAD another controller owns. Whatever its name or label
	// says, its network and lifetime are that controller's to decide.
	controlForeign
)

// nadController reads a NAD's controller ownerReference.
func nadController(nad *unstructured.Unstructured) (nadControl, types.UID) {
	for _, ref := range nad.GetOwnerReferences() {
		if ref.Controller == nil || !*ref.Controller {
			continue
		}
		if ref.APIVersion == ipamv1alpha1.GroupVersion.String() && ref.Kind == "IPClaim" {
			return controlClaim, ref.UID
		}
		return controlForeign, ref.UID
	}
	return controlNone, ""
}

// duplicateKey is one address on one L2: what two claims have to share to collide.
// A struct rather than a joined string because the L2 key embeds NUL separators of
// its own, leaving no separator in a string form that could be split back apart.
type duplicateKey struct {
	l2   string
	addr netip.Addr
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

	holders := map[duplicateKey][]ipamv1alpha1.IPClaim{}
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
		key := duplicateKey{l2: l2, addr: addr}
		holders[key] = append(holders[key], claim)
	}

	var findings []Finding
	for key, group := range holders {
		if len(group) < 2 {
			continue
		}
		names := make([]string, 0, len(group))
		for _, claim := range group {
			names = append(names, claim.Namespace+"/"+claim.Name)
		}
		slices.Sort(names)

		message := fmt.Sprintf("address %s%s is held by %d claims: %s; "+
			"nothing on the network refuses a duplicate, so these VMs share an address and the symptom is intermittent connectivity, not a failed start",
			key.addr, where[key.l2], len(group), nameList(names))

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

// untaggedVLAN stands in for a network with no VLAN. The bridge plugin decodes an
// omitted vlan and vlan: 0 identically — both untagged — so a template that writes 0
// and the NAD rendered from it without one describe one segment. -1 rather than 0
// keeps an untagged network distinguishable from a VLAN number in the type.
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

// vlanFrom normalises a VLAN field. Zero and absent are the same network — see
// untaggedVLAN — so both collapse to untaggedVLAN; a pool that writes vlan: 0 and
// the NAD rendered from it, which omits the field, must not compare unequal.
func vlanFrom(v *int32) int32 {
	if v == nil || *v <= 0 {
		return untaggedVLAN
	}
	return *v
}

// nadNetwork is one minted NAD's network together with what controls it.
type nadNetwork struct {
	l2      l2Identity
	control nadControl
	owner   types.UID
}

// controls reports whether this NAD may supply the network of the claim with the
// given UID. A claim's own spec.nad names it, so a NAD with no controller is taken
// on the name alone. One this operator minted must carry the claim's UID: a NAD
// left behind by a deleted claim whose name was reused carries the same label, and
// must not be read as the new claim's. One another controller owns is refused
// whatever its name — the reconciler will not adopt it either, so its config says
// nothing about where the claim's address lands.
func (n nadNetwork) controls(uid types.UID) bool {
	switch n.control {
	case controlClaim:
		return n.owner == uid
	case controlForeign:
		return false
	default:
		return true
	}
}

// claimL2 resolves the network a claim's address is served on — the NAD it minted,
// else its pool's template if it mints none — and returns both the grouping key and the
// phrase a finding names it by.
func claimL2(claim ipamv1alpha1.IPClaim, networks map[types.NamespacedName]nadNetwork, pools map[string]ipamv1alpha1.IPPool) (key, where string) {
	if claim.Spec.NAD != "" {
		// A claim that mints a NAD is grouped by what the CNI will actually configure.
		// Its pool's template is not a substitute when that NAD is missing, or is one
		// another claim controls: the template says what the pool renders today, not
		// what this claim's NAD was rendered with.
		nn := types.NamespacedName{Namespace: claim.Namespace, Name: claim.Spec.NAD}
		if net, found := networks[nn]; found && net.controls(claim.UID) {
			return net.l2.key(), " on " + net.l2.String()
		}
	} else if pool, found := pools[claim.Spec.PoolRef]; found && pool.Spec.NADTemplate != nil {
		// No NAD is minted, so the template is what the address lands on.
		if fromTemplate, err := templateL2(pool.Spec.NADTemplate); err == nil {
			return fromTemplate.key(), " on " + fromTemplate.String()
		}
	}
	// Unknown network: compared within the pool, which at least catches two claims of
	// one pool holding one address.
	return "pool:" + claim.Spec.PoolRef, " in pool " + claim.Spec.PoolRef
}

// nadNetworks reads each labelled NAD's network from its rendered config, keyed by
// the NAD's own name — the value its claim put in spec.nad.
func nadNetworks(nads []unstructured.Unstructured) map[types.NamespacedName]nadNetwork {
	out := make(map[types.NamespacedName]nadNetwork, len(nads))
	for i := range nads {
		nad := &nads[i]
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
		control, owner := nadController(nad)
		out[types.NamespacedName{Namespace: nad.GetNamespace(), Name: nad.GetName()}] = nadNetwork{
			l2: l2Identity{
				Subnet: prefix.Masked().String(),
				Bridge: parsed.Bridge,
				VLAN:   vlanFrom(parsed.VLAN),
			},
			control: control,
			owner:   owner,
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
	names := sortedNames(pools)
	peers := map[string][]string{}
	network := map[string]l2Identity{}
	for i := range len(names) {
		for j := i + 1; j < len(names); j++ {
			first, second := pools[names[i]], pools[names[j]]
			overlaps, l2 := poolsOverlap(&first, &second)
			if !overlaps {
				continue
			}
			peers[names[i]] = append(peers[names[i]], describePool(&second))
			peers[names[j]] = append(peers[names[j]], describePool(&first))
			network[names[i]] = l2
			network[names[j]] = l2
		}
	}

	// One finding per pool naming all of its peers, not one per pair: a pool that
	// intersects three others would otherwise leave whichever pair came last in the
	// condition, and the reader decides what to change from a message that names one.
	findings := make([]Finding, 0, len(peers))
	for _, name := range names {
		if len(peers[name]) == 0 {
			continue
		}
		pool := pools[name]
		findings = append(findings, Finding{
			GVK:    ipamv1alpha1.GroupVersion.WithKind("IPPool"),
			Name:   name,
			UID:    pool.UID,
			Reason: ipamv1alpha1.ReasonPoolOverlap,
			Message: fmt.Sprintf("range %s-%s overlaps %s on %s; "+
				"the allocator works one pool at a time, so an address handed out by one pool looks free to the other",
				pool.Spec.Range.Start, pool.Spec.Range.End, nameList(peers[name]), network[name]),
		})
	}
	return findings
}

// describePool names a pool and its band for the message of a pool it overlaps.
func describePool(pool *ipamv1alpha1.IPPool) string {
	return fmt.Sprintf("IPPool %q (%s-%s)", pool.Name, pool.Spec.Range.Start, pool.Spec.Range.End)
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

	// A band written backwards is invalid, not overlapping. The pool's own rejection
	// reports it through the Accepted condition; comparing it here would mark a
	// neighbour for someone else's typo.
	if firstStart.Compare(firstEnd) > 0 || secondStart.Compare(secondEnd) > 0 {
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
			Message:   fmt.Sprintf("IPPool %q does not exist but %d claim(s) still reference it: %s", pool, len(group), nameList(names)),
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
		if err := a.syncClaimCondition(ctx, key, claimConditions[key], claims[i].Generation, claims[i].UID); err != nil {
			errs = append(errs, err)
		}
	}
	for _, name := range sortedNames(pools) {
		if err := a.syncPoolCondition(ctx, name, poolConditions[name], pools[name].Generation, pools[name].UID); err != nil {
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
//
// The UID is the listed object's, and a re-read that returns a different one is left
// alone: the name was deleted and recreated in between, so the finding describes an
// object that no longer exists. The optimistic lock cannot catch this — it locks on
// the replacement's own resourceVersion, which it has just read — and the next sweep
// speaks for the replacement.
func (a *Auditor) syncClaimCondition(ctx context.Context, key types.NamespacedName, desired *metav1.Condition, generation int64, uid types.UID) error {
	for range conditionWriteAttempts {
		claim := &ipamv1alpha1.IPClaim{}
		if err := a.Client.Get(ctx, key, claim); err != nil {
			return client.IgnoreNotFound(err)
		}
		if claim.UID != uid {
			return nil
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
func (a *Auditor) syncPoolCondition(ctx context.Context, name string, desired *metav1.Condition, generation int64, uid types.UID) error {
	key := types.NamespacedName{Name: name}
	for range conditionWriteAttempts {
		pool := &ipamv1alpha1.IPPool{}
		if err := a.Client.Get(ctx, key, pool); err != nil {
			return client.IgnoreNotFound(err)
		}
		if pool.UID != uid {
			return nil
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
