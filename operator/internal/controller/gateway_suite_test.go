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
	"sigs.k8s.io/controller-runtime/pkg/client"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

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
