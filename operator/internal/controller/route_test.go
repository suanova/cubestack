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

// acceptRoute marks the route accepted by the platform gateway for its current
// generation: envtest runs no gateway controller, so the specs write
// status.parents directly (ObservedGeneration pins the status to the
// generation it was written for, like a real gateway controller would).
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
			{Type: string(gatewayv1.RouteConditionAccepted), Status: metav1.ConditionTrue, Reason: "Accepted", LastTransitionTime: metav1.Now(), ObservedGeneration: route.Generation},
			{Type: string(gatewayv1.RouteConditionResolvedRefs), Status: metav1.ConditionTrue, Reason: "ResolvedRefs", LastTransitionTime: metav1.Now(), ObservedGeneration: route.Generation},
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

		// The update bumps the route generation; the acceptance check requires
		// fresh status (ObservedGeneration == the new generation), so the
		// gateway re-accepts before RouteReady returns.
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), hostname)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal("GatewayNotAccepted"))
		acceptRoute(name)
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), hostname)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-route", Namespace: testNamespace}, route)).To(Succeed())
		Expect(string(*route.Spec.Rules[0].Timeouts.Request)).To(Equal("30s"))
		Expect(route.ResourceVersion).NotTo(Equal(oldRV))
	})

	It("sees no drift in the route a real API server stored", func() {
		// Pins the default set routeSpecWithDefaults mirrors against what an
		// actual API server writes: a default this list is missing makes the
		// reconciler rewrite the route on every pass, which is the 409 race
		// described in the routeNeedsUpdate spec.
		name := "route-stored"
		isvc := isvcForApply(name)
		isvc.Spec.Route = &aiv1alpha1.RouteSpec{Publish: true, ModelName: "stored-model", TimeoutSeconds: ptrTo[int64](60)}
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		r := routeReconciler()
		hostname := publicHostname(isvc, testGatewayDomain)
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), hostname)
		Expect(err).NotTo(HaveOccurred())

		stored := &gatewayv1.HTTPRoute{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-route", Namespace: testNamespace}, stored)).To(Succeed())
		desired := r.desiredHTTPRoute(mustGetISVC(ctx, name), routeProfile(name+"-prof"), 8001)
		Expect(routeNeedsUpdate(stored, desired)).To(BeFalse())
	})

	It("does not report acceptance from a stale status after a spec update", func() {
		// The route is accepted for generation 1; a spec change bumps the
		// generation, and the pre-update status must not report RouteReady
		// until the gateway writes status for the new generation.
		name := "route-stale"
		isvc := isvcForApply(name)
		isvc.Spec.Route = &aiv1alpha1.RouteSpec{Publish: true, ModelName: "stale-model", TimeoutSeconds: ptrTo[int64](60)}
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		r := routeReconciler()
		hostname := publicHostname(isvc, testGatewayDomain)
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), hostname)
		Expect(err).NotTo(HaveOccurred())
		acceptRoute(name) // accepted for generation 1

		// The spec changes the timeout; the update bumps the route generation
		// but the stored status still carries generation 1.
		current := mustGetISVC(ctx, name)
		*current.Spec.Route.TimeoutSeconds = 30
		Expect(k8sClient.Update(ctx, current)).To(Succeed())
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), hostname)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal("GatewayNotAccepted"))

		// The gateway writes status for the new generation; RouteReady returns.
		acceptRoute(name)
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), hostname)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())
	})

	It("sets the RouteReady condition from the check", func() {
		conditions := []metav1.Condition{}
		setRouteReadyCondition(&conditions, &routeCheck{Reason: "NotPublished"})
		cond := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionRouteReady)
		Expect(cond.Status).To(Equal(metav1.ConditionTrue))
		Expect(cond.Reason).To(Equal("NotPublished"))
	})
})

