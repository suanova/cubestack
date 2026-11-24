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

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	ipamv1alpha1 "github.com/suanova/cubestack/api/ipam/v1alpha1"
)

const (
	// schemaCheckName prefixes every generated object name in these specs, so a
	// leak is recognisable as this suite's.
	schemaCheckName = "schema-check-"
	// anyPool is a poolRef the schema accepts and no reconciler ever reads: these
	// specs are about admission, not allocation.
	anyPool = "any"
)

// These specs cover the CRD schema itself, not the reconciler.
//
// The IPPool schema carries CEL rules for subnet containment. The Kubernetes CEL
// net library does NOT define ordering overloads on IP values, so a well-meaning
// "start <= end" rule is silently un-writable — it fails only when the CRD is
// installed, which surfaces as every spec in this package failing at BeforeSuite
// with a wall of CEL compiler output. That is a bad way to learn about it. These
// specs assert the rules that DO exist are present and actually enforced, so an
// invalid future rule fails here with a legible message.
//
// The ordering and gateway invariants that CEL cannot express are covered by
// ipamutil.ValidatePoolRange and its unit tests.
var _ = Describe("IPPool schema validation", func() {
	ctx := context.Background()

	newPool := func(mutate func(*ipamv1alpha1.IPPoolSpec)) *ipamv1alpha1.IPPool {
		spec := ipamv1alpha1.IPPoolSpec{
			Range: ipamv1alpha1.IPRange{Start: testFirstIP, End: "10.66.3.189"},
			NADTemplate: &ipamv1alpha1.NADTemplate{
				Subnet:  "10.66.3.0/24",
				Gateway: "10.66.3.254",
				Bridge:  "br0",
			},
		}
		mutate(&spec)
		return &ipamv1alpha1.IPPool{
			ObjectMeta: metav1.ObjectMeta{GenerateName: schemaCheckName},
			Spec:       spec,
		}
	}

	// rejected asserts the object was refused by schema validation of the field named.
	//
	// NotTo(Succeed()) alone also passes on a timeout, a broken connection, or a rule
	// that was silently dropped from the CRD — so a spec meant to pin a rule could go
	// green while the rule was gone. The field in the status cause is what pins it.
	rejected := func(err error, field string) {
		ExpectWithOffset(1, err).To(HaveOccurred())
		ExpectWithOffset(1, apierrors.IsInvalid(err)).To(BeTrue(), "expected an Invalid error, got %v", err)

		var statusErr *apierrors.StatusError
		ExpectWithOffset(1, errors.As(err, &statusErr)).To(BeTrue())
		fields := make([]string, 0, len(statusErr.ErrStatus.Details.Causes))
		for _, cause := range statusErr.ErrStatus.Details.Causes {
			fields = append(fields, cause.Field)
		}
		ExpectWithOffset(1, fields).To(ContainElement(ContainSubstring(field)))
	}

	It("accepts the band the design proposes", func() {
		pool := newPool(func(*ipamv1alpha1.IPPoolSpec) {})
		Expect(k8sClient.Create(ctx, pool)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, pool) })
	})

	It("rejects a range outside the subnet", func() {
		pool := newPool(func(s *ipamv1alpha1.IPPoolSpec) {
			s.Range = ipamv1alpha1.IPRange{Start: "10.66.9.10", End: "10.66.9.20"}
		})
		err := k8sClient.Create(ctx, pool)
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("must lie within the nadTemplate subnet"))
	})

	It("rejects a gateway that is not an address", func() {
		pool := newPool(func(s *ipamv1alpha1.IPPoolSpec) { s.NADTemplate.Gateway = "not-an-ip" })
		rejected(k8sClient.Create(ctx, pool), "spec.nadTemplate.gateway")
	})

	It("rejects an IPClaim with no poolRef", func() {
		claim := &ipamv1alpha1.IPClaim{
			ObjectMeta: metav1.ObjectMeta{GenerateName: schemaCheckName, Namespace: testNamespace},
			Spec:       ipamv1alpha1.IPClaimSpec{},
		}
		rejected(k8sClient.Create(ctx, claim), "spec.poolRef")
	})

	// The minimal form: a band and nothing else. Nothing mints from this pool, so
	// it needs no subnet and no gateway, and the CRD must not demand them.
	It("accepts a pool with no nadTemplate", func() {
		pool := newPool(func(s *ipamv1alpha1.IPPoolSpec) { s.NADTemplate = nil })
		Expect(k8sClient.Create(ctx, pool)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, pool) })
	})

	// A pool must declare a usable band; it is the one field with no default. (The
	// typed client always serialises range, so this exercises the bound patterns
	// rather than the required-ness of the field itself.)
	It("rejects a pool whose range bounds are empty", func() {
		pool := newPool(func(s *ipamv1alpha1.IPPoolSpec) { s.Range = ipamv1alpha1.IPRange{} })
		rejected(k8sClient.Create(ctx, pool), "spec.range")
	})

	// The nadTemplate is typed precisely so that this class of mistake is caught
	// here instead of surfacing as a VM stuck in FailedCreatePodSandBox. Subnet and
	// gateway are required for the same reason: a template is all-or-nothing, which
	// is what removes the need for a cross-field rule saying so.
	It("rejects a nadTemplate with no bridge", func() {
		pool := newPool(func(s *ipamv1alpha1.IPPoolSpec) { s.NADTemplate.Bridge = "" })
		rejected(k8sClient.Create(ctx, pool), "spec.nadTemplate.bridge")
	})

	It("rejects a nadTemplate with no subnet", func() {
		pool := newPool(func(s *ipamv1alpha1.IPPoolSpec) { s.NADTemplate.Subnet = "" })
		rejected(k8sClient.Create(ctx, pool), "spec.nadTemplate.subnet")
	})

	It("rejects a nadTemplate with no gateway", func() {
		pool := newPool(func(s *ipamv1alpha1.IPPoolSpec) { s.NADTemplate.Gateway = "" })
		rejected(k8sClient.Create(ctx, pool), "spec.nadTemplate.gateway")
	})

	It("rejects a subnet that is not a CIDR", func() {
		pool := newPool(func(s *ipamv1alpha1.IPPoolSpec) { s.NADTemplate.Subnet = "10.66.3.0" })
		rejected(k8sClient.Create(ctx, pool), "spec.nadTemplate.subnet")
	})

	It("rejects a VLAN outside the 802.1Q range", func() {
		vlan := int32(9999)
		pool := newPool(func(s *ipamv1alpha1.IPPoolSpec) { s.NADTemplate.VLAN = &vlan })
		rejected(k8sClient.Create(ctx, pool), "spec.nadTemplate.vlan")
	})

	It("rejects an unknown CNI plugin type", func() {
		pool := newPool(func(s *ipamv1alpha1.IPPoolSpec) { s.NADTemplate.Type = "sriov" })
		rejected(k8sClient.Create(ctx, pool), "spec.nadTemplate.type")
	})

	It("rejects an IPClaim whose nad is not a DNS subdomain", func() {
		claim := &ipamv1alpha1.IPClaim{
			ObjectMeta: metav1.ObjectMeta{GenerateName: schemaCheckName, Namespace: testNamespace},
			Spec:       ipamv1alpha1.IPClaimSpec{PoolRef: anyPool, NAD: "Not_A_Name"},
		}
		rejected(k8sClient.Create(ctx, claim), "spec.nad")
	})

	// The one allocation rule CEL can express: an address belongs to the Exact
	// strategy and nowhere else. It is here rather than in Go because a typo in the
	// strategy must not silently degrade into "allocate anything".
	It("rejects an address without strategy Exact", func() {
		claim := &ipamv1alpha1.IPClaim{
			ObjectMeta: metav1.ObjectMeta{GenerateName: schemaCheckName, Namespace: testNamespace},
			Spec: ipamv1alpha1.IPClaimSpec{
				PoolRef:    anyPool,
				Allocation: &ipamv1alpha1.AddressAllocation{Address: testFirstIP},
			},
		}
		err := k8sClient.Create(ctx, claim)
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("address may only be set when strategy is Exact"))
	})

	It("rejects an Exact allocation with no address", func() {
		claim := &ipamv1alpha1.IPClaim{
			ObjectMeta: metav1.ObjectMeta{GenerateName: schemaCheckName, Namespace: testNamespace},
			Spec: ipamv1alpha1.IPClaimSpec{
				PoolRef:    anyPool,
				Allocation: &ipamv1alpha1.AddressAllocation{Strategy: ipamv1alpha1.AllocationExact},
			},
		}
		err := k8sClient.Create(ctx, claim)
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("strategy Exact requires address"))
	})

	It("rejects an unknown allocation strategy", func() {
		claim := &ipamv1alpha1.IPClaim{
			ObjectMeta: metav1.ObjectMeta{GenerateName: schemaCheckName, Namespace: testNamespace},
			Spec: ipamv1alpha1.IPClaimSpec{
				PoolRef:    anyPool,
				Allocation: &ipamv1alpha1.AddressAllocation{Strategy: "Maybe"},
			},
		}
		rejected(k8sClient.Create(ctx, claim), "spec.allocation.strategy")
	})

	It("accepts an Exact allocation", func() {
		claim := &ipamv1alpha1.IPClaim{
			ObjectMeta: metav1.ObjectMeta{GenerateName: schemaCheckName, Namespace: testNamespace},
			Spec: ipamv1alpha1.IPClaimSpec{
				PoolRef:    anyPool,
				Allocation: &ipamv1alpha1.AddressAllocation{Strategy: ipamv1alpha1.AllocationExact, Address: testFirstIP},
			},
		}
		Expect(k8sClient.Create(ctx, claim)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, claim) })

		// The strategy defaults to Auto when omitted, which is what makes an empty
		// allocation block identical to no allocation at all.
		bare := &ipamv1alpha1.IPClaim{
			ObjectMeta: metav1.ObjectMeta{GenerateName: schemaCheckName, Namespace: testNamespace},
			Spec:       ipamv1alpha1.IPClaimSpec{PoolRef: anyPool, Allocation: &ipamv1alpha1.AddressAllocation{}},
		}
		Expect(k8sClient.Create(ctx, bare)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, bare) })
		Expect(bare.Spec.Allocation.Strategy).To(Equal(ipamv1alpha1.AllocationAuto))
	})
})
