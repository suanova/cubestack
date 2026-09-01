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

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// Gateway configuration shared by the checkRoute specs.
const (
	testGatewayDomain    = "example.com"
	testGatewayName      = "platform"
	testGatewayNamespace = "cubestack-system"
	testRouteHostname    = "flash.example.com"
)

func routeISVC(name string, publish bool) *aiv1alpha1.InferenceService {
	isvc := isvcForApply(name)
	isvc.Spec.Route = &aiv1alpha1.RouteSpec{Publish: publish, ModelName: "flash", TimeoutSeconds: ptrTo[int64](60)}
	return isvc
}

func routeProfile(name string) *aiv1alpha1.InferenceRuntimeProfile {
	return endpointProfile(name)
}

// routeReconciler returns the reconciler under test with the platform gateway
// configured.
func routeReconciler() *InferenceServiceReconciler {
	return &InferenceServiceReconciler{Client: k8sClient, Scheme: testScheme, GatewayDomain: testGatewayDomain, GatewayName: testGatewayName, GatewayNamespace: testGatewayNamespace}
}

// acceptRoute marks the route accepted by the platform gateway: envtest runs
// no gateway controller, so the specs write status.parents directly.
func acceptRoute(name string) {
	route := &gatewayv1.HTTPRoute{}
	Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-route", Namespace: testNamespace}, route)).To(Succeed())
	route.Status.Parents = []gatewayv1.RouteParentStatus{{
		ParentRef: gatewayv1.ParentReference{
			Name:      gatewayv1.ObjectName(testGatewayName),
			Namespace: ptrTo(gatewayv1.Namespace(testGatewayNamespace)),
		},
		ControllerName: gatewayv1.GatewayController("example.net/gateway-controller"),
		Conditions: []metav1.Condition{
			{Type: string(gatewayv1.RouteConditionAccepted), Status: metav1.ConditionTrue, Reason: "Accepted", LastTransitionTime: metav1.Now()},
			{Type: string(gatewayv1.RouteConditionResolvedRefs), Status: metav1.ConditionTrue, Reason: "ResolvedRefs", LastTransitionTime: metav1.Now()},
		},
	}}
	Expect(k8sClient.Status().Update(ctx, route)).To(Succeed())
}