var _ = Describe("routeNeedsUpdate", func() {
	// storedRoute is the route as the API server persists it: the controller's
	// desired object plus the Gateway API defaults (see the CRDs under
	// testdata/gateway-crds).
	storedRoute := func(desired *gatewayv1.HTTPRoute) *gatewayv1.HTTPRoute {
		stored := desired.DeepCopy()
		stored.Spec.ParentRefs[0].Group = ptrTo(gatewayv1.Group(gatewayAPIGroup))
		stored.Spec.ParentRefs[0].Kind = ptrTo(gatewayv1.Kind(gatewayKind))
		backend := &stored.Spec.Rules[0].BackendRefs[0].BackendRef
		backend.Group = ptrTo(gatewayv1.Group(""))
		backend.Kind = ptrTo(gatewayv1.Kind(serviceKind))
		backend.Weight = ptrTo(int32(1))
		stored.Spec.Rules[0].Matches = []gatewayv1.HTTPRouteMatch{{
			Path: &gatewayv1.HTTPPathMatch{Type: ptrTo(gatewayv1.PathMatchPathPrefix), Value: ptrTo("/")},
		}}
		return stored
	}
	driftRoute := func() *gatewayv1.HTTPRoute {
		return routeReconciler().desiredHTTPRoute(routeISVC("route-drift", true), routeProfile("route-drift-prof"), 8001)
	}

	It("does not treat the API server's defaults as drift", func() {
		// Those defaults are server-owned. A comparison that counts them as
		// drift makes checkRoute issue an update on every reconcile, and that
		// write runs the optimistic-concurrency check against the gateway
		// controller's status writes: the reconcile then fails with
		// "the object has been modified" (409) although nothing had drifted.
		Expect(routeNeedsUpdate(storedRoute(driftRoute()), driftRoute())).To(BeFalse())
	})

	It("still reports drift the controller owns", func() {
		// The guard against "fixing" the above by never reporting drift: a
		// changed timeout, hostname or backend port is ours and must update.
		desired := driftRoute()

		staleTimeout := storedRoute(desired)
		staleTimeout.Spec.Rules[0].Timeouts.Request = ptrTo(gatewayv1.Duration("30s"))
		Expect(routeNeedsUpdate(staleTimeout, desired)).To(BeTrue())

		staleHostname := storedRoute(desired)
		staleHostname.Spec.Hostnames = []gatewayv1.Hostname{"other.example.com"}
		Expect(routeNeedsUpdate(staleHostname, desired)).To(BeTrue())

		stalePort := storedRoute(desired)
		stalePort.Spec.Rules[0].BackendRefs[0].Port = ptrTo(gatewayv1.PortNumber(9999))
		Expect(routeNeedsUpdate(stalePort, desired)).To(BeTrue())
	})
})

var _ = Describe("routeParentsAccepted", func() {
	// parentsAcceptedBy renders the status.parents a gateway writes when it
	// accepts the route, observed for the given generation (0 = a gateway that
	// did not report one).
	parentsAcceptedBy := func(observed int64) []gatewayv1.RouteParentStatus {
		return gatewayRouteParents(gatewayv1.ParentReference{
			Name:      gatewayv1.ObjectName(testGatewayName),
			Namespace: ptrTo(gatewayv1.Namespace(testGatewayNamespace)),
		}, observed, true, "", "")
	}

	It("accepts a status written for the current generation", func() {
		Expect(routeParentsAccepted(parentsAcceptedBy(3), 3, testGatewayName, testGatewayNamespace)).To(BeTrue())
	})

	It("rejects a status written for an earlier generation", func() {
		Expect(routeParentsAccepted(parentsAcceptedBy(2), 3, testGatewayName, testGatewayNamespace)).To(BeFalse())
	})

	It("accepts a status that leaves observedGeneration unset", func() {
		// observedGeneration is optional in the Gateway API schema, so a gateway
		// may omit it. Treating that as stale would withhold every environment's
		// endpoints on such a cluster; the tolerance is deliberate.
		Expect(routeParentsAccepted(parentsAcceptedBy(0), 3, testGatewayName, testGatewayNamespace)).To(BeTrue())
	})
})

