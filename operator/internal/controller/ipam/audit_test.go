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
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
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

		b := withName(duplicates, "audit-dup-b")
		Expect(b).To(HaveLen(1))
		Expect(b[0].Message).To(ContainSubstring("audit-dup-a"))

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

		for _, name := range []string{"audit-overlap-a", "audit-overlap-b"} {
			cond := poolCondition(name)
			Expect(cond).NotTo(BeNil())
			Expect(cond.Status).To(Equal(metav1.ConditionTrue))
			Expect(cond.Reason).To(Equal(ipamv1alpha1.ReasonPoolOverlap))
		}
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
