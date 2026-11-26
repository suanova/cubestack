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

// gatedReader is the API server with one gate: the first List a reconcile makes
// runs to completion, then the reconcile stops there until the test opens the
// gate. usedPorts is the first thing a reconcile does inside the allocator's
// critical section, so a caller stopped here is a caller holding the pool with
// its contents already read.
type gatedReader struct {
	client.Reader
	once  sync.Once
	after func()
}

func (g *gatedReader) List(ctx context.Context, list client.ObjectList, opts ...client.ListOption) error {
	err := g.Reader.List(ctx, list, opts...)
	g.once.Do(g.after)
	return err
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

	// Two L4 ports each — ssh plus one tcp exposure — so the assertion is about
	// the whole claim, not one number that could coincide by luck.
	env := func(envName string) *aiv1alpha1.DevEnvironment {
		return &aiv1alpha1.DevEnvironment{
			ObjectMeta: metav1.ObjectMeta{Name: envName, Namespace: testNamespace, UID: types.UID("uid-" + envName)},
			Spec: aiv1alpha1.DevEnvironmentSpec{
				Type:  aiv1alpha1.DevEnvironmentTypeSSH,
				SSH:   &aiv1alpha1.SSHSpec{Enabled: true},
				Ports: []aiv1alpha1.PortSpec{{Name: "metrics", Type: aiv1alpha1.PortTypeTCP, ContainerPort: 9090}},
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

	It("does not let a second caller claim a port while the first holds the pool (V-8)", func() {
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

		aRead := make(chan struct{})
		releaseA := make(chan struct{})
		readerA := &gatedReader{Reader: k8sClient, after: func() {
			close(aRead)
			<-releaseA
		}}
		errA := make(chan error, 1)
		go func() {
			defer GinkgoRecover()
			_, _, _, err := reconciler(allocator, readerA).publishRoutes(ctx, env(envNames[0]), gw)
			errA <- err
		}()
		Eventually(aRead).WithTimeout(10*time.Second).Should(BeClosed(), "the first caller never entered the allocator")

		errB := make(chan error, 1)
		go func() {
			defer GinkgoRecover()
			_, _, _, err := reconciler(allocator, k8sClient).publishRoutes(ctx, env(envNames[1]), gw)
			errB <- err
		}()
		Eventually(bAtBoundary).WithTimeout(10*time.Second).Should(BeClosed(), "the second caller never reached the allocator")
		// The first caller's read is already stale by definition while it is
		// still here: a claim written now would take a port out of a pool that
		// did not contain the first caller's numbers. Nothing may land until
		// the first caller lets go.
		Consistently(func() bool {
			return apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(ledgerOf(envNames[1])), &gatewayv1.ListenerSet{}))
		}, time.Second, 50*time.Millisecond).Should(BeTrue(), "the second caller wrote its claim while the first held the pool")

		close(releaseA)
		Expect(<-errA).NotTo(HaveOccurred())
		Expect(<-errB).NotTo(HaveOccurred())

		taken := map[int32]bool{}
		for _, envName := range envNames {
			stored := &gatewayv1.ListenerSet{}
			Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(ledgerOf(envName)), stored)).To(Succeed())
			Expect(stored.Spec.Listeners).To(HaveLen(2), "%s", envName)
			for _, listener := range stored.Spec.Listeners {
				Expect(taken).NotTo(HaveKey(listener.Port), "port %d was handed to both callers", listener.Port)
				taken[listener.Port] = true
			}
		}
		Expect(taken).To(HaveLen(4))
	})
})
