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
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aigwv1beta1 "github.com/envoyproxy/ai-gateway/api/v1beta1"
	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// testRouteWatchName is the owner-fixture name of the catalog-object mapFunc
// spec.
const testRouteWatchName = "svc-route-watch"

var _ = Describe("HTTPRoute CRD", func() {
	It("creates and reads an HTTPRoute", func() {
		route := &gatewayv1.HTTPRoute{
			ObjectMeta: metav1.ObjectMeta{Name: "route-smoke", Namespace: testNamespace},
			Spec: gatewayv1.HTTPRouteSpec{
				CommonRouteSpec: gatewayv1.CommonRouteSpec{
					ParentRefs: []gatewayv1.ParentReference{{Name: "platform", Namespace: ptrTo(gatewayv1.Namespace("cubestack-system"))}},
				},
				Hostnames: []gatewayv1.Hostname{"model.example.com"},
				Rules: []gatewayv1.HTTPRouteRule{{
					BackendRefs: []gatewayv1.HTTPBackendRef{{
						BackendRef: gatewayv1.BackendRef{
							BackendObjectReference: gatewayv1.BackendObjectReference{Name: "svc-router", Port: ptrTo(gatewayv1.PortNumber(8001))},
						},
					}},
				}},
			},
		}
		Expect(k8sClient.Create(ctx, route)).To(Succeed())
		got := &gatewayv1.HTTPRoute{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: route.Name, Namespace: testNamespace}, got)).To(Succeed())
		Expect(got.Spec.Hostnames).To(Equal([]gatewayv1.Hostname{"model.example.com"}))
		Expect(k8sClient.Delete(ctx, route)).To(Succeed())
	})
})

var _ = Describe("enqueueForOwnedCatalogObject", func() {
	It("maps an owned catalog object to its InferenceService and ignores foreign ones", func() {
		owner := &aiv1alpha1.InferenceService{
			ObjectMeta: metav1.ObjectMeta{Name: testRouteWatchName, Namespace: testNamespace},
			Spec:       aiv1alpha1.InferenceServiceSpec{ModelRef: testModelRef, ProfileRef: testWatchProfile},
		}
		Expect(k8sClient.Create(ctx, owner)).To(Succeed())
		route := &aigwv1beta1.AIGatewayRoute{
			ObjectMeta: metav1.ObjectMeta{
				Name:      "svc-route-watch-route",
				Namespace: testNamespace,
				OwnerReferences: []metav1.OwnerReference{{
					APIVersion: "ai.cubestack.io/v1alpha1", Kind: inferenceServiceKind,
					Name: testRouteWatchName, UID: owner.UID, Controller: ptrTo(true),
				}},
			},
		}
		r := routeReconciler()
		reqs := r.enqueueForOwnedCatalogObject(ctx, route)
		Expect(reqs).To(Equal([]reconcile.Request{{NamespacedName: types.NamespacedName{Namespace: testNamespace, Name: testRouteWatchName}}}))
		// A controller owner of the same Kind from another API group must not
		// be treated as one of our services.
		foreign := route.DeepCopy()
		foreign.Name = "other-route"
		foreign.OwnerReferences = []metav1.OwnerReference{{
			APIVersion: "other.example.io/v1", Kind: inferenceServiceKind,
			Name: "svc-route-watch", UID: owner.UID, Controller: ptrTo(true),
		}}
		Expect(r.enqueueForOwnedCatalogObject(ctx, foreign)).To(BeEmpty())
	})
})

var _ = Describe("enqueueForSharedCatalogRoute", func() {
	It("maps the shared catalog route to every published service and ignores other routes", func() {
		// The index backs this map: the suite registers it before the specs run.
		published := &aiv1alpha1.InferenceService{
			ObjectMeta: metav1.ObjectMeta{Name: "shared-pub", Namespace: testNamespace},
			Spec: aiv1alpha1.InferenceServiceSpec{
				ModelRef: testModelRef, ProfileRef: testWatchProfile,
				Route: &aiv1alpha1.RouteSpec{Publish: true, ModelName: "shared-pub-model"},
			},
		}
		unpublished := &aiv1alpha1.InferenceService{
			ObjectMeta: metav1.ObjectMeta{Name: "shared-unpub", Namespace: testNamespace},
			Spec:       aiv1alpha1.InferenceServiceSpec{ModelRef: testModelRef, ProfileRef: testWatchProfile},
		}
		Expect(k8sClient.Create(ctx, published)).To(Succeed())
		Expect(k8sClient.Create(ctx, unpublished)).To(Succeed())

		// The map lists through the cache index, so the reconciler must use the
		// manager's cache client (where registerSharedIndexes ran), not the
		// direct k8sClient, which would ignore MatchingFields and return every
		// service.
		r := routeReconciler()
		r.Client = testMgr.GetClient()
		// The index is read from the cache, which lags the direct client: wait
		// until it observes the published service. Other specs in the shared
		// envtest cluster may have left published services behind, so the index
		// is not expected to hold exactly one entry — only membership is
		// asserted below.
		Eventually(func() bool {
			var list aiv1alpha1.InferenceServiceList
			Expect(r.List(ctx, &list, client.MatchingFields{publishIndexKey: publishIndexValue})).To(Succeed())
			for i := range list.Items {
				if list.Items[i].Namespace == testNamespace && list.Items[i].Name == "shared-pub" {
					return true
				}
			}
			return false
		}, "2s").Should(BeTrue())

		shared := &aigwv1beta1.AIGatewayRoute{ObjectMeta: metav1.ObjectMeta{Name: testCatalogRoute, Namespace: testGatewayNamespace}}
		reqs := r.enqueueForSharedCatalogRoute(ctx, shared)
		names := map[string]bool{}
		for _, req := range reqs {
			names[req.Namespace+"/"+req.Name] = true
		}
		Expect(names).To(HaveKey(testNamespace + "/shared-pub"))
		Expect(names).NotTo(HaveKey(testNamespace + "/shared-unpub"))

		// A route of the same name in another namespace is not the shared one.
		foreign := shared.DeepCopy()
		foreign.Namespace = "somewhere-else"
		Expect(r.enqueueForSharedCatalogRoute(ctx, foreign)).To(BeEmpty())
		// A route in the right namespace with another name is likewise not.
		other := shared.DeepCopy()
		other.Name = "another-route"
		Expect(r.enqueueForSharedCatalogRoute(ctx, other)).To(BeEmpty())
	})
})