var _ = Describe("checkRoute", func() {
	readyEndpoint := func(name string) *endpointCheck {
		return &endpointCheck{Internal: name + "-router.default.svc:8001", Role: testApplyRouterRole}
	}

	It("reports NotPublished and deletes an existing route when publish is false", func() {
		name := "route-off"
		Expect(k8sClient.Create(ctx, routeISVC(name, false))).To(Succeed())
		r := routeReconciler()
		// The route must be owned by the in-cluster isvc (the ownerRef needs
		// its UID), so it is built from the fetched object; Publish is flipped
		// on the local copy to model the route published before publishing was
		// turned off.
		isvc := mustGetISVC(ctx, name)
		isvc.Spec.Route.Publish = true
		old := r.desiredHTTPRoute(isvc, routeProfile(name+"-prof"), 8001)
		Expect(k8sClient.Create(ctx, old)).To(Succeed())

		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), "")
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal("NotPublished"))
		got := &gatewayv1.HTTPRoute{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-route", Namespace: testNamespace}, got))).To(BeTrue())
	})

	It("creates an HTTPRoute for a published service with a ready endpoint", func() {
		name := "route-on"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		hostname := publicHostname(routeISVC(name, true), testGatewayDomain)
		Expect(hostname).To(Equal(testRouteHostname))
		// Created but not yet accepted by the gateway: RouteReady must wait.
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), hostname)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal("GatewayNotAccepted"))

		// The gateway accepts the route; the next check reports it ready.
		acceptRoute(name)
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), hostname)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())

		route := &gatewayv1.HTTPRoute{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-route", Namespace: testNamespace}, route)).To(Succeed())
		Expect(route.Spec.Hostnames).To(Equal([]gatewayv1.Hostname{gatewayv1.Hostname(testRouteHostname)}))
		Expect(route.Spec.ParentRefs[0].Name).To(Equal(gatewayv1.ObjectName(testGatewayName)))
		Expect(route.Spec.Rules[0].BackendRefs[0].Name).To(Equal(gatewayv1.ObjectName(name + "-router")))
		Expect(route.Spec.Rules[0].Timeouts.Request).NotTo(BeNil())
		// The uniqueness check scans all HTTPRoutes cluster-wide, so the
		// route must not leak into the later specs.
		Expect(k8sClient.Delete(ctx, route)).To(Succeed())
	})

	It("reports ModelNameConflict when another route owns the hostname", func() {
		name := "route-conflict"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		other := routeISVC("route-other", true)
		Expect(k8sClient.Create(ctx, other)).To(Succeed())
		r := routeReconciler()
		// another service's route already owns flash.example.com
		existing := r.desiredHTTPRoute(other, routeProfile("route-other-prof"), 8001)
		Expect(k8sClient.Create(ctx, existing)).To(Succeed())
		defer func() { _ = k8sClient.Delete(ctx, existing) }()

		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testRouteHostname)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal("ModelNameConflict"))
		got := &gatewayv1.HTTPRoute{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-route", Namespace: testNamespace}, got))).To(BeTrue())
	})

	It("reports EndpointNotReady without a ready endpoint", func() {
		name := "route-noep"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), &endpointCheck{Reason: "EndpointNotReady"}, "")
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal("EndpointNotReady"))
	})

	It("keeps an existing route when the endpoint goes unready", func() {
		name := "route-keep"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		hostname := publicHostname(routeISVC(name, true), testGatewayDomain)
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), hostname)
		Expect(err).NotTo(HaveOccurred())
		// Endpoint goes unready: the route must survive (design: route
		// lifecycle follows the Service; gateway health checks drain).
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), &endpointCheck{Reason: "EndpointNotReady"}, "")
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal("EndpointNotReady"))
		route := &gatewayv1.HTTPRoute{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-route", Namespace: testNamespace}, route)).To(Succeed())
	})

	It("updates the HTTPRoute when the published timeout changes", func() {
		// The model name must be unique in the cluster: the route-keep spec
		// leaves its flash.example.com route behind.
		name := "route-update"
		isvc := isvcForApply(name)
		isvc.Spec.Route = &aiv1alpha1.RouteSpec{Publish: true, ModelName: "update-model", TimeoutSeconds: ptrTo[int64](60)}
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		r := routeReconciler()
		hostname := publicHostname(isvc, testGatewayDomain)
		Expect(hostname).To(Equal("update-model.example.com"))
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), hostname)
		Expect(err).NotTo(HaveOccurred())
		acceptRoute(name) // the gateway accepts; RouteReady reports "" below
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), hostname)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())

		route := &gatewayv1.HTTPRoute{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-route", Namespace: testNamespace}, route)).To(Succeed())
		Expect(string(*route.Spec.Rules[0].Timeouts.Request)).To(Equal("60s"))
		oldRV := route.ResourceVersion

		// The in-cluster spec changes the timeout; the next check must update
		// the stored route instead of leaving it stale.
		current := mustGetISVC(ctx, name)
		*current.Spec.Route.TimeoutSeconds = 30
		Expect(k8sClient.Update(ctx, current)).To(Succeed())

		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), hostname)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-route", Namespace: testNamespace}, route)).To(Succeed())
		Expect(string(*route.Spec.Rules[0].Timeouts.Request)).To(Equal("30s"))
		Expect(route.ResourceVersion).NotTo(Equal(oldRV))
	})

	It("sets the RouteReady condition from the check", func() {
		conditions := []metav1.Condition{}
		setRouteReadyCondition(&conditions, &routeCheck{Reason: "NotPublished"})
		cond := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionRouteReady)
		Expect(cond.Status).To(Equal(metav1.ConditionTrue))
		Expect(cond.Reason).To(Equal("NotPublished"))
	})
})
