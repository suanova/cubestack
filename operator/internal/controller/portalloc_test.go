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

package controller

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// gatedReader is the API server with one gate: afterLists List calls run to
// completion, and only then does the caller stop, still inside its own code,
// until the gate opens. A caller stopped here holds the allocator with its view
// of the pool final and has not yet claimed a number.
type gatedReader struct {
	client.Reader
	afterLists int
	calls      atomic.Int32
	reach      chan struct{}
	release    chan struct{}
}

func (g *gatedReader) List(ctx context.Context, list client.ObjectList, opts ...client.ListOption) error {
	err := g.Reader.List(ctx, list, opts...)
	if int(g.calls.Add(1)) == g.afterLists {
		close(g.reach)
		<-g.release
	}
	return err
}

// watchfulReader records that its caller has begun reading the pool, before the
// read runs: with the allocator held elsewhere the caller never gets that far,
// which is exactly what the spec below observes.
type watchfulReader struct {
	client.Reader
	once sync.Once
	read func()
}

func (w *watchfulReader) List(ctx context.Context, list client.ObjectList, opts ...client.ListOption) error {
	w.once.Do(w.read)
	return w.Reader.List(ctx, list, opts...)
}

// The L4 pool is gateway-wide and has no object of its own: the ListenerSets
// attached to the Gateway are the ledger. Two kinds of environment reconciler
// draw from it side by side, so the allocator's mutex — not either reconciler's
// own concurrency limit — is what keeps a port from being handed to both
// (design §4.9, D-VM4, verification item V-8).
var _ = Describe("portAllocator concurrency", func() {
	// A range no other spec draws from, so what this one leaves in the pool
	// cannot shift the ports they expect.
	const (
		poolStart int32 = 30000
		poolSize  int32 = 100
		// 20 ports per caller, the size V-8 was written at: one ssh and 19 tcp
		// exposures, so the claim is a range of numbers and not one pair that
		// could coincide by luck.
		portsPerCaller = 20
	)

	envNames := []string{"v8-env-a", "v8-env-b"}
	cfg := DevEnvironmentControllerConfig{
		GatewayName:      testDevEnvGatewayName,
		GatewayNamespace: testNamespace,
		L4PortRangeStart: poolStart,
		L4PortRangeEnd:   poolStart + poolSize - 1,
	}
	// The Gateway is only a parent reference for the ListenerSets this spec
	// writes; nothing on it is read.
	gw := &gatewayv1.Gateway{ObjectMeta: metav1.ObjectMeta{Name: testDevEnvGatewayName, Namespace: testNamespace}}

	env := func(envName string) *aiv1alpha1.DevEnvironment {
		ports := make([]aiv1alpha1.PortSpec, 0, portsPerCaller-1)
		for i := range portsPerCaller - 1 {
			ports = append(ports, aiv1alpha1.PortSpec{
				Name:          fmt.Sprintf("metrics-%d", i),
				Type:          aiv1alpha1.PortTypeTCP,
				ContainerPort: int32(9000 + i),
			})
		}
		return &aiv1alpha1.DevEnvironment{
			ObjectMeta: metav1.ObjectMeta{Name: envName, Namespace: testNamespace, UID: types.UID("uid-" + envName)},
			Spec: aiv1alpha1.DevEnvironmentSpec{
				Type:  aiv1alpha1.DevEnvironmentTypeSSH,
				SSH:   &aiv1alpha1.SSHSpec{Enabled: true},
				Ports: ports,
			},
		}
	}
	ledgerOf := func(envName string) *gatewayv1.ListenerSet {
		return &gatewayv1.ListenerSet{ObjectMeta: metav1.ObjectMeta{Name: envName + l4ListenerSetSuffix, Namespace: testNamespace}}
	}
	// One allocator — the instance a manager hands to every kind's reconciler;
	// the two reconcilers differ only in the reader they are given.
	reconciler := func(allocator *portAllocator, reader client.Reader) *DevEnvironmentReconciler {
		return &DevEnvironmentReconciler{
			Client: k8sClient, Scheme: testScheme, Config: cfg, APIReader: reader, ports: allocator,
		}
	}

	AfterEach(func() {
		for _, envName := range envNames {
			Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, ledgerOf(envName)))).To(Succeed())
			routes := &gatewayv1.TCPRouteList{}
			Expect(k8sClient.List(ctx, routes, client.InNamespace(testNamespace), client.MatchingLabels{devEnvironmentLabelKey: envName})).To(Succeed())
			for i := range routes.Items {
				Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, &routes.Items[i]))).To(Succeed())
			}
		}
	})

	It("does not let a second caller read the pool while the first holds it (V-8)", func() {
		allocator := &portAllocator{}
		// The second caller to arrive at the critical section has reached the
		// boundary: from that point on it is asking for the pool, and what it
		// does while the first caller holds it is what this spec is about.
		var arrivals atomic.Int32
		bAtBoundary := make(chan struct{})
		allocator.beforeLock = func() {
			if arrivals.Add(1) == 2 {
				close(bAtBoundary)
			}
		}

		// publishRoutes makes three List calls before it claims anything: the
		// TCPRoute and ListenerSet reads in usedPorts, then the ListenerSet read
		// in heldPorts. Stopping the first caller after the third leaves it
		// holding the pool with every number it saw final.
		readerA := &gatedReader{
			Reader: k8sClient, afterLists: 3, reach: make(chan struct{}), release: make(chan struct{}),
		}
		errA := make(chan error, 1)
		go func() {
			defer GinkgoRecover()
			_, _, _, err := reconciler(allocator, readerA).publishRoutes(ctx, env(envNames[0]), gw)
			errA <- err
		}()
		Eventually(readerA.reach).WithTimeout(10*time.Second).Should(BeClosed(), "the first caller never finished its reads")

		bRead := make(chan struct{})
		readerB := &watchfulReader{Reader: k8sClient, read: func() { close(bRead) }}
		errB := make(chan error, 1)
		go func() {
			defer GinkgoRecover()
			_, _, _, err := reconciler(allocator, readerB).publishRoutes(ctx, env(envNames[1]), gw)
			errB <- err
		}()
		Eventually(bAtBoundary).WithTimeout(10*time.Second).Should(BeClosed(), "the second caller never reached the allocator")

		// The first caller is inside its critical section for this whole window —
		// the gate has not opened — so a read now would be a read of a pool that
		// does not contain its claim yet, and a write would take a number out of
		// it. The second caller may do neither: it cannot so much as begin
		// reading the pool.
		Consistently(func() bool {
			select {
			case <-bRead:
				return false
			default:
				return apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(ledgerOf(envNames[1])), &gatewayv1.ListenerSet{}))
			}
		}, time.Second, 25*time.Millisecond).Should(BeTrue(), "the second caller read or wrote the ledger while the first held the pool")

		close(readerA.release)
		Expect(<-errA).NotTo(HaveOccurred())
		// And it does go on to read once the pool is free — which is what keeps
		// the assertion above from being vacuous by never having got there. Its
		// read now happens after the first caller's claim is stored.
		Eventually(bRead).WithTimeout(10*time.Second).Should(BeClosed(), "the second caller never read the pool after the first released it")
		Expect(<-errB).NotTo(HaveOccurred())

		taken := map[int32]bool{}
		for _, envName := range envNames {
			stored := &gatewayv1.ListenerSet{}
			Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(ledgerOf(envName)), stored)).To(Succeed())
			Expect(stored.Spec.Listeners).To(HaveLen(portsPerCaller), "%s", envName)
			for _, listener := range stored.Spec.Listeners {
				Expect(taken).NotTo(HaveKey(listener.Port), "port %d was handed to both callers", listener.Port)
				taken[listener.Port] = true
			}
		}
		Expect(taken).To(HaveLen(2 * portsPerCaller))
	})

	It("does not reuse a port held by a ledger entry it does not control", func() {
		// The label is not identity: anything in the namespace can carry it. A set
		// it does not control — here one this operator did not write, so with no
		// controller reference — still holds its port, and reading it as this
		// environment's own is what hands the number out twice.
		foreign := &gatewayv1.ListenerSet{
			ObjectMeta: metav1.ObjectMeta{
				Name:      "v8-foreign-l4",
				Namespace: testNamespace,
				Labels:    map[string]string{devEnvironmentLabelKey: envNames[0]},
			},
			Spec: gatewayv1.ListenerSetSpec{
				ParentRef: gatewayv1.ParentGatewayReference{
					Group:     ptrTo(gatewayv1.Group(gatewayAPIGroup)),
					Kind:      ptrTo(gatewayv1.Kind(gatewayKind)),
					Namespace: ptrTo(gatewayv1.Namespace(testNamespace)),
					Name:      gatewayv1.ObjectName(testDevEnvGatewayName),
				},
				Listeners: []gatewayv1.ListenerEntry{{
					Name: "tcp-30000", Protocol: gatewayv1.TCPProtocolType, Port: poolStart,
				}},
			},
		}
		Expect(k8sClient.Create(ctx, foreign)).To(Succeed())
		DeferCleanup(func() {
			Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, foreign))).To(Succeed())
		})

		_, _, _, err := reconciler(&portAllocator{}, k8sClient).publishRoutes(ctx, env(envNames[0]), gw)
		Expect(err).NotTo(HaveOccurred())

		stored := &gatewayv1.ListenerSet{}
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(ledgerOf(envNames[0])), stored)).To(Succeed())
		Expect(stored.Spec.Listeners).To(HaveLen(portsPerCaller))
		for _, listener := range stored.Spec.Listeners {
			Expect(listener.Port).NotTo(Equal(poolStart), "the foreign claim was handed out again")
		}
	})
})
