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
	"fmt"
	"sync"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

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
	)

	cfg := portPoolConfig{
		GatewayName:      testDevEnvGatewayName,
		GatewayNamespace: testNamespace,
		L4PortRangeStart: poolStart,
		L4PortRangeEnd:   poolStart + poolSize - 1,
	}
	parent := gatewayv1.ParentGatewayReference{
		Group:     ptrTo(gatewayv1.Group(gatewayAPIGroup)),
		Kind:      ptrTo(gatewayv1.Kind(gatewayKind)),
		Namespace: ptrTo(gatewayv1.Namespace(testNamespace)),
		Name:      gatewayv1.ObjectName(testDevEnvGatewayName),
	}
	ledgerName := func(envName string) string { return envName + l4ListenerSetSuffix }

	// draw takes count ports the way a reconcile does: inside the allocator,
	// read the pool, allocate, then write the ListenerSet that claims the
	// numbers. The read and the write are one critical section — that is the
	// whole property under test.
	draw := func(a *portAllocator, envName string, count int) ([]int32, error) {
		ports := make([]int32, 0, count)
		err := a.locked(func() error {
			used, err := a.usedPorts(ctx, k8sClient, cfg, testNamespace, client.MatchingLabels{devEnvironmentLabelKey: envName})
			if err != nil {
				return err
			}
			listeners := make([]gatewayv1.ListenerEntry, 0, count)
			for i := range count {
				name := fmt.Sprintf("port-%d", i)
				p := a.allocatePort(cfg, name, used, nil)
				if p == 0 {
					return fmt.Errorf("no free port in the L4 port range %d-%d", cfg.L4PortRangeStart, cfg.L4PortRangeEnd)
				}
				ports = append(ports, p)
				listeners = append(listeners, gatewayv1.ListenerEntry{
					Name:     gatewayv1.SectionName(l4ListenerName(name, gatewayv1.TCPProtocolType, p)),
					Protocol: gatewayv1.TCPProtocolType,
					Port:     p,
				})
			}
			return k8sClient.Create(ctx, &gatewayv1.ListenerSet{
				ObjectMeta: metav1.ObjectMeta{
					Name:      ledgerName(envName),
					Namespace: testNamespace,
					Labels:    map[string]string{devEnvironmentLabelKey: envName},
				},
				Spec: gatewayv1.ListenerSetSpec{ParentRef: parent, Listeners: listeners},
			})
		})
		return ports, err
	}

	AfterEach(func() {
		for _, envName := range []string{"v8-env-a", "v8-env-b"} {
			ls := &gatewayv1.ListenerSet{ObjectMeta: metav1.ObjectMeta{Name: ledgerName(envName), Namespace: testNamespace}}
			Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, ls))).To(Succeed())
		}
	})

	It("gives two callers allocating at the same instant no duplicate ports (V-8)", func() {
		// One allocator — the instance a manager hands to every kind's
		// reconciler. Both callers start from the same empty pool.
		allocator := &portAllocator{}
		names := []string{"v8-env-a", "v8-env-b"}
		ports := make([][]int32, len(names))
		errs := make([]error, len(names))

		var wg sync.WaitGroup
		for i, name := range names {
			wg.Add(1)
			go func(i int, name string) {
				defer GinkgoRecover()
				defer wg.Done()
				ports[i], errs[i] = draw(allocator, name, 20)
			}(i, name)
		}
		wg.Wait()

		for _, err := range errs {
			Expect(err).NotTo(HaveOccurred())
		}
		taken := map[int32]bool{}
		for i, allocated := range ports {
			Expect(allocated).To(HaveLen(20), "caller %d", i)
			for _, p := range allocated {
				Expect(taken).NotTo(HaveKey(p), "port %d was handed to two callers", p)
				taken[p] = true
			}
		}
		Expect(taken).To(HaveLen(40))
	})
})