var _ = Describe("routeParentsTo", func() {
	// refTo builds a parentRef with group and kind spelled out, as the API server
	// stores them; "" leaves the field unset.
	refTo := func(group gatewayv1.Group, kind gatewayv1.Kind, name, namespace string) gatewayv1.ParentReference {
		ref := gatewayv1.ParentReference{
			Group: ptrTo(group),
			Kind:  ptrTo(kind),
			Name:  gatewayv1.ObjectName(name),
		}
		if namespace != "" {
			ref.Namespace = ptrTo(gatewayv1.Namespace(namespace))
		}
		return ref
	}
	gateway := func(name, namespace string) gatewayv1.ParentReference {
		return refTo(gatewayAPIGroup, gatewayKind, name, namespace)
	}

	It("matches the configured Gateway", func() {
		refs := []gatewayv1.ParentReference{gateway(testGatewayName, testGatewayNamespace)}
		Expect(routeParentsTo(refs, testNamespace, testGatewayName, testGatewayNamespace)).To(BeTrue())
	})

	It("applies the API's defaults to an unset namespace, group and kind", func() {
		// name alone means a Gateway in the Gateway API group, in the route's own
		// namespace — the defaults the API server fills in on write.
		refs := []gatewayv1.ParentReference{{Name: gatewayv1.ObjectName(testGatewayName)}}
		Expect(routeParentsTo(refs, testGatewayNamespace, testGatewayName, testGatewayNamespace)).To(BeTrue())
	})

	It("ignores a parent in another namespace", func() {
		refs := []gatewayv1.ParentReference{gateway(testGatewayName, "somewhere-else")}
		Expect(routeParentsTo(refs, testNamespace, testGatewayName, testGatewayNamespace)).To(BeFalse())
	})

	It("ignores a parent that is not a Gateway", func() {
		// A same-name, same-namespace Service, as a mesh route may parent to: it
		// has no listener on our Gateway, so its route must not reserve a port.
		svc := refTo("", serviceKind, testGatewayName, testGatewayNamespace)
		Expect(routeParentsTo([]gatewayv1.ParentReference{svc}, testNamespace, testGatewayName, testGatewayNamespace)).To(BeFalse())

		// A Gateway of the same name in another API group is likewise not ours.
		foreign := refTo("example.com", gatewayKind, testGatewayName, testGatewayNamespace)
		Expect(routeParentsTo([]gatewayv1.ParentReference{foreign}, testNamespace, testGatewayName, testGatewayNamespace)).To(BeFalse())
	})
})

var _ = Describe("listenerSetParentsToGateway", func() {
	// A ListenerSet carries one parentRef rather than a list, and its namespace
	// defaults to the ListenerSet's own — the same rule routeParentsTo applies to
	// a route's parentRefs, which is why the two share it.
	set := func(namespace string, mut func(*gatewayv1.ParentGatewayReference)) *gatewayv1.ListenerSet {
		ls := &gatewayv1.ListenerSet{
			ObjectMeta: metav1.ObjectMeta{Name: "de-l4-l4", Namespace: testNamespace},
			Spec: gatewayv1.ListenerSetSpec{
				ParentRef: gatewayv1.ParentGatewayReference{
					Group: ptrTo(gatewayv1.Group(gatewayAPIGroup)),
					Kind:  ptrTo(gatewayv1.Kind(gatewayKind)),
					Name:  gatewayv1.ObjectName(testGatewayName),
				},
			},
		}
		if namespace != "" {
			ls.Spec.ParentRef.Namespace = ptrTo(gatewayv1.Namespace(namespace))
		}
		if mut != nil {
			mut(&ls.Spec.ParentRef)
		}
		return ls
	}

	It("matches a ListenerSet contributing to the configured Gateway", func() {
		Expect(listenerSetParentsToGateway(set(testGatewayNamespace, nil), testGatewayName, testGatewayNamespace)).To(BeTrue())
	})

	It("applies the API's defaults to an unset namespace, group and kind", func() {
		ls := set("", func(ref *gatewayv1.ParentGatewayReference) {
			ref.Group, ref.Kind = nil, nil
		})
		Expect(listenerSetParentsToGateway(ls, testGatewayName, testNamespace)).To(BeTrue())
	})

	It("ignores a ListenerSet on another Gateway", func() {
		Expect(listenerSetParentsToGateway(set(testGatewayNamespace, func(ref *gatewayv1.ParentGatewayReference) {
			ref.Name = "other-gw"
		}), testGatewayName, testGatewayNamespace)).To(BeFalse())
	})

	It("ignores a ListenerSet in another namespace", func() {
		Expect(listenerSetParentsToGateway(set("somewhere-else", nil), testGatewayName, testGatewayNamespace)).To(BeFalse())
	})
})
