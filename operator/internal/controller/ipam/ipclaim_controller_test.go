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
	"encoding/json"
	"fmt"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/event"

	ipamv1alpha1 "github.com/suanova/cubestack/api/ipam/v1alpha1"
)

var _ = Describe("IPClaim Controller", func() {
	// reconciled is the object under test with every collaborator set the way the
	// binary sets it. APIReader is the same client here — envtest's client reads
	// straight from the API server — so the specs pin the invariant that back-to-back
	// allocations see each other's writes, not the mechanism that provides it.
	reconciled := func() *IPClaimReconciler {
		return &IPClaimReconciler{Client: k8sClient, APIReader: k8sClient, Scheme: k8sClient.Scheme()}
	}

	reconcileClaim := func(namespace, name string) {
		_, err := reconciled().Reconcile(ctx, requestFor(namespace, name))
		ExpectWithOffset(1, err).NotTo(HaveOccurred())
	}

	ready := func(claim *ipamv1alpha1.IPClaim) *metav1.Condition {
		return apimeta.FindStatusCondition(claim.Status.Conditions, ipamv1alpha1.ConditionReady)
	}

	// renderedConfig decodes a minted NAD's spec.config.
	renderedConfig := func(nad *unstructured.Unstructured) map[string]any {
		raw, found, err := unstructured.NestedString(nad.Object, "spec", "config")
		ExpectWithOffset(1, err).NotTo(HaveOccurred())
		ExpectWithOffset(1, found).To(BeTrue())

		var parsed map[string]any
		ExpectWithOffset(1, json.Unmarshal([]byte(raw), &parsed)).To(Succeed())
		return parsed
	}

	It("binds the lowest free address and mints the NAD", func() {
		createPool("claims-basic", testPoolSpec())
		createClaim(testNamespace, "claims-basic-ip", "claims-basic", "claims-basic-static")
		deleteNAD("claims-basic-static")

		reconcileClaim(testNamespace, "claims-basic-ip")

		got := getClaim(testNamespace, "claims-basic-ip")
		Expect(got.Status.AssignedIP).To(Equal(testFirstIP))
		Expect(ready(got)).NotTo(BeNil())
		Expect(ready(got).Status).To(Equal(metav1.ConditionTrue))
		Expect(ready(got).Reason).To(Equal(ipamv1alpha1.ReasonBound))
		Expect(got.UID).NotTo(BeEmpty())

		nad := getNAD("claims-basic-static")
		Expect(metav1.IsControlledBy(nad, got)).To(BeTrue())
		Expect(nad.GetLabels()).To(HaveKeyWithValue(ipamv1alpha1.LabelClaim, "claims-basic-ip"))

		config := renderedConfig(nad)
		Expect(config).To(HaveKeyWithValue("name", "claims-basic-static"))
		Expect(config).To(HaveKeyWithValue("bridge", "br0"))

		ipam, ok := config["ipam"].(map[string]any)
		Expect(ok).To(BeTrue())
		// The claim's address is baked in as a single static assignment. The pool's
		// own fields remain the sole source of addressing — the mask comes from
		// testSubnet, the gateway from the template — but nothing arbitrates the
		// address at the CNI any more.
		Expect(ipam).To(HaveKeyWithValue("type", "static"))
		Expect(ipam).To(HaveKeyWithValue("addresses", []any{
			map[string]any{"address": testFirstIP + "/24", "gateway": testGateway},
		}))
	})

	It("gives the second claim the next address", func() {
		createPool("claims-two", testPoolSpec())
		createClaim(testNamespace, "claims-two-a", "claims-two", "")
		createClaim(testNamespace, "claims-two-b", "claims-two", "")

		reconcileClaim(testNamespace, "claims-two-a")
		reconcileClaim(testNamespace, "claims-two-b")

		Expect(getClaim(testNamespace, "claims-two-a").Status.AssignedIP).To(Equal(testFirstIP))
		Expect(getClaim(testNamespace, "claims-two-b").Status.AssignedIP).To(Equal(testSecondIP))
	})

	It("gives every claim in a pool its own address", func() {
		// The regression the single-writer discipline exists for: each allocation is a
		// read of the claim set followed by a write, so an allocation that read a
		// snapshot from before the previous write would hand out an address twice.
		// Nothing on the network would refuse the second one.
		spec := testPoolSpec()
		spec.Range = ipamv1alpha1.IPRange{Start: testFirstIP, End: "10.66.3.159"}
		createPool("claims-many", spec)

		names := make([]string, 0, 10)
		for i := range 10 {
			name := fmt.Sprintf("claims-many-%d", i)
			createClaim(testNamespace, name, "claims-many", "")
			names = append(names, name)
		}

		held := map[string]string{}
		for _, name := range names {
			reconcileClaim(testNamespace, name)

			ip := getClaim(testNamespace, name).Status.AssignedIP
			Expect(ip).NotTo(BeEmpty(), "claim %s was not bound", name)
			Expect(held).NotTo(HaveKey(ip), "address %s handed to both %s and %s", ip, held[ip], name)
			held[ip] = name
		}
		Expect(held).To(HaveLen(len(names)))
	})

	It("binds a claim with no spec.nad without creating anything", func() {
		createPool("claims-ledger-only", testPoolSpec())
		createClaim(testNamespace, "claims-ledger-only-ip", "claims-ledger-only", "")

		reconcileClaim(testNamespace, "claims-ledger-only-ip")

		got := getClaim(testNamespace, "claims-ledger-only-ip")
		Expect(got.Status.AssignedIP).To(Equal(testFirstIP))
		Expect(ready(got).Status).To(Equal(metav1.ConditionTrue))
	})

	It("keeps an address a claim already holds", func() {
		// The property that makes this layer worth having: a claim never moves. A
		// re-derivation here would let a lower free address displace a running VM.
		createPool("claims-sticky", testPoolSpec())
		claim := createClaim(testNamespace, "claims-sticky-ip", "claims-sticky", "")

		claim.Status.AssignedIP = testThirdIP
		Expect(k8sClient.Status().Update(ctx, claim)).To(Succeed())

		reconcileClaim(testNamespace, "claims-sticky-ip")

		got := getClaim(testNamespace, "claims-sticky-ip")
		Expect(got.Status.AssignedIP).To(Equal(testThirdIP))
		Expect(ready(got).Status).To(Equal(metav1.ConditionTrue))
	})

	It("reports exhaustion rather than over-allocating", func() {
		spec := testPoolSpec()
		// A band of exactly one address, so the second claim must fail.
		spec.Range = ipamv1alpha1.IPRange{Start: testFirstIP, End: testFirstIP}
		createPool("claims-exhausted", spec)
		createClaim(testNamespace, "claims-exhausted-a", "claims-exhausted", "")
		createClaim(testNamespace, "claims-exhausted-b", "claims-exhausted", "")

		reconcileClaim(testNamespace, "claims-exhausted-a")
		reconcileClaim(testNamespace, "claims-exhausted-b")

		Expect(getClaim(testNamespace, "claims-exhausted-a").Status.AssignedIP).To(Equal(testFirstIP))

		second := getClaim(testNamespace, "claims-exhausted-b")
		Expect(second.Status.AssignedIP).To(BeEmpty())
		Expect(ready(second)).NotTo(BeNil())
		Expect(ready(second).Status).To(Equal(metav1.ConditionFalse))
		Expect(ready(second).Reason).To(Equal(ipamv1alpha1.ReasonRangeExhausted))
	})

	It("reports a pool whose exclusions leave nothing as exhausted", func() {
		// Well formed and empty, so it reads as a full pool rather than a broken one:
		// the operator's next step in both cases is to widen what can be allocated.
		spec := testPoolSpec()
		spec.Exclude = []ipamv1alpha1.IPRange{{Start: testFirstIP, End: testThirdIP}}
		createPool("claims-all-excluded", spec)
		createClaim(testNamespace, "claims-all-excluded-ip", "claims-all-excluded", "")

		reconcileClaim(testNamespace, "claims-all-excluded-ip")

		got := getClaim(testNamespace, "claims-all-excluded-ip")
		Expect(got.Status.AssignedIP).To(BeEmpty())
		Expect(ready(got).Reason).To(Equal(ipamv1alpha1.ReasonRangeExhausted))
	})

	It("skips an excluded address and keeps the rest of the band usable", func() {
		// The remediation the design relies on (§10.5): taking an address out of the
		// pool must not take the pool out with it.
		spec := testPoolSpec()
		spec.Exclude = []ipamv1alpha1.IPRange{{Start: testFirstIP, End: testFirstIP}}
		createPool("claims-exclude", spec)
		createClaim(testNamespace, "claims-exclude-a", "claims-exclude", "")
		createClaim(testNamespace, "claims-exclude-b", "claims-exclude", "")

		reconcileClaim(testNamespace, "claims-exclude-a")
		reconcileClaim(testNamespace, "claims-exclude-b")

		Expect(getClaim(testNamespace, "claims-exclude-a").Status.AssignedIP).To(Equal(testSecondIP))
		Expect(getClaim(testNamespace, "claims-exclude-b").Status.AssignedIP).To(Equal(testThirdIP))
	})

	It("fails a claim whose pool does not exist", func() {
		createClaim(testNamespace, "claims-nopool-ip", "claims-nopool", "")

		reconcileClaim(testNamespace, "claims-nopool-ip")

		got := getClaim(testNamespace, "claims-nopool-ip")
		Expect(ready(got)).NotTo(BeNil())
		Expect(ready(got).Status).To(Equal(metav1.ConditionFalse))
		Expect(ready(got).Reason).To(Equal(ipamv1alpha1.ReasonPoolNotFound))
	})

	It("refuses a claim from a namespace the pool does not admit", func() {
		createNamespace("claims-elsewhere")
		// testPoolSpec admits only "default".
		createPool("claims-gate", testPoolSpec())
		createClaim("claims-elsewhere", "claims-gate-ip", "claims-gate", "")

		reconcileClaim("claims-elsewhere", "claims-gate-ip")

		got := getClaim("claims-elsewhere", "claims-gate-ip")
		Expect(got.Status.AssignedIP).To(BeEmpty())
		Expect(ready(got).Status).To(Equal(metav1.ConditionFalse))
		Expect(ready(got).Reason).To(Equal(ipamv1alpha1.ReasonNamespaceNotAllowed))
	})

	It("keeps the address of a claim whose namespace leaves the allow-list", func() {
		// Prospective, not retroactive: the NAD on the running VM still carries the
		// address, so revoking it here would hand it to somebody else while that VM is
		// still using it.
		createPool("claims-gate-narrow", testPoolSpec())
		createClaim(testNamespace, "claims-gate-narrow-ip", "claims-gate-narrow", "")
		reconcileClaim(testNamespace, "claims-gate-narrow-ip")
		Expect(getClaim(testNamespace, "claims-gate-narrow-ip").Status.AssignedIP).To(Equal(testFirstIP))

		pool := &ipamv1alpha1.IPPool{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: "claims-gate-narrow"}, pool)).To(Succeed())
		pool.Spec.Namespaces = []string{"somebody-else"}
		Expect(k8sClient.Update(ctx, pool)).To(Succeed())

		reconcileClaim(testNamespace, "claims-gate-narrow-ip")

		got := getClaim(testNamespace, "claims-gate-narrow-ip")
		Expect(got.Status.AssignedIP).To(Equal(testFirstIP))
		Expect(ready(got).Status).To(Equal(metav1.ConditionTrue))
	})

	It("honours an Exact request", func() {
		spec := testPoolSpec()
		spec.Range = ipamv1alpha1.IPRange{Start: testFirstIP, End: "10.66.3.159"}
		createPool("claims-exact", spec)

		// The higher address, so that a fallback to Auto would be visible.
		createClaimWith(testNamespace, "claims-exact-ip", ipamv1alpha1.IPClaimSpec{
			PoolRef:    "claims-exact",
			Allocation: &ipamv1alpha1.AddressAllocation{Strategy: ipamv1alpha1.AllocationExact, Address: testThirdIP},
		})

		reconcileClaim(testNamespace, "claims-exact-ip")

		Expect(getClaim(testNamespace, "claims-exact-ip").Status.AssignedIP).To(Equal(testThirdIP))
	})

	It("never substitutes a nearby address for an Exact request it cannot honour", func() {
		createPool("claims-exact-taken", testPoolSpec())
		createClaim(testNamespace, "claims-exact-taken-a", "claims-exact-taken", "")
		reconcileClaim(testNamespace, "claims-exact-taken-a")
		Expect(getClaim(testNamespace, "claims-exact-taken-a").Status.AssignedIP).To(Equal(testFirstIP))

		createClaimWith(testNamespace, "claims-exact-taken-b", ipamv1alpha1.IPClaimSpec{
			PoolRef:    "claims-exact-taken",
			Allocation: &ipamv1alpha1.AddressAllocation{Strategy: ipamv1alpha1.AllocationExact, Address: testFirstIP},
		})
		reconcileClaim(testNamespace, "claims-exact-taken-b")

		got := getClaim(testNamespace, "claims-exact-taken-b")
		Expect(got.Status.AssignedIP).To(BeEmpty())
		Expect(ready(got).Reason).To(Equal(ipamv1alpha1.ReasonAddressUnavailable))
		// The blocker is structured so the reader can go and look at the holder.
		Expect(got.Status.Blockers).To(HaveLen(1))
		Expect(got.Status.Blockers[0].Kind).To(Equal("IPClaim"))
		Expect(got.Status.Blockers[0].Name).To(Equal("claims-exact-taken-a"))
		Expect(got.Status.Blockers[0].Address).To(Equal(testFirstIP))
	})

	It("fails an Exact request outside the band, and one on an excluded address", func() {
		spec := testPoolSpec()
		spec.Exclude = []ipamv1alpha1.IPRange{{Start: testSecondIP, End: testSecondIP}}
		createPool("claims-exact-bounds", spec)

		createClaimWith(testNamespace, "claims-exact-outside", ipamv1alpha1.IPClaimSpec{
			PoolRef:    "claims-exact-bounds",
			Allocation: &ipamv1alpha1.AddressAllocation{Strategy: ipamv1alpha1.AllocationExact, Address: testGateway},
		})
		reconcileClaim(testNamespace, "claims-exact-outside")
		Expect(ready(getClaim(testNamespace, "claims-exact-outside")).Reason).To(Equal(ipamv1alpha1.ReasonAddressOutOfRange))

		createClaimWith(testNamespace, "claims-exact-excluded", ipamv1alpha1.IPClaimSpec{
			PoolRef:    "claims-exact-bounds",
			Allocation: &ipamv1alpha1.AddressAllocation{Strategy: ipamv1alpha1.AllocationExact, Address: testSecondIP},
		})
		reconcileClaim(testNamespace, "claims-exact-excluded")
		Expect(ready(getClaim(testNamespace, "claims-exact-excluded")).Reason).To(Equal(ipamv1alpha1.ReasonAddressExcluded))
	})

	It("refuses an Exact request against a pool that does not accept them", func() {
		spec := testPoolSpec()
		allow := false
		spec.AllowExact = &allow
		createPool("claims-exact-closed", spec)

		createClaimWith(testNamespace, "claims-exact-closed-ip", ipamv1alpha1.IPClaimSpec{
			PoolRef:    "claims-exact-closed",
			Allocation: &ipamv1alpha1.AddressAllocation{Strategy: ipamv1alpha1.AllocationExact, Address: testFirstIP},
		})
		reconcileClaim(testNamespace, "claims-exact-closed-ip")

		got := getClaim(testNamespace, "claims-exact-closed-ip")
		Expect(got.Status.AssignedIP).To(BeEmpty())
		Expect(ready(got).Reason).To(Equal(ipamv1alpha1.ReasonExactNotAllowed))
	})

	It("fails a claim that asks for a NAD against a template-less pool", func() {
		spec := testPoolSpec()
		spec.NADTemplate = nil
		createPool("claims-notemplate", spec)
		createClaim(testNamespace, "claims-notemplate-ip", "claims-notemplate", "claims-notemplate-static")

		reconcileClaim(testNamespace, "claims-notemplate-ip")

		got := getClaim(testNamespace, "claims-notemplate-ip")
		Expect(ready(got).Status).To(Equal(metav1.ConditionFalse))
		// A misconfiguration, not a broken controller: it is the Ready condition's
		// reason, which is where every "no address yet, and here is why" lives.
		Expect(ready(got).Reason).To(Equal(ipamv1alpha1.ReasonTemplateMissing))

		// No address is consumed: a claim that cannot be satisfied must not sit on
		// one of the pool's addresses.
		Expect(got.Status.AssignedIP).To(BeEmpty())
		absent := newNAD(testNamespace, "claims-notemplate-static")
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(absent), absent))).To(BeTrue())
	})

	It("refuses a nad name that belongs to someone else, then takes it once it is free", func() {
		createPool("claims-taken", testPoolSpec())
		createClaim(testNamespace, "claims-taken-ip", "claims-taken", "claims-taken-static")

		// A NAD this project did not create: no ownerReference, and not ours to
		// adopt or overwrite.
		foreign := newNAD(testNamespace, "claims-taken-static")
		Expect(unstructured.SetNestedField(foreign.Object, `{"name":"someone-elses"}`, "spec", "config")).To(Succeed())
		Expect(k8sClient.Create(ctx, foreign)).To(Succeed())
		deleteNAD("claims-taken-static")

		reconcileClaim(testNamespace, "claims-taken-ip")

		got := getClaim(testNamespace, "claims-taken-ip")
		Expect(ready(got).Status).To(Equal(metav1.ConditionFalse))
		Expect(ready(got).Reason).To(Equal(ipamv1alpha1.ReasonNADNotOwned))
		Expect(got.Status.Blockers).To(HaveLen(1))
		Expect(got.Status.Blockers[0].Kind).To(Equal(networkAttachmentDefinitionGVK.Kind))
		Expect(got.Status.Blockers[0].Name).To(Equal("claims-taken-static"))
		// Nothing carries this address — the claim never came to own a NAD — so the
		// reservation goes back to the pool instead of being held by a name collision.
		Expect(got.Status.AssignedIP).To(BeEmpty())

		// And the foreign object is untouched.
		still := getNAD("claims-taken-static")
		config, _, err := unstructured.NestedString(still.Object, "spec", "config")
		Expect(err).NotTo(HaveOccurred())
		Expect(config).To(Equal(`{"name":"someone-elses"}`))

		// Once the squatter goes the claim is satisfiable again. In the binary the NAD
		// watch re-enqueues it; here the second reconcile stands in for that event.
		Expect(k8sClient.Delete(ctx, still)).To(Succeed())
		reconcileClaim(testNamespace, "claims-taken-ip")

		again := getClaim(testNamespace, "claims-taken-ip")
		Expect(ready(again).Status).To(Equal(metav1.ConditionTrue))
		Expect(again.Status.AssignedIP).To(Equal(testFirstIP))
		Expect(getNAD("claims-taken-static").GetLabels()).To(
			HaveKeyWithValue(ipamv1alpha1.LabelClaim, "claims-taken-ip"))
	})

	It("keeps a bound claim's address when exclusions later cover the whole band", func() {
		// Exclusions are prospective: they refuse new allocations, they do not take an
		// address back from a VM whose NAD still carries it.
		createPool("claims-excluded", testPoolSpec())
		createClaim(testNamespace, "claims-excluded-ip", "claims-excluded", "")
		reconcileClaim(testNamespace, "claims-excluded-ip")
		Expect(getClaim(testNamespace, "claims-excluded-ip").Status.AssignedIP).To(Equal(testFirstIP))

		pool := &ipamv1alpha1.IPPool{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: "claims-excluded"}, pool)).To(Succeed())
		spec := testPoolSpec()
		pool.Spec.Exclude = []ipamv1alpha1.IPRange{{Start: spec.Range.Start, End: spec.Range.End}}
		Expect(k8sClient.Update(ctx, pool)).To(Succeed())

		reconcileClaim(testNamespace, "claims-excluded-ip")

		got := getClaim(testNamespace, "claims-excluded-ip")
		Expect(ready(got).Status).To(Equal(metav1.ConditionTrue))
		Expect(got.Status.AssignedIP).To(Equal(testFirstIP))
	})

	It("reserves nothing and writes nothing while its NAD name stays taken", func() {
		// Learning of the collision at create time would leave this claim writing a
		// reservation, then clearing it, on every reconcile — and each of those writes
		// enqueues the claim again, so the loop would feed itself.
		createPool("claims-churn", testPoolSpec())
		createClaim(testNamespace, "claims-churn-ip", "claims-churn", "claims-churn-static")

		foreign := newNAD(testNamespace, "claims-churn-static")
		Expect(unstructured.SetNestedField(foreign.Object, `{"name":"someone-elses"}`, "spec", "config")).To(Succeed())
		Expect(k8sClient.Create(ctx, foreign)).To(Succeed())
		deleteNAD("claims-churn-static")

		reconcileClaim(testNamespace, "claims-churn-ip")
		failed := getClaim(testNamespace, "claims-churn-ip")
		Expect(ready(failed).Reason).To(Equal(ipamv1alpha1.ReasonNADNotOwned))
		Expect(failed.Status.AssignedIP).To(BeEmpty())

		// The second pass must not write at all, and an unchanged resourceVersion is
		// the direct observation of that.
		reconcileClaim(testNamespace, "claims-churn-ip")
		Expect(getClaim(testNamespace, "claims-churn-ip").ResourceVersion).To(Equal(failed.ResourceVersion))
	})

	It("holds a deleting claim until its NAD is gone", func() {
		// The address lives in status, and holders reads it from the claim list. If the
		// claim went first, its NAD would still publish the address while nothing
		// counted it as held.
		createPool("claims-teardown", testPoolSpec())
		createClaim(testNamespace, "claims-teardown-ip", "claims-teardown", "claims-teardown-static")
		deleteNAD("claims-teardown-static")

		reconcileClaim(testNamespace, "claims-teardown-ip")
		Expect(getNAD("claims-teardown-static")).NotTo(BeNil())
		Expect(getClaim(testNamespace, "claims-teardown-ip").Finalizers).To(ContainElement(NADTeardownFinalizer))

		Expect(k8sClient.Delete(ctx, getClaim(testNamespace, "claims-teardown-ip"))).To(Succeed())
		// Still there: the address is still published.
		Expect(getClaim(testNamespace, "claims-teardown-ip").DeletionTimestamp).NotTo(BeNil())

		reconcileClaim(testNamespace, "claims-teardown-ip")

		nad := newNAD(testNamespace, "claims-teardown-static")
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(nad), nad))).To(BeTrue())

		gone := &ipamv1alpha1.IPClaim{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx,
			client.ObjectKey{Namespace: testNamespace, Name: "claims-teardown-ip"}, gone))).To(BeTrue())
	})

	It("does not hold a claim that mints no NAD", func() {
		// An address-only claim publishes its address nowhere but status, so there is no
		// teardown to wait for and deleting it releases the address at once.
		createPool("claims-ledger", testLedgerOnlySpec())
		createClaim(testNamespace, "claims-ledger-ip", "claims-ledger", "")

		reconcileClaim(testNamespace, "claims-ledger-ip")
		Expect(getClaim(testNamespace, "claims-ledger-ip").Finalizers).To(BeEmpty())
	})

	It("keeps a bound claim's address when its NAD name is taken over", func() {
		// The other half of the release rule: an address that was published is never
		// handed back because the NAD stopped being ours. A running VM may still be on
		// it, and the NAD it was given may be gone — but the guest's configuration is
		// not.
		createPool("claims-taken-bound", testPoolSpec())
		createClaim(testNamespace, "claims-taken-bound-ip", "claims-taken-bound", "claims-taken-bound-static")
		reconcileClaim(testNamespace, "claims-taken-bound-ip")
		Expect(getClaim(testNamespace, "claims-taken-bound-ip").Status.AssignedIP).To(Equal(testFirstIP))

		Expect(k8sClient.Delete(ctx, getNAD("claims-taken-bound-static"))).To(Succeed())
		foreign := newNAD(testNamespace, "claims-taken-bound-static")
		Expect(unstructured.SetNestedField(foreign.Object, `{"name":"someone-elses"}`, "spec", "config")).To(Succeed())
		Expect(k8sClient.Create(ctx, foreign)).To(Succeed())
		deleteNAD("claims-taken-bound-static")

		reconcileClaim(testNamespace, "claims-taken-bound-ip")

		got := getClaim(testNamespace, "claims-taken-bound-ip")
		Expect(ready(got).Reason).To(Equal(ipamv1alpha1.ReasonNADNotOwned))
		Expect(got.Status.AssignedIP).To(Equal(testFirstIP))
	})

	It("wakes the claims waiting on a pool when an address is released", func() {
		spec := testPoolSpec()
		// One address, so the second claim has to wait for the first.
		spec.Range = ipamv1alpha1.IPRange{Start: testFirstIP, End: testFirstIP}
		createPool("claims-release", spec)
		createClaim(testNamespace, "claims-release-a", "claims-release", "")
		createClaim(testNamespace, "claims-release-b", "claims-release", "")

		reconcileClaim(testNamespace, "claims-release-a")
		reconcileClaim(testNamespace, "claims-release-b")
		Expect(ready(getClaim(testNamespace, "claims-release-b")).Reason).To(Equal(ipamv1alpha1.ReasonRangeExhausted))

		// Deleting the holder is the event the binary's watch passes to this map
		// function; the second claim has to be in the result or it would stay failed
		// with the address free.
		Expect(k8sClient.Delete(ctx, getClaim(testNamespace, "claims-release-a"))).To(Succeed())

		reqs := reconciled().pendingClaimsForPool(ctx, getClaim(testNamespace, "claims-release-b"))
		Expect(reqs).To(ConsistOf(requestFor(testNamespace, "claims-release-b")))
	})

	It("wakes claims only on events that free an address", func() {
		// Binding and condition rewrites take an address away; reconciling every waiting
		// claim for those would be work that cannot change an outcome.
		bound := &ipamv1alpha1.IPClaim{}
		bound.Status.AssignedIP = testFirstIP
		free := &ipamv1alpha1.IPClaim{}

		p := addressReleased()
		Expect(p.Create(event.CreateEvent{Object: free})).To(BeFalse())
		Expect(p.Generic(event.GenericEvent{Object: bound})).To(BeFalse())
		Expect(p.Update(event.UpdateEvent{ObjectOld: free, ObjectNew: bound})).To(BeFalse())
		Expect(p.Update(event.UpdateEvent{ObjectOld: bound, ObjectNew: bound.DeepCopy()})).To(BeFalse())
		Expect(p.Update(event.UpdateEvent{ObjectOld: bound, ObjectNew: free})).To(BeTrue())
		Expect(p.Delete(event.DeleteEvent{Object: bound})).To(BeTrue())
		Expect(p.Delete(event.DeleteEvent{Object: free})).To(BeFalse())
	})

	It("refuses a status write computed from a stale read", func() {
		// A claim deleted and recreated under the same name while its NAD was being
		// minted must not receive the old claim's address. The resourceVersion is what
		// tells the two apart, so the patch has to carry it.
		claim := createClaim(testNamespace, "claims-stale-ip", "claims-stale", "")
		stale := claim.DeepCopy()

		fresh := getClaim(testNamespace, "claims-stale-ip")
		fresh.Status.AssignedIP = testThirdIP
		Expect(k8sClient.Status().Update(ctx, fresh)).To(Succeed())

		claim.Status.AssignedIP = testFirstIP
		err := patchStatusIfChanged(ctx, k8sClient, stale, claim, stale.Status, claim.Status)
		Expect(apierrors.IsConflict(err)).To(BeTrue(), "expected a conflict, got %v", err)

		// And nothing of the stale write landed.
		Expect(getClaim(testNamespace, "claims-stale-ip").Status.AssignedIP).To(Equal(testThirdIP))
	})

	It("is idempotent when the NAD already exists and is ours", func() {
		createPool("claims-idempotent", testPoolSpec())
		createClaim(testNamespace, "claims-idempotent-ip", "claims-idempotent", "claims-idempotent-static")
		deleteNAD("claims-idempotent-static")

		reconcileClaim(testNamespace, "claims-idempotent-ip")
		first := getNAD("claims-idempotent-static")

		reconcileClaim(testNamespace, "claims-idempotent-ip")
		second := getNAD("claims-idempotent-static")

		Expect(second.GetResourceVersion()).To(Equal(first.GetResourceVersion()))
	})

	It("corrects a NAD whose config has drifted", func() {
		createPool("claims-drift", testPoolSpec())
		createClaim(testNamespace, "claims-drift-ip", "claims-drift", "claims-drift-static")
		deleteNAD("claims-drift-static")

		reconcileClaim(testNamespace, "claims-drift-ip")

		nad := getNAD("claims-drift-static")
		Expect(unstructured.SetNestedField(nad.Object, `{"name":"hand-edited"}`, "spec", "config")).To(Succeed())
		Expect(k8sClient.Update(ctx, nad)).To(Succeed())

		reconcileClaim(testNamespace, "claims-drift-ip")

		repair := getNAD("claims-drift-static")
		ipam, ok := renderedConfig(repair)["ipam"].(map[string]any)
		Expect(ok).To(BeTrue())
		Expect(ipam).To(HaveKeyWithValue("addresses", []any{
			map[string]any{"address": testFirstIP + "/24", "gateway": testGateway},
		}))
	})

	It("recovers once the pool gains a template", func() {
		spec := testPoolSpec()
		spec.NADTemplate = nil
		createPool("claims-recover", spec)
		createClaim(testNamespace, "claims-recover-ip", "claims-recover", "claims-recover-static")
		deleteNAD("claims-recover-static")

		reconcileClaim(testNamespace, "claims-recover-ip")
		Expect(ready(getClaim(testNamespace, "claims-recover-ip")).Reason).To(Equal(ipamv1alpha1.ReasonTemplateMissing))

		pool := &ipamv1alpha1.IPPool{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: "claims-recover"}, pool)).To(Succeed())
		// A complete template: the CRD requires subnet and gateway alongside the
		// bridge, so a pool cannot be half-fixed into minting.
		pool.Spec.NADTemplate = testPoolSpec().NADTemplate
		Expect(k8sClient.Update(ctx, pool)).To(Succeed())

		reconcileClaim(testNamespace, "claims-recover-ip")

		got := getClaim(testNamespace, "claims-recover-ip")
		Expect(ready(got).Status).To(Equal(metav1.ConditionTrue))
		Expect(ready(got).Reason).To(Equal(ipamv1alpha1.ReasonBound))
		Expect(got.Status.AssignedIP).To(Equal(testFirstIP))
	})
})
