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
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	ipamv1alpha1 "github.com/suanova/cubestack/api/ipam/v1alpha1"
)

// The band the design proposes for the 10.66.3.0/24 underlay (design §10.3): three
// addresses, which is enough to observe lowest-first allocation, the taken set and
// exhaustion without a large fixture.
const (
	// testNamespace is where every claim in these specs lives unless the spec is
	// itself about the pool's namespace gate.
	testNamespace = "default"
	testSubnet    = "10.66.3.0/24"
	testGateway   = "10.66.3.254"
	testFirstIP   = "10.66.3.150"
	testSecondIP  = "10.66.3.151"
	testThirdIP   = "10.66.3.152"
)

// testPoolSpec is a pool that can mint NADs and admits the claims' namespace.
//
// Both halves are spelled out rather than left to a default: a pool with no
// nadTemplate mints nothing, and a pool with no spec.namespaces admits nobody, so
// omitting either would turn a test about allocation into a test about a refusal.
func testPoolSpec() ipamv1alpha1.IPPoolSpec {
	return ipamv1alpha1.IPPoolSpec{
		Range:      ipamv1alpha1.IPRange{Start: testFirstIP, End: testThirdIP},
		Namespaces: []string{testNamespace},
		NADTemplate: &ipamv1alpha1.NADTemplate{
			Subnet:  testSubnet,
			Gateway: testGateway,
			Bridge:  "br0",
			DNS:     &ipamv1alpha1.NADDNS{Nameservers: []string{testGateway}},
			Routes:  []ipamv1alpha1.NADRoute{{Dst: "0.0.0.0/0", GW: testGateway}},
		},
	}
}

// testLedgerOnlySpec is the minimal pool: a band and nothing else. It allocates
// addresses and mints no NAD, which is why it needs no subnet and no gateway.
func testLedgerOnlySpec() ipamv1alpha1.IPPoolSpec {
	return ipamv1alpha1.IPPoolSpec{
		Range:      ipamv1alpha1.IPRange{Start: testFirstIP, End: testThirdIP},
		Namespaces: []string{testNamespace},
	}
}

// createPool creates a cluster-scoped pool and removes it when the spec ends.
func createPool(name string, spec ipamv1alpha1.IPPoolSpec) {
	pool := &ipamv1alpha1.IPPool{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec:       spec,
	}
	ExpectWithOffset(1, k8sClient.Create(ctx, pool)).To(Succeed())
	DeferCleanup(func() {
		ExpectWithOffset(1, client.IgnoreNotFound(k8sClient.Delete(ctx, pool))).To(Succeed())
	})
}

// createClaim creates an address-only or NAD-minting claim in the given namespace,
// and removes it when the spec ends. It returns the object as created, so callers
// can reconcile it.
func createClaim(namespace, name, pool, nad string) *ipamv1alpha1.IPClaim {
	return createClaimWith(namespace, name, ipamv1alpha1.IPClaimSpec{PoolRef: pool, NAD: nad})
}

// createClaimWith is createClaim for a spec that is more than a pool and a NAD
// name — an Exact request, most often.
func createClaimWith(namespace, name string, spec ipamv1alpha1.IPClaimSpec) *ipamv1alpha1.IPClaim {
	claim := &ipamv1alpha1.IPClaim{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
		Spec:       spec,
	}
	ExpectWithOffset(1, k8sClient.Create(ctx, claim)).To(Succeed())
	DeferCleanup(func() {
		ExpectWithOffset(1, client.IgnoreNotFound(k8sClient.Delete(ctx, claim))).To(Succeed())
	})
	return claim
}

// createNamespace creates a namespace and removes it when the spec ends. Needed by
// the pool's admission check, which is about namespaces that are NOT the suite's
// default.
func createNamespace(name string) {
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}}
	ExpectWithOffset(1, k8sClient.Create(ctx, ns)).To(Succeed())
	DeferCleanup(func() {
		ExpectWithOffset(1, client.IgnoreNotFound(k8sClient.Delete(ctx, ns))).To(Succeed())
	})
}

// deleteNAD removes a NAD. Nothing else does: envtest runs no garbage collector,
// so an ownerReference does not collect anything here.
func deleteNAD(name string) {
	nad := newNAD(testNamespace, name)
	DeferCleanup(func() {
		ExpectWithOffset(1, client.IgnoreNotFound(k8sClient.Delete(ctx, nad))).To(Succeed())
	})
}

// getNAD reads a NAD and fails the spec if it is absent.
func getNAD(name string) *unstructured.Unstructured {
	nad := newNAD(testNamespace, name)
	ExpectWithOffset(1, k8sClient.Get(ctx, client.ObjectKeyFromObject(nad), nad)).To(Succeed())
	return nad
}

// getClaim reads a claim, so assertions run against what the API server holds
// rather than against the in-memory object the reconciler mutated.
func getClaim(namespace, name string) *ipamv1alpha1.IPClaim {
	claim := &ipamv1alpha1.IPClaim{}
	ExpectWithOffset(1, k8sClient.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, claim)).To(Succeed())
	return claim
}

// requestFor builds the reconcile request for a namespaced object.
func requestFor(namespace, name string) reconcile.Request {
	return reconcile.Request{NamespacedName: types.NamespacedName{Namespace: namespace, Name: name}}
}
