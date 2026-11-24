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

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	ipamv1alpha1 "github.com/suanova/cubestack/api/ipam/v1alpha1"
)

var _ = Describe("IPPool Controller", func() {
	reconcilePool := func(name string) {
		r := &IPPoolReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: name}})
		ExpectWithOffset(1, err).NotTo(HaveOccurred())
	}

	conditionOf := func(name string) *metav1.Condition {
		pool := &ipamv1alpha1.IPPool{}
		ExpectWithOffset(1, k8sClient.Get(ctx, types.NamespacedName{Name: name}, pool)).To(Succeed())
		return apimeta.FindStatusCondition(pool.Status.Conditions, ipamv1alpha1.ConditionAvailable)
	}

	It("publishes Available=True for a usable pool", func() {
		createPool("pool-valid", testPoolSpec())
		reconcilePool("pool-valid")

		available := conditionOf("pool-valid")
		Expect(available).NotTo(BeNil())
		Expect(available.Status).To(Equal(metav1.ConditionTrue))
		Expect(available.Reason).To(Equal(ipamv1alpha1.ReasonRangeValid))
	})

	It("accepts a pool with no nadTemplate", func() {
		// A pool need not serve claims that ask for a NAD, so this is a valid pool
		// and must not be reported as broken. It is also the minimal form of the
		// API: a band with no subnet and no gateway, because it mints nothing.
		createPool("pool-no-template", testLedgerOnlySpec())
		reconcilePool("pool-no-template")

		available := conditionOf("pool-no-template")
		Expect(available).NotTo(BeNil())
		Expect(available.Status).To(Equal(metav1.ConditionTrue))
		Expect(available.Reason).To(Equal(ipamv1alpha1.ReasonRangeValid))
		// The message must not name a subnet the pool does not have.
		Expect(available.Message).NotTo(ContainSubstring("subnet"))
	})

	It("publishes Available=False when the gateway falls inside the range", func() {
		// The one invariant the CRD cannot express: the CEL net library has no
		// ordering overload on IP values, so "gateway is outside the band" is
		// enforced only here — and this condition is the only place a user sees it.
		spec := testPoolSpec()
		spec.NADTemplate.Gateway = testSecondIP
		createPool("pool-gateway-inside", spec)
		reconcilePool("pool-gateway-inside")

		available := conditionOf("pool-gateway-inside")
		Expect(available).NotTo(BeNil())
		Expect(available.Status).To(Equal(metav1.ConditionFalse))
		Expect(available.Reason).To(Equal(ipamv1alpha1.ReasonRangeInvalid))
		Expect(available.Message).To(ContainSubstring("gateway"))
	})

	It("publishes Available=False when the gateway is off-subnet", func() {
		// A gateway in another subnet is outside the band, so the range check alone
		// would pass it — and bridge binding cannot reach it.
		spec := testPoolSpec()
		spec.NADTemplate.Gateway = "10.66.9.254"
		createPool("pool-gateway-offsubnet", spec)
		reconcilePool("pool-gateway-offsubnet")

		available := conditionOf("pool-gateway-offsubnet")
		Expect(available).NotTo(BeNil())
		Expect(available.Status).To(Equal(metav1.ConditionFalse))
		Expect(available.Reason).To(Equal(ipamv1alpha1.ReasonRangeInvalid))
		Expect(available.Message).To(ContainSubstring("must lie within subnet"))
	})

	It("publishes Available=False under its own reason when the exclusions cover the range", func() {
		// Well formed and merely empty, so it must not read as a malformed pool: the fix
		// is a wider range or narrower exclusions, not a corrected field.
		spec := testPoolSpec()
		spec.Exclude = []ipamv1alpha1.IPRange{{Start: testFirstIP, End: testThirdIP}}
		createPool("pool-all-excluded", spec)
		reconcilePool("pool-all-excluded")

		available := conditionOf("pool-all-excluded")
		Expect(available).NotTo(BeNil())
		Expect(available.Status).To(Equal(metav1.ConditionFalse))
		Expect(available.Reason).To(Equal(ipamv1alpha1.ReasonRangeFullyExcluded))
	})

	It("does not rewrite status when nothing changed", func() {
		// The reconcilers do not requeue on success, so an unconditional status
		// write would be the only thing generating further reconciles. Counted
		// directly rather than inferred from LastTransitionTime: the API preserves
		// that timestamp when the condition's status is unchanged, so an assertion on
		// it passes even if a patch was sent.
		createPool("pool-idempotent", testPoolSpec())
		reconcilePool("pool-idempotent")

		counted := &statusPatchCounter{Client: k8sClient}
		r := &IPPoolReconciler{Client: counted, Scheme: k8sClient.Scheme()}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "pool-idempotent"}})
		Expect(err).NotTo(HaveOccurred())

		Expect(counted.patches).To(BeZero())
	})
})

// statusPatchCounter wraps a client to count status patch calls, which is the only
// direct observation of "the reconciler wrote nothing".
type statusPatchCounter struct {
	client.Client
	patches int
}

func (c *statusPatchCounter) Status() client.StatusWriter {
	return &countingStatusWriter{StatusWriter: c.Client.Status(), counter: c}
}

type countingStatusWriter struct {
	client.StatusWriter
	counter *statusPatchCounter
}

func (w *countingStatusWriter) Patch(ctx context.Context, obj client.Object, patch client.Patch, opts ...client.SubResourcePatchOption) error {
	w.counter.patches++
	return w.StatusWriter.Patch(ctx, obj, patch, opts...)
}
