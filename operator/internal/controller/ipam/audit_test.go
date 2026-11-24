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
	"fmt"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	ipamv1alpha1 "github.com/suanova/cubestack/api/ipam/v1alpha1"
	ipamutil "github.com/suanova/cubestack/internal/ipam"
)

var _ = Describe("Auditor", func() {
	// sweep runs every check. The suite shares one cluster, so other specs'
	// leftovers are expected findings; each spec filters down to what it caused.
	sweep := func() []Finding {
		findings, err := (&Auditor{Client: k8sClient}).RunOnce(ctx)
		ExpectWithOffset(1, err).NotTo(HaveOccurred())
		return findings
	}

	withReason := func(findings []Finding, reason string) []Finding {
		var matched []Finding
		for _, f := range findings {
			if f.Reason == reason {
				matched = append(matched, f)
			}
		}
		return matched
	}

	withName := func(findings []Finding, name string) []Finding {
		var matched []Finding
		for _, f := range findings {
			if f.Name == name {
				matched = append(matched, f)
			}
		}
		return matched
	}

	// bindAs writes an address onto a claim by hand, which is how a collision looks
	// to the sweep: neither claim's own Ready condition shows anything wrong.
	bindAs := func(name, addr string) {
		claim := getClaim(testNamespace, name)
		claim.Status.AssignedIP = addr
		ExpectWithOffset(1, k8sClient.Status().Update(ctx, claim)).To(Succeed())
	}

	claimCondition := func(name string) *metav1.Condition {
		return apimeta.FindStatusCondition(
			getClaim(testNamespace, name).Status.Conditions, ipamv1alpha1.ConditionDuplicateAddress)
	}

	poolCondition := func(name string) *metav1.Condition {
		pool := &ipamv1alpha1.IPPool{}
		ExpectWithOffset(1, k8sClient.Get(ctx, client.ObjectKey{Name: name}, pool)).To(Succeed())
		return apimeta.FindStatusCondition(pool.Status.Conditions, ipamv1alpha1.ConditionDuplicateAddress)
	}

	It("reports a NAD whose claim is gone", func() {
		// The chain this project relies on is an ownerReference, so an orphan means
		// that chain was broken. The address in the NAD's ledger is still held while
		// the pool reports it as free, which is why this is worth saying out loud.
		orphan := newNAD(testNamespace, "audit-orphan-static")
		orphan.SetLabels(map[string]string{ipamv1alpha1.LabelClaim: "audit-orphan-ip"})
		Expect(unstructured.SetNestedField(orphan.Object, `{"name":"audit-orphan-static"}`, "spec", "config")).To(Succeed())
		Expect(k8sClient.Create(ctx, orphan)).To(Succeed())
		deleteNAD("audit-orphan-static")

		matched := withName(withReason(sweep(), "OrphanedNAD"), "audit-orphan-static")
		Expect(matched).To(HaveLen(1))
		Expect(matched[0].Message).To(ContainSubstring("audit-orphan-ip"))
		// The event is filed against a stub, and kubectl describe selects events by
		// the live object's UID: without it, the one finding that has no persistent
		// condition would be invisible on the object it is about.
		Expect(orphan.GetUID()).NotTo(BeEmpty())
		Expect(matched[0].ref().GetUID()).To(Equal(orphan.GetUID()))
	})

	It("does not report a live NAD", func() {
		createPool("audit-live", testPoolSpec())
		createClaim(testNamespace, "audit-live-ip", "audit-live", "audit-live-static")
		deleteNAD("audit-live-static")

		r := &IPClaimReconciler{Client: k8sClient, APIReader: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := r.Reconcile(ctx, requestFor(testNamespace, "audit-live-ip"))
		Expect(err).NotTo(HaveOccurred())

		Expect(withName(withReason(sweep(), "OrphanedNAD"), "audit-live-static")).To(BeEmpty())
	})

	It("finds the claim of a NAD whose label had to be shortened", func() {
		// A claim name may be longer than a label value can be, and the NAD then carries
		// a truncated, digested form of it. Both sides of this check have to agree on
		// that form: reading the label as a name here would report a live NAD as an
		// orphan — and the callback on that finding is a deletion.
		longName := "audit-" + strings.Repeat("long-claim-name-", 5) + "ip"
		createPool("audit-long", testPoolSpec())
		createClaim(testNamespace, longName, "audit-long", "audit-long-static")

		r := &IPClaimReconciler{Client: k8sClient, APIReader: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := r.Reconcile(ctx, requestFor(testNamespace, longName))
		Expect(err).NotTo(HaveOccurred())

		nad := &unstructured.Unstructured{}
		nad.SetGroupVersionKind(networkAttachmentDefinitionGVK)
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: testNamespace, Name: "audit-long-static"}, nad)).To(Succeed())
		Expect(nad.GetLabels()[ipamv1alpha1.LabelClaim]).To(Equal(ipamutil.ClaimLabelValue(longName)))

		Expect(withName(withReason(sweep(), "OrphanedNAD"), "audit-long-static")).To(BeEmpty())
	})

	It("reports a NAD left behind by a claim whose name was reused", func() {
		// A name is reusable. A NAD minted for a deleted claim and a new claim given
		// that name carry the same label, and only the ownerReference UID tells them
		// apart — so going by the label alone would call the stale NAD live, and the
		// address it still carries would go unreported.
		claim := createClaim(testNamespace, "audit-reused-ip", "audit-reused", "audit-reused-static")
		staleUID := types.UID("00000000-0000-0000-0000-00000000dead")
		controller := true
		stale := newNAD(testNamespace, "audit-reused-static")
		stale.SetLabels(map[string]string{ipamv1alpha1.LabelClaim: "audit-reused-ip"})
		stale.SetOwnerReferences([]metav1.OwnerReference{{
			APIVersion: ipamv1alpha1.GroupVersion.String(),
			Kind:       "IPClaim",
			Name:       claim.Name,
			UID:        staleUID,
			Controller: &controller,
		}})
		Expect(unstructured.SetNestedField(stale.Object, `{"name":"audit-reused-static"}`, "spec", "config")).To(Succeed())
		Expect(k8sClient.Create(ctx, stale)).To(Succeed())
		deleteNAD("audit-reused-static")

		Expect(claim.UID).NotTo(Equal(staleUID))
		matched := withName(withReason(sweep(), "OrphanedNAD"), "audit-reused-static")
		Expect(matched).To(HaveLen(1))
		Expect(matched[0].Message).To(ContainSubstring("audit-reused-ip"))
	})

	It("reports two claims holding one address", func() {
		// The residue of the allocation race. Nothing on the network refuses the
		// duplicate, so the message has to say what the consequence is — and it is not
		// a failed start, or the reader would go looking for a VM that is running.
		createPool("audit-dup", testPoolSpec())
		for _, name := range []string{"audit-dup-a", "audit-dup-b"} {
			createClaim(testNamespace, name, "audit-dup", "")
			bindAs(name, testFirstIP)
		}

		duplicates := withReason(sweep(), ipamv1alpha1.ReasonDuplicateAddress)

		// Reported on both, since whichever one a reader is looking at should say
		// what is wrong with it — and should name the other.
		a := withName(duplicates, "audit-dup-a")
		Expect(a).To(HaveLen(1))
		Expect(a[0].Message).To(ContainSubstring("audit-dup-b"))
		Expect(a[0].UID).To(Equal(getClaim(testNamespace, "audit-dup-a").UID))

		b := withName(duplicates, "audit-dup-b")
		Expect(b).To(HaveLen(1))
		Expect(b[0].Message).To(ContainSubstring("audit-dup-a"))

		// The address and the network it is on: the message has to say both, or a
		// reader cannot tell which L2 the collision is on.
		Expect(a[0].Message).To(ContainSubstring("address " + testFirstIP + " on subnet " + testSubnet + " on bridge br0"))
		Expect(a[0].Message).To(ContainSubstring("intermittent connectivity"))
		Expect(a[0].Message).NotTo(ContainSubstring("will not start"))
	})

	It("writes the duplicate as a condition, and removes it once the claims differ", func() {
		// An event expires after an hour; the symptom does not. The condition is the
		// report that outlives the sweep that made it — and it has to be removed by a
		// later sweep, or the object carries a fixed problem forever.
		createPool("audit-dup-cond", testPoolSpec())
		for _, name := range []string{"audit-dup-cond-a", "audit-dup-cond-b"} {
			createClaim(testNamespace, name, "audit-dup-cond", "")
			bindAs(name, testFirstIP)
		}

		sweep()

		first := claimCondition("audit-dup-cond-a")
		Expect(first).NotTo(BeNil())
		Expect(first.Status).To(Equal(metav1.ConditionTrue))
		Expect(first.Reason).To(Equal(ipamv1alpha1.ReasonDuplicateAddress))
		Expect(first.Message).To(ContainSubstring("audit-dup-cond-b"))
		// Written as a type of its own, so that the next Ready write by the reconciler
		// cannot be the thing that removes it.
		Expect(claimCondition("audit-dup-cond-b")).NotTo(BeNil())

		// One side moves: nothing is wrong any more.
		bindAs("audit-dup-cond-b", testSecondIP)
		sweep()

		Expect(claimCondition("audit-dup-cond-a")).To(BeNil())
		Expect(claimCondition("audit-dup-cond-b")).To(BeNil())
	})

	It("stamps a condition with the generation of the snapshot it was computed from", func() {
		// The sync re-reads the object so its optimistic lock is against the live
		// version, but the generation it stamps must stay the snapshot's: an edit
		// landing between the list and the Get is what observedGeneration is for, and a
		// condition claiming the newer generation reads as current when it is not.
		const snapshotGeneration int64 = 7
		claimName := "audit-generation-ip"
		poolName := "audit-generation"
		createClaim(testNamespace, claimName, poolName, "")
		createPool(poolName, testPoolSpec())

		auditor := &Auditor{Client: k8sClient}
		desired := &metav1.Condition{
			Type:    ipamv1alpha1.ConditionDuplicateAddress,
			Status:  metav1.ConditionTrue,
			Reason:  ipamv1alpha1.ReasonDuplicateAddress,
			Message: "computed from an older snapshot",
		}

		// The objects' own generation is 1, so 7 can only come from the argument.
		claim := getClaim(testNamespace, claimName)
		Expect(claim.Generation).NotTo(Equal(snapshotGeneration))
		Expect(auditor.syncClaimCondition(ctx,
			client.ObjectKey{Namespace: testNamespace, Name: claimName}, desired, snapshotGeneration, claim.UID)).To(Succeed())
		claimCond := claimCondition(claimName)
		Expect(claimCond).NotTo(BeNil())
		Expect(claimCond.ObservedGeneration).To(Equal(snapshotGeneration))

		pool := &ipamv1alpha1.IPPool{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: poolName}, pool)).To(Succeed())
		Expect(auditor.syncPoolCondition(ctx, poolName, desired, snapshotGeneration, pool.UID)).To(Succeed())
		poolCond := poolCondition(poolName)
		Expect(poolCond).NotTo(BeNil())
		Expect(poolCond.ObservedGeneration).To(Equal(snapshotGeneration))
	})

	It("does not write a finding onto an object that replaced the one it was listed from", func() {
		// The sweep lists, then re-reads to patch. A delete and recreate under the same
		// name in between hands the re-read a different object, and the optimistic lock
		// cannot refuse the write — it locks against the replacement's own
		// resourceVersion, which was just read. For a finding that is written (as
		// opposed to one that is cleared) the UID is the only thing that can tell the
		// two apart.
		claimName := "audit-replaced-ip"
		poolName := "audit-replaced"
		createClaim(testNamespace, claimName, poolName, "")
		createPool(poolName, testPoolSpec())

		auditor := &Auditor{Client: k8sClient}
		desired := &metav1.Condition{
			Type:    ipamv1alpha1.ConditionDuplicateAddress,
			Status:  metav1.ConditionTrue,
			Reason:  ipamv1alpha1.ReasonDuplicateAddress,
			Message: "about the object this sweep listed",
		}
		stale := types.UID("00000000-0000-0000-0000-00000000dead")

		claim := getClaim(testNamespace, claimName)
		Expect(claim.UID).NotTo(Equal(stale))
		Expect(auditor.syncClaimCondition(ctx,
			client.ObjectKey{Namespace: testNamespace, Name: claimName}, desired, claim.Generation, stale)).To(Succeed())
		Expect(claimCondition(claimName)).To(BeNil())

		pool := &ipamv1alpha1.IPPool{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: poolName}, pool)).To(Succeed())
		Expect(auditor.syncPoolCondition(ctx, poolName, desired, pool.Generation, stale)).To(Succeed())
		Expect(poolCondition(poolName)).To(BeNil())

		// The same calls with the listed object's own UID do write, which is what makes
		// the assertions above about the UID rather than about the write path being dead.
		Expect(auditor.syncClaimCondition(ctx,
			client.ObjectKey{Namespace: testNamespace, Name: claimName}, desired, claim.Generation, claim.UID)).To(Succeed())
		Expect(claimCondition(claimName)).NotTo(BeNil())
		Expect(auditor.syncPoolCondition(ctx, poolName, desired, pool.Generation, pool.UID)).To(Succeed())
		Expect(poolCondition(poolName)).NotTo(BeNil())
	})

	It("does not report distinct addresses", func() {
		createPool("audit-distinct", testPoolSpec())
		for name, addr := range map[string]string{"audit-distinct-a": testFirstIP, "audit-distinct-b": testSecondIP} {
			createClaim(testNamespace, name, "audit-distinct", "")
			bindAs(name, addr)
		}

		duplicates := withReason(sweep(), ipamv1alpha1.ReasonDuplicateAddress)
		Expect(withName(duplicates, "audit-distinct-a")).To(BeEmpty())
		Expect(withName(duplicates, "audit-distinct-b")).To(BeEmpty())
	})

	It("does not report a collision across two VLANs", func() {
		// The API places a pool's subnet on a VLAN-filtered bridge and states outright
		// that address reuse across VLANs is legal. Two pools on one subnet whose bands
		// intersect are two isolated segments when the VLANs differ, and reporting them
		// would mark exactly the sanctioned arrangement as broken.
		withVLAN := func(vlan int32) ipamv1alpha1.IPPoolSpec {
			spec := testPoolSpec()
			spec.NADTemplate.VLAN = &vlan
			return spec
		}
		createPool("audit-vlan-a", withVLAN(100))
		createPool("audit-vlan-b", withVLAN(200))
		for claim, pool := range map[string]string{"audit-vlan-a-ip": "audit-vlan-a", "audit-vlan-b-ip": "audit-vlan-b"} {
			createClaim(testNamespace, claim, pool, "")
			bindAs(claim, testFirstIP)
		}

		findings := sweep()
		duplicates := withReason(findings, ipamv1alpha1.ReasonDuplicateAddress)
		Expect(withName(duplicates, "audit-vlan-a-ip")).To(BeEmpty())
		Expect(withName(duplicates, "audit-vlan-b-ip")).To(BeEmpty())

		overlaps := withReason(findings, ipamv1alpha1.ReasonPoolOverlap)
		Expect(withName(overlaps, "audit-vlan-a")).To(BeEmpty())
		Expect(withName(overlaps, "audit-vlan-b")).To(BeEmpty())
	})

	It("reads the VLAN from the NAD a claim minted", func() {
		// A claim with a NAD is grouped by what the CNI will configure — and that
		// config, not the pool, is where the bridge and VLAN come from.
		staticNAD := func(nad, claim string, vlan int32) {
			obj := newNAD(testNamespace, nad)
			obj.SetLabels(map[string]string{ipamv1alpha1.LabelClaim: claim})
			config := fmt.Sprintf(`{"name":%q,"bridge":"br0","vlan":%d,"ipam":{"addresses":[{"address":"10.66.3.150/24"}]}}`, nad, vlan)
			ExpectWithOffset(1, unstructured.SetNestedField(obj.Object, config, "spec", "config")).To(Succeed())
			ExpectWithOffset(1, k8sClient.Create(ctx, obj)).To(Succeed())
			deleteNAD(nad)
		}
		staticNAD("audit-nad-vlan-a-static", "audit-nad-vlan-a", 100)
		staticNAD("audit-nad-vlan-b-static", "audit-nad-vlan-b", 200)
		for _, name := range []string{"audit-nad-vlan-a", "audit-nad-vlan-b"} {
			createClaim(testNamespace, name, "audit-nad-vlan-pool", name+"-static")
			bindAs(name, testFirstIP)
		}

		duplicates := withReason(sweep(), ipamv1alpha1.ReasonDuplicateAddress)
		Expect(withName(duplicates, "audit-nad-vlan-a")).To(BeEmpty())
		Expect(withName(duplicates, "audit-nad-vlan-b")).To(BeEmpty())
	})

	It("treats vlan 0 and an omitted vlan as one network", func() {
		// The bridge plugin decodes both as untagged: a pool that writes vlan: 0 and
		// the NAD rendered from it without one are one segment, so a duplicate across
		// them is a duplicate — and the pool and its NAD would otherwise never compare
		// equal.
		spec := testPoolSpec()
		zero := int32(0)
		spec.NADTemplate.VLAN = &zero
		createPool("audit-vlan0", spec)

		nad := newNAD(testNamespace, "audit-vlan0-static")
		nad.SetLabels(map[string]string{ipamv1alpha1.LabelClaim: "audit-vlan0-a"})
		config := `{"name":"audit-vlan0-static","bridge":"br0","ipam":{"addresses":[{"address":"10.66.3.150/24"}]}}`
		Expect(unstructured.SetNestedField(nad.Object, config, "spec", "config")).To(Succeed())
		Expect(k8sClient.Create(ctx, nad)).To(Succeed())
		deleteNAD("audit-vlan0-static")

		createClaim(testNamespace, "audit-vlan0-a", "audit-vlan0", "audit-vlan0-static")
		createClaim(testNamespace, "audit-vlan0-b", "audit-vlan0", "")
		bindAs("audit-vlan0-a", testFirstIP)
		bindAs("audit-vlan0-b", testFirstIP)

		duplicates := withReason(sweep(), ipamv1alpha1.ReasonDuplicateAddress)
		Expect(withName(duplicates, "audit-vlan0-a")).To(HaveLen(1))
		Expect(withName(duplicates, "audit-vlan0-b")).To(HaveLen(1))
	})

	It("does not assume a claim's missing NAD has its pool's network", func() {
		// A claim whose spec.nad is set minted that NAD from whatever the pool
		// rendered then; the template says what it would render now. With the NAD
		// gone the network is unknown, and comparing it against the template would
		// report a collision on a network neither claim is known to share.
		createPool("audit-no-nad", testPoolSpec())
		createClaim(testNamespace, "audit-no-nad-a", "audit-no-nad", "audit-no-nad-a-static")
		createClaim(testNamespace, "audit-no-nad-b", "audit-no-nad", "")
		bindAs("audit-no-nad-a", testFirstIP)
		bindAs("audit-no-nad-b", testFirstIP)

		duplicates := withReason(sweep(), ipamv1alpha1.ReasonDuplicateAddress)
		Expect(withName(duplicates, "audit-no-nad-a")).To(BeEmpty())
		Expect(withName(duplicates, "audit-no-nad-b")).To(BeEmpty())
	})

	It("does not read the network of a NAD another controller owns", func() {
		// A NAD sitting at the claim's spec.nad is not necessarily the claim's: if
		// another controller owns it, the claim cannot adopt it, so its config says
		// nothing about where this claim's address lands. Reading it anyway would put
		// the claim on a network it is not on — here, alongside a claim whose
		// address is genuinely on the pool's network.
		createPool("audit-foreign", testPoolSpec())

		nad := newNAD(testNamespace, "audit-foreign-static")
		nad.SetLabels(map[string]string{ipamv1alpha1.LabelClaim: "audit-foreign-a"})
		controlled := true
		nad.SetOwnerReferences([]metav1.OwnerReference{{
			APIVersion: "apps/v1",
			Kind:       "StatefulSet",
			Name:       "audit-foreign-db",
			UID:        types.UID("00000000-0000-0000-0000-00000000beef"),
			Controller: &controlled,
		}})
		config := `{"name":"audit-foreign-static","bridge":"br0","ipam":{"addresses":[{"address":"10.66.3.150/24"}]}}`
		Expect(unstructured.SetNestedField(nad.Object, config, "spec", "config")).To(Succeed())
		Expect(k8sClient.Create(ctx, nad)).To(Succeed())
		deleteNAD("audit-foreign-static")

		createClaim(testNamespace, "audit-foreign-a", "audit-foreign", "audit-foreign-static")
		createClaim(testNamespace, "audit-foreign-b", "audit-foreign", "")
		bindAs("audit-foreign-a", testFirstIP)
		bindAs("audit-foreign-b", testFirstIP)

		duplicates := withReason(sweep(), ipamv1alpha1.ReasonDuplicateAddress)
		Expect(withName(duplicates, "audit-foreign-a")).To(BeEmpty())
		Expect(withName(duplicates, "audit-foreign-b")).To(BeEmpty())
	})

	It("reports two pools whose bands intersect on one subnet", func() {
		// Neither pool is wrong on its own and the allocator works one pool at a time,
		// so only the sweep can see this. Both carry the finding, and both carry it as
		// a condition: a reader looking at either pool should see why its band cannot
		// be used as written.
		createPool("audit-overlap-a", testPoolSpec())
		createPool("audit-overlap-b", testPoolSpec())

		overlaps := withReason(sweep(), ipamv1alpha1.ReasonPoolOverlap)
		Expect(withName(overlaps, "audit-overlap-a")).To(HaveLen(1))
		Expect(withName(overlaps, "audit-overlap-b")).To(HaveLen(1))

		pool := &ipamv1alpha1.IPPool{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: "audit-overlap-a"}, pool)).To(Succeed())
		Expect(withName(overlaps, "audit-overlap-a")[0].UID).To(Equal(pool.UID))

		for _, name := range []string{"audit-overlap-a", "audit-overlap-b"} {
			cond := poolCondition(name)
			Expect(cond).NotTo(BeNil())
			Expect(cond.Status).To(Equal(metav1.ConditionTrue))
			Expect(cond.Reason).To(Equal(ipamv1alpha1.ReasonPoolOverlap))
		}
	})

	It("names every pool a pool overlaps on one finding", func() {
		// One condition is all a pool gets, so a pairwise report would keep only the
		// last pair written into it — and a reader would fix one neighbour and leave
		// the other.
		for _, name := range []string{"audit-tri-a", "audit-tri-b", "audit-tri-c"} {
			createPool(name, testPoolSpec())
		}

		overlaps := withReason(sweep(), ipamv1alpha1.ReasonPoolOverlap)
		a := withName(overlaps, "audit-tri-a")
		Expect(a).To(HaveLen(1))
		Expect(a[0].Message).To(ContainSubstring("audit-tri-b"))
		Expect(a[0].Message).To(ContainSubstring("audit-tri-c"))

		cond := poolCondition("audit-tri-a")
		Expect(cond).NotTo(BeNil())
		Expect(cond.Message).To(ContainSubstring("audit-tri-b"))
		Expect(cond.Message).To(ContainSubstring("audit-tri-c"))
	})

	It("does not compare a band written backwards", func() {
		// A reversed band is invalid, not overlapping: the pool's own validation
		// reports it, and calling the neighbour overlapping would blame the pool that
		// was written correctly.
		first := &ipamv1alpha1.IPPool{ObjectMeta: metav1.ObjectMeta{Name: "audit-reversed-a"}, Spec: testPoolSpec()}
		first.Spec.Range = ipamv1alpha1.IPRange{Start: testThirdIP, End: testFirstIP}
		second := &ipamv1alpha1.IPPool{ObjectMeta: metav1.ObjectMeta{Name: "audit-reversed-b"}, Spec: testPoolSpec()}

		overlaps, _ := poolsOverlap(first, second)
		Expect(overlaps).To(BeFalse())
	})

	It("bounds a finding message to what an event note can hold", func() {
		// The Events API rejects a note over 1kB, and the message is also the
		// condition's text. An unbounded list of holders would make the event for the
		// widest collision the one that never gets recorded.
		long := strings.Repeat("x", 2*maxEventNote)
		trimmed := boundedNote(long)
		Expect(len(trimmed)).To(BeNumerically("<=", maxEventNote))
		Expect(trimmed).To(HaveSuffix("(truncated)"))
		Expect(boundedNote("short message")).To(Equal("short message"))
	})

	It("summarises a list of names rather than letting it run on", func() {
		names := make([]string, 100)
		for i := range names {
			names[i] = fmt.Sprintf("%s/claim-%03d", testNamespace, i)
		}
		listed := nameList(names)
		Expect(len(listed)).To(BeNumerically("<=", nameBudget+32))
		Expect(listed).To(ContainSubstring("more"))
		Expect(listed).To(HavePrefix(testNamespace + "/claim-000"))
	})

	It("reports claims left behind by a deleted pool", func() {
		// No deletion guard is deliberate: a pool can go, and the claims it served
		// are then reported rather than silently invalid. What no single reconcile
		// can say is how many were stranded, which is what this adds.
		for _, name := range []string{"audit-dangling-a", "audit-dangling-b"} {
			createClaim(testNamespace, name, "audit-gone-pool", "")
		}

		var matched []Finding
		for _, f := range withReason(sweep(), "PoolDeleted") {
			if strings.Contains(f.Message, "audit-gone-pool") {
				matched = append(matched, f)
			}
		}
		Expect(matched).To(HaveLen(1))
		Expect(matched[0].Message).To(ContainSubstring("audit-dangling-a"))
		Expect(matched[0].Message).To(ContainSubstring("audit-dangling-b"))
		Expect(matched[0].Message).To(ContainSubstring("2 claim(s)"))
		Expect(matched[0].UID).To(Equal(getClaim(testNamespace, matched[0].Name).UID))

		// Neither claim holds an address, so there is nothing a duplicate condition
		// could say about them — and PoolDeleted is about the pool, not them.
		Expect(claimCondition("audit-dangling-a")).To(BeNil())
		Expect(claimCondition("audit-dangling-b")).To(BeNil())
	})

	It("bounds the claim list of a deleted-pool finding when the names are long", func() {
		// A claim name may run to 253 characters, so a handful of them is already more
		// than an event note can hold — and the Events API rejects the whole event, not
		// just the excess. The finding is the only place the stranded claims are named
		// at all, so it has to survive the widest band an IPPool can serve.
		longName := func(i int) string {
			return fmt.Sprintf("audit-long-gone-%s-%d", strings.Repeat("n", 200), i)
		}
		names := make([]string, 5)
		for i := range names {
			names[i] = longName(i)
			createClaim(testNamespace, names[i], "audit-long-gone-pool", "")
		}

		var matched []Finding
		for _, f := range withReason(sweep(), "PoolDeleted") {
			if strings.Contains(f.Message, "audit-long-gone-pool") {
				matched = append(matched, f)
			}
		}
		Expect(matched).To(HaveLen(1))
		Expect(len(matched[0].Message)).To(BeNumerically("<=", maxEventNote))
		Expect(matched[0].Message).To(ContainSubstring(testNamespace + "/" + names[0]))
		Expect(matched[0].Message).To(ContainSubstring("and 4 more"))
		Expect(matched[0].Message).NotTo(ContainSubstring(names[4]))
	})

	It("keeps the duplicate report when a claim also references a missing pool", func() {
		// Both findings land on claims of a deleted pool that share an address. Filing
		// PoolDeleted as a condition would replace the duplicate message — and drop the
		// other holder from it — because both wash into the one condition type.
		names := []string{"audit-mixed-a", "audit-mixed-b"}
		for _, name := range names {
			createClaim(testNamespace, name, "audit-mixed-pool", "")
			bindAs(name, testFirstIP)
		}

		sweep()

		for _, name := range names {
			cond := claimCondition(name)
			Expect(cond).NotTo(BeNil(), name)
			Expect(cond.Reason).To(Equal(ipamv1alpha1.ReasonDuplicateAddress), name)
			Expect(cond.Message).To(ContainSubstring("is held by 2 claims"), name)
			Expect(cond.Message).To(ContainSubstring(names[0]), name)
			Expect(cond.Message).To(ContainSubstring(names[1]), name)
		}
	})

	It("is quiet about a healthy claim", func() {
		createPool("audit-healthy", testPoolSpec())
		createClaim(testNamespace, "audit-healthy-ip", "audit-healthy", "audit-healthy-static")
		deleteNAD("audit-healthy-static")

		r := &IPClaimReconciler{Client: k8sClient, APIReader: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := r.Reconcile(ctx, requestFor(testNamespace, "audit-healthy-ip"))
		Expect(err).NotTo(HaveOccurred())

		// Asserted first, so the negative assertions below cannot pass by the
		// fixture having quietly failed to exist.
		Expect(getClaim(testNamespace, "audit-healthy-ip").Status.AssignedIP).To(Equal(testFirstIP))
		Expect(getNAD("audit-healthy-static")).NotTo(BeNil())

		findings := sweep()
		Expect(withName(withReason(findings, "OrphanedNAD"), "audit-healthy-static")).To(BeEmpty())
		Expect(withName(withReason(findings, ipamv1alpha1.ReasonDuplicateAddress), "audit-healthy-ip")).To(BeEmpty())
		Expect(claimCondition("audit-healthy-ip")).To(BeNil())
		for _, f := range withReason(findings, "PoolDeleted") {
			Expect(f.Message).NotTo(ContainSubstring("audit-healthy"))
		}
	})
})
