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
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The three fields that define a binding — spec.poolRef, spec.nad and
// spec.allocation — are writable until an address is assigned and refused by the
// CRD afterwards. The refusal is tested against a real API server because it is
// an x-kubernetes-validations rule involving oldSelf and the status subresource;
// nothing client-side evaluates it.
const (
	bindingNamespace = "default"
	bindingPool      = "binding-pool"
	bindingAddress   = "10.66.3.221"
	bindingNAD       = "binding-nad"
	bindingPoolAlt   = "binding-pool-alt"
)

// newClaim creates a claim that asks for a specific address and names a NAD, so
// that every one of the three bounded fields carries a value the specs can change.
func newClaim(name string) *IPClaim {
	claim := &IPClaim{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: bindingNamespace},
		Spec: IPClaimSpec{
			PoolRef:    bindingPool,
			NAD:        bindingNAD,
			Allocation: &AddressAllocation{Strategy: AllocationExact, Address: bindingAddress},
		},
	}
	Expect(k8sClient.Create(ctx, claim)).To(Succeed())
	DeferCleanup(func() { _ = k8sClient.Delete(ctx, claim) })
	return claim
}

// bind writes the status an allocator would write. The rule under test keys on
// exactly this field.
func bind(claim *IPClaim) {
	claim.Status.AssignedIP = bindingAddress
	Expect(k8sClient.Status().Update(ctx, claim)).To(Succeed())
}

func expectImmutable(err error) {
	Expect(err).To(HaveOccurred())
	Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected an Invalid error, got %v", err)
	Expect(err.Error()).To(ContainSubstring("immutable once status.assignedIP is set"))
}

var _ = Describe("IPClaim binding rule", func() {
	It("refuses a poolRef change once an address is bound", func() {
		claim := newClaim("repoint")
		bind(claim)

		claim.Spec.PoolRef = bindingPoolAlt
		expectImmutable(k8sClient.Update(ctx, claim))
	})

	It("refuses a nad change once an address is bound", func() {
		claim := newClaim("rename-nad")
		bind(claim)

		claim.Spec.NAD = bindingNAD + "-2"
		expectImmutable(k8sClient.Update(ctx, claim))
	})

	It("refuses an allocation change once an address is bound", func() {
		claim := newClaim("reallocate")
		bind(claim)

		claim.Spec.Allocation.Address = "10.66.3.222"
		expectImmutable(k8sClient.Update(ctx, claim))
	})

	It("accepts all three changes before an address is bound", func() {
		claim := newClaim("typo")

		claim.Spec.PoolRef = bindingPoolAlt
		claim.Spec.NAD = bindingNAD + "-2"
		claim.Spec.Allocation.Strategy = AllocationAuto
		claim.Spec.Allocation.Address = ""
		Expect(k8sClient.Update(ctx, claim)).To(Succeed())
	})

	// The controller writes the condition and the address while the claim is
	// bound, so the rule must not fire on a status-only update. A rule that
	// compared the whole object — or one that ran before defaulting — would.
	It("accepts a status update once an address is bound", func() {
		claim := newClaim("status-only")
		bind(claim)

		claim.Status.Conditions = []metav1.Condition{{
			Type:               ConditionReady,
			Status:             metav1.ConditionTrue,
			Reason:             "Bound",
			LastTransitionTime: metav1.Now(),
			ObservedGeneration: claim.Generation,
		}}
		Expect(k8sClient.Status().Update(ctx, claim)).To(Succeed())
	})
})
