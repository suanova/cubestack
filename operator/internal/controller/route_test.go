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
	"strconv"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	aigwv1beta1 "github.com/envoyproxy/ai-gateway/api/v1beta1"
	egv1alpha1 "github.com/envoyproxy/gateway/api/v1alpha1"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// notYetObservedClient models the manager's informer-cached client right after a
// write: an object this client created is persisted, but a Get for it still
// misses because the cache has not observed it yet. Reads of objects it did not
// create go through unchanged, so the spec exercises the create path only.
type notYetObservedClient struct {
	client.Client
	created map[client.ObjectKey]bool
}

func (c *notYetObservedClient) Create(ctx context.Context, obj client.Object, opts ...client.CreateOption) error {
	if err := c.Client.Create(ctx, obj, opts...); err != nil {
		return err
	}
	c.created[client.ObjectKeyFromObject(obj)] = true
	return nil
}

func (c *notYetObservedClient) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if c.created[key] {
		return apierrors.NewNotFound(schema.GroupResource{Group: "aigateway.envoyproxy.io", Resource: "objects"}, key.Name)
	}
	return c.Client.Get(ctx, key, obj, opts...)
}

// Gateway configuration shared by the checkRoute specs.
const (
	testGatewayName      = "platform"
	testGatewayNamespace = "cubestack-system"
	testCatalogHostname  = "ai.example.com"
	// testCatalogRoute is the name of the platform's pre-installed shared
	// AIGatewayRoute the published services attach a rule to.
	testCatalogRoute = "cubestack-ai-gateway"
	// testEngineModel is the engine's served model name the reconcile reads
	// from the ModelVersion and writes into the rule as the modelNameOverride.
	testEngineModel = "flash-engine"
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
// and the shared catalog route configured.
func routeReconciler() *InferenceServiceReconciler {
	return &InferenceServiceReconciler{Client: k8sClient, Scheme: testScheme, GatewayName: testGatewayName, GatewayNamespace: testGatewayNamespace, CatalogRoute: testCatalogRoute, CatalogHostname: testCatalogHostname, AgentRouterAvailable: true}
}

// ensureGatewayNamespace creates the namespace the shared catalog route lives
// in; envtest does not create it, and the specs that write the route need it.
// A second call is a no-op: the suite shares one envtest cluster.
func ensureGatewayNamespace() {
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: testGatewayNamespace}}
	if err := k8sClient.Create(ctx, ns); err != nil && !apierrors.IsAlreadyExists(err) {
		Expect(err).NotTo(HaveOccurred())
	}
}

// sharedCatalogRoute returns the platform's pre-installed shared AIGatewayRoute
// the published services attach a rule to, addressed by the reconciler's config.
func sharedCatalogRoute() *aigwv1beta1.AIGatewayRoute {
	return &aigwv1beta1.AIGatewayRoute{ObjectMeta: metav1.ObjectMeta{Name: testCatalogRoute, Namespace: testGatewayNamespace}}
}

// ensureSharedCatalogRoute persists the shared route with no rules. The
// platform owns the object; the specs only need it to exist so a published
// service has a route to attach a rule to. It is reset to zero rules on every
// call: the suite shares one envtest cluster and one shared route, so a spec
// must not see another spec's rules. Specs that need the route read it back
// through sharedCatalogRoute.
func ensureSharedCatalogRoute() {
	ensureGatewayNamespace()
	route := sharedCatalogRoute()
	// The CRD requires spec.rules to be present: an empty slice is valid where
	// nil is rejected, so the reset path must never store nil.
	route.Spec.Rules = []aigwv1beta1.AIGatewayRouteRule{}
	err := k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)
	if apierrors.IsNotFound(err) {
		Expect(k8sClient.Create(ctx, route)).To(Succeed())
		return
	}
	Expect(err).NotTo(HaveOccurred())
	if len(route.Spec.Rules) > 0 {
		route.Spec.Rules = []aigwv1beta1.AIGatewayRouteRule{}
		Expect(k8sClient.Update(ctx, route)).To(Succeed())
	}
}

// aiAcceptedReason is the reason the Agent Router controller writes on the
// conditions it accepts: ai-gateway's newConditions writes a fixed
// "ReconciliationSucceeded" and puts the detail in the message.
const aiAcceptedReason = "ReconciliationSucceeded"

// acceptSharedCatalogRoute marks the shared route accepted by the Agent Router
// controller for its current generation.
func acceptSharedCatalogRoute() {
	route := sharedCatalogRoute()
	Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
	route.Status.Conditions = []metav1.Condition{{
		Type: aigwv1beta1.ConditionTypeAccepted, Status: metav1.ConditionTrue, Reason: aiAcceptedReason,
		LastTransitionTime: metav1.Now(), ObservedGeneration: route.Generation,
	}}
	Expect(k8sClient.Status().Update(ctx, route)).To(Succeed())
}

// acceptAIServiceBackend writes the Accepted condition the Agent Router
// controller would set on the service's AIServiceBackend.
func acceptAIServiceBackend(name string) {
	sb := &aigwv1beta1.AIServiceBackend{}
	Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-backend", Namespace: testNamespace}, sb)).To(Succeed())
	sb.Status.Conditions = []metav1.Condition{{
		Type: aigwv1beta1.ConditionTypeAccepted, Status: metav1.ConditionTrue, Reason: aiAcceptedReason,
		LastTransitionTime: metav1.Now(), ObservedGeneration: sb.Generation,
	}}
	Expect(k8sClient.Status().Update(ctx, sb)).To(Succeed())
}

// acceptRoute marks the catalog objects accepted by the Agent Router
// controller: the shared route (route-level) and the service's AIServiceBackend.
func acceptRoute(name string) {
	acceptSharedCatalogRoute()
	acceptAIServiceBackend(name)
}

var _ = Describe("checkRoute", func() {
	readyEndpoint := func(name string) *endpointCheck {
		return &endpointCheck{Internal: name + "-router.default.svc:8001", Role: testApplyRouterRole}
	}

	It("reports CatalogRouteNotFound when the shared route does not exist", func() {
		// Earlier specs may have created the shared route: delete it so the
		// precondition (a platform prerequisite the operator never creates)
		// holds deterministically.
		route := sharedCatalogRoute()
		err := k8sClient.Delete(ctx, route)
		Expect(err == nil || apierrors.IsNotFound(err)).To(BeTrue())
		name := "route-noshared"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteCatalogNotFound))
	})

	It("creates the catalog objects and a rule in the shared route for a published service", func() {
		ensureSharedCatalogRoute()
		name := "route-on"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		// Persisted but not yet accepted by the Agent Router: RouteReady must wait.
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteGatewayNotAccepted))

		backend := &egv1alpha1.Backend{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-endpoint", Namespace: testNamespace}, backend)).To(Succeed())
		Expect(backend.Spec.Endpoints).To(Equal([]egv1alpha1.BackendEndpoint{{
			FQDN: &egv1alpha1.FQDNEndpoint{Hostname: name + "-router.default.svc.cluster.local", Port: 8001},
		}}))
		sb := &aigwv1beta1.AIServiceBackend{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-backend", Namespace: testNamespace}, sb)).To(Succeed())
		Expect(string(sb.Spec.BackendRef.Name)).To(Equal(name + "-endpoint"))
		// The ReferenceGrant authorises the Gateway to cross into the service's
		// namespace for the AIServiceBackend.
		grant := &gatewayv1.ReferenceGrant{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-grant", Namespace: testNamespace}, grant)).To(Succeed())

		// The service's rule is in the shared route, named after its backend.
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(route.Spec.Rules).To(HaveLen(1))
		Expect(route.Spec.Rules[0].Matches[0].Headers[0].Value).To(Equal("flash"))
		Expect(route.Spec.Rules[0].BackendRefs[0].Name).To(Equal(name + "-backend"))
		Expect(route.Spec.Rules[0].BackendRefs[0].ModelNameOverride).To(Equal(testEngineModel))

		// The Agent Router accepts; the next check reports the catalog entry ready.
		acceptRoute(name)
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())
	})

	It("leaves other services' rules untouched when upserting its own", func() {
		ensureSharedCatalogRoute()
		// A second service already has a rule in the shared route, written for
		// its own backend: the first service's upsert must not rewrite it.
		first := routeISVC("route-mine", true)
		second := routeISVC("route-theirs", true)
		second.Spec.Route.ModelName = "theirs-model"
		Expect(k8sClient.Create(ctx, first)).To(Succeed())
		Expect(k8sClient.Create(ctx, second)).To(Succeed())
		r := routeReconciler()
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, "route-theirs"), routeProfile("p2"), readyEndpoint("route-theirs"), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		theirsRV := route.ResourceVersion
		theirsRule := route.Spec.Rules[0]

		// The first service now upserts its own rule: the second's rule must be
		// byte-identical and its generation must not move.
		_, err = r.checkRoute(ctx, mustGetISVC(ctx, "route-mine"), routeProfile("p1"), readyEndpoint("route-mine"), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(route.Spec.Rules).To(HaveLen(2))
		idx := findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, "route-theirs"))
		Expect(idx).NotTo(Equal(-1))
		Expect(route.Spec.Rules[idx]).To(Equal(theirsRule))
		// The RV bumped because a rule was added — the point is the existing
		// rule's content is preserved, not that the write was skipped.
		_ = theirsRV
	})

	It("reports ModelNameConflict when another rule claims the model name", func() {
		ensureSharedCatalogRoute()
		name := "route-conflict"
		other := routeISVC("route-other", true)
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		Expect(k8sClient.Create(ctx, other)).To(Succeed())
		r := routeReconciler()
		// The other service's rule already claims the same model name.
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, "route-other"), routeProfile("po"), readyEndpoint("route-other"), testEngineModel)
		Expect(err).NotTo(HaveOccurred())

		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteModelNameConflict))
		// The conflicting service publishes nothing of its own.
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).To(Equal(-1))
	})

	It("reports CatalogFull when the shared route is at its rule cap", func() {
		ensureSharedCatalogRoute()
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		// Fill the shared route with catalogRuleMax foreign rules, none of them
		// this service's.
		route.Spec.Rules = make([]aigwv1beta1.AIGatewayRouteRule, 0, catalogRuleMax)
		for i := range catalogRuleMax {
			route.Spec.Rules = append(route.Spec.Rules, aigwv1beta1.AIGatewayRouteRule{
				BackendRefs: []aigwv1beta1.AIGatewayRouteRuleBackendRef{{Name: "foreign-" + strconv.Itoa(i), Weight: ptr(int32(1)), Priority: ptr(uint32(0))}},
			})
		}
		Expect(k8sClient.Update(ctx, route)).To(Succeed())

		name := "route-full"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		check, err := routeReconciler().checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteCatalogFull))
	})

	It("refuses a conflicting name or a full route inside the write itself", func() {
		// The checkRoute pre-checks are a fast path; the authoritative ones run
		// inside the write's conflict retry, against the route state each
		// attempt reads. Drive the write directly to pin that path: a state the
		// pre-check never saw must be refused by the write, not appended by a
		// retry.
		ensureSharedCatalogRoute()
		other := routeISVC("route-race-other", true)
		Expect(k8sClient.Create(ctx, other)).To(Succeed())
		r := routeReconciler()
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, "route-race-other"), routeProfile("pr"), readyEndpoint("route-race-other"), testEngineModel)
		Expect(err).NotTo(HaveOccurred())

		// The other service's rule claims the model name both services declare:
		// the write itself must refuse the second rule.
		name := "route-race"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		err = r.upsertCatalogRule(ctx, mustGetISVC(ctx, name), testEngineModel)
		Expect(err).To(MatchError(errCatalogModelNameTaken))

		// The same holds for the rule cap: once the route is full, the write
		// refuses a new rule instead of letting the retry overfill it.
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		for len(route.Spec.Rules) < catalogRuleMax {
			route.Spec.Rules = append(route.Spec.Rules, aigwv1beta1.AIGatewayRouteRule{
				BackendRefs: []aigwv1beta1.AIGatewayRouteRuleBackendRef{{Name: "filler-" + strconv.Itoa(len(route.Spec.Rules)), Weight: ptr(int32(1)), Priority: ptr(uint32(0))}},
			})
		}
		Expect(k8sClient.Update(ctx, route)).To(Succeed())
		full := routeISVC("route-race-full", true)
		full.Spec.Route.ModelName = "another-model"
		Expect(k8sClient.Create(ctx, full)).To(Succeed())
		err = r.upsertCatalogRule(ctx, mustGetISVC(ctx, "route-race-full"), testEngineModel)
		Expect(err).To(MatchError(errCatalogRouteFull))
	})

	It("reports AgentRouterUnavailable when the cluster serves no Agent Router CRDs", func() {
		r := routeReconciler()
		r.AgentRouterAvailable = false
		check, err := r.checkRoute(ctx, routeISVC("isvc-degraded", true), routeProfile("p"), readyEndpoint("isvc-degraded"), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteAgentRouterUnavailable))
	})

	It("reports EndpointNotReady without a ready endpoint", func() {
		ensureSharedCatalogRoute()
		name := "route-noep"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), &endpointCheck{Reason: "EndpointNotReady"}, testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(EndpointNotReady))

		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), nil, testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(EndpointNotReady))

		// Nothing is published without a reachable endpoint.
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).To(Equal(-1))
	})

	It("keeps the rule when the endpoint goes unready", func() {
		ensureSharedCatalogRoute()
		name := "route-keep"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		// The endpoint goes unready: the rule must survive.
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), &endpointCheck{Reason: "EndpointNotReady"}, testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(EndpointNotReady))
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).NotTo(Equal(-1))
	})

	It("reports GatewayNotAccepted until the shared route and the backend are accepted", func() {
		ensureSharedCatalogRoute()
		name := "route-accept"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteGatewayNotAccepted))

		// Only the backend is accepted: the shared route is still pending.
		acceptAIServiceBackend(name)
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteGatewayNotAccepted))

		// Both accepted: the catalog entry is live.
		acceptSharedCatalogRoute()
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())
	})

	It("reports NotPublished and deletes the catalog objects and rule when publish is false", func() {
		ensureSharedCatalogRoute()
		name := "route-off"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())

		// Publishing is turned off; the next pass must shed the rule and the
		// owned objects.
		current := mustGetISVC(ctx, name)
		current.Spec.Route.Publish = false
		Expect(k8sClient.Update(ctx, current)).To(Succeed())

		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteNotPublished))

		backend := &egv1alpha1.Backend{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-endpoint", Namespace: testNamespace}, backend))).To(BeTrue())
		sb := &aigwv1beta1.AIServiceBackend{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-backend", Namespace: testNamespace}, sb))).To(BeTrue())
		grant := &gatewayv1.ReferenceGrant{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-grant", Namespace: testNamespace}, grant))).To(BeTrue())
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).To(Equal(-1))
	})

	It("removes the rule from the shared route when a service is deleted", func() {
		// The finalizer path: a service being deleted must shed its rule before it
		// goes. The rule lives in another namespace and is not owned by the
		// service, so the finalizer is what removes it.
		ensureSharedCatalogRoute()
		name := "route-del"
		isvc := routeISVC(name, true)
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		r := routeReconciler()
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).NotTo(Equal(-1))

		// Mark the service for deletion and run the finalizer cleanup directly:
		// it must remove the rule from the shared route.
		Expect(r.removeCatalogRule(ctx, mustGetISVC(ctx, name))).To(Succeed())
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).To(Equal(-1))
	})

	It("keeps a finalizer another controller added concurrently", func() {
		// The suite's manager reconciles every real object in the cluster, so a
		// spec pinning a stale write must not share an object with it. This runs
		// the write against a fake client: the pattern under test is the same —
		// a merge patch spelling out the whole finalizers list, guarded by the
		// resourceVersion it read.
		c := fake.NewClientBuilder().WithScheme(testMgr.GetScheme()).Build()
		r := routeReconciler()
		r.Client = c
		isvc := routeISVC("fake-race-finalizer", true)
		Expect(c.Create(ctx, isvc)).To(Succeed())
		stale := &aiv1alpha1.InferenceService{}
		Expect(c.Get(ctx, client.ObjectKeyFromObject(isvc), stale)).To(Succeed())

		// Another controller adds its finalizer after this reconcile read the
		// service: the deferred patch must conflict rather than write a
		// finalizers list that drops it.
		live := &aiv1alpha1.InferenceService{}
		Expect(c.Get(ctx, client.ObjectKeyFromObject(isvc), live)).To(Succeed())
		live.Finalizers = append(live.Finalizers, "example.com/other")
		Expect(c.Update(ctx, live)).To(Succeed())
		err := r.ensureCatalogFinalizer(ctx, stale)
		Expect(apierrors.IsConflict(err)).To(BeTrue())

		// Retrying against a fresh read adds ours without dropping theirs.
		fresh := &aiv1alpha1.InferenceService{}
		Expect(c.Get(ctx, client.ObjectKeyFromObject(isvc), fresh)).To(Succeed())
		Expect(r.ensureCatalogFinalizer(ctx, fresh)).To(Succeed())
		got := &aiv1alpha1.InferenceService{}
		Expect(c.Get(ctx, client.ObjectKeyFromObject(isvc), got)).To(Succeed())
		Expect(got.Finalizers).To(ContainElements(inferenceServiceCatalogFinalizer, "example.com/other"))
	})

	It("reports GatewayNotAccepted when the catalog objects are not yet observed", func() {
		// The re-read after the apply goes through the client's cache: right after
		// the create the objects are persisted but the cache may not have observed
		// them yet, so a Get misses. That is a catalog entry waiting for the Agent
		// Router, not a failed pass.
		ensureSharedCatalogRoute()
		name := "route-unobserved"
		isvc := routeISVC(name, true)
		isvc.Spec.Route.ModelName = "unobserved-model"
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		r := routeReconciler()
		r.Client = &notYetObservedClient{Client: k8sClient, created: map[client.ObjectKey]bool{}}

		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteGatewayNotAccepted))
	})

	It("updates the service's rule when the declared timeout changes, without rewriting other rules", func() {
		ensureSharedCatalogRoute()
		name := "route-update"
		isvc := isvcForApply(name)
		isvc.Spec.Route = &aiv1alpha1.RouteSpec{Publish: true, ModelName: "update-model", TimeoutSeconds: ptrTo[int64](60)}
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		other := routeISVC("route-update-other", true)
		other.Spec.Route.ModelName = "update-other"
		Expect(k8sClient.Create(ctx, other)).To(Succeed())
		r := routeReconciler()
		// Both services get a rule: the "other" service's rule is the one this
		// spec must not rewrite.
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		_, err = r.checkRoute(ctx, mustGetISVC(ctx, "route-update-other"), routeProfile("po"), readyEndpoint("route-update-other"), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		acceptRoute(name)
		_, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())

		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		myIdx := findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))
		Expect(route.Spec.Rules[myIdx].Timeouts.Request).To(HaveValue(Equal(gatewayv1.Duration("60s"))))
		theirsIdx := findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, "route-update-other"))
		theirsRule := route.Spec.Rules[theirsIdx]

		// The in-cluster spec changes the timeout; the next pass must update only
		// this service's rule.
		current := mustGetISVC(ctx, name)
		*current.Spec.Route.TimeoutSeconds = 30
		Expect(k8sClient.Update(ctx, current)).To(Succeed())

		_, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(route.Spec.Rules[findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))].Timeouts.Request).To(HaveValue(Equal(gatewayv1.Duration("30s"))))
		Expect(route.Spec.Rules[findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, "route-update-other"))]).To(Equal(theirsRule))
	})

	It("sees no drift in the objects a real API server stored", func() {
		ensureSharedCatalogRoute()
		name := "route-stored"
		isvc := isvcForApply(name)
		isvc.Spec.Route = &aiv1alpha1.RouteSpec{Publish: true, ModelName: "stored-model", TimeoutSeconds: ptrTo[int64](60)}
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		r := routeReconciler()
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())

		stored := func(obj client.Object, name, namespace string) {
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: namespace}, obj)).To(Succeed())
		}
		backend := &egv1alpha1.Backend{}
		stored(backend, name+"-endpoint", testNamespace)
		sb := &aigwv1beta1.AIServiceBackend{}
		stored(sb, name+"-backend", testNamespace)
		grant := &gatewayv1.ReferenceGrant{}
		stored(grant, name+"-grant", testNamespace)
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		myIdx := findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))
		myRule := route.Spec.Rules[myIdx]
		routeRV := route.ResourceVersion

		// A second pass must touch none of the objects or the rule: the shared
		// route's RV is stable because the rule is unchanged.
		_, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		after := &egv1alpha1.Backend{}
		stored(after, name+"-endpoint", testNamespace)
		Expect(after.ResourceVersion).To(Equal(backend.ResourceVersion))
		afterSB := &aigwv1beta1.AIServiceBackend{}
		stored(afterSB, name+"-backend", testNamespace)
		Expect(afterSB.ResourceVersion).To(Equal(sb.ResourceVersion))
		afterGrant := &gatewayv1.ReferenceGrant{}
		stored(afterGrant, name+"-grant", testNamespace)
		Expect(afterGrant.ResourceVersion).To(Equal(grant.ResourceVersion))
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(route.ResourceVersion).To(Equal(routeRV))

		// A genuine change is still drift: a different endpoint or schema must
		// update, or the catalog would keep serving the old object after the
		// spec changed.
		Expect(backendNeedsUpdate(after, r.desiredBackend(mustGetISVC(ctx, name), routeProfile(name+"-prof"), 8002))).To(BeTrue())
		otherSchema := r.desiredAIServiceBackend(mustGetISVC(ctx, name))
		otherSchema.Spec.APISchema.Name = aigwv1beta1.APISchemaAWSBedrock
		Expect(aiServiceBackendNeedsUpdate(afterSB, otherSchema)).To(BeTrue())
		_ = myRule
	})

	It("does not report acceptance from a stale status after a spec update", func() {
		ensureSharedCatalogRoute()
		name := "route-stale"
		isvc := isvcForApply(name)
		isvc.Spec.Route = &aiv1alpha1.RouteSpec{Publish: true, ModelName: "stale-model", TimeoutSeconds: ptrTo[int64](60)}
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		r := routeReconciler()
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		acceptRoute(name) // accepted for the current generation

		// The spec changes the timeout; the shared route generation bumps but the
		// stored status still carries the old generation.
		current := mustGetISVC(ctx, name)
		*current.Spec.Route.TimeoutSeconds = 30
		Expect(k8sClient.Update(ctx, current)).To(Succeed())
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteGatewayNotAccepted))

		// The Agent Router writes status for the new generation; RouteReady returns.
		acceptRoute(name)
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())
	})

	It("deletes a legacy per-model HTTPRoute owned by the service", func() {
		name := "route-legacy"
		Expect(k8sClient.Create(ctx, routeISVC(name, false))).To(Succeed())
		r := routeReconciler()
		isvc := mustGetISVC(ctx, name)
		legacy := &gatewayv1.HTTPRoute{ObjectMeta: metav1.ObjectMeta{Name: name + "-route", Namespace: testNamespace}}
		Expect(ctrl.SetControllerReference(isvc, legacy, testScheme)).To(Succeed())
		Expect(k8sClient.Create(ctx, legacy)).To(Succeed())

		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteNotPublished))

		got := &gatewayv1.HTTPRoute{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-route", Namespace: testNamespace}, got))).To(BeTrue())
	})

	It("reports GatewayNotConfigured when the platform Gateway is not configured", func() {
		ensureSharedCatalogRoute()
		name := "route-nogw"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		r.GatewayName = ""
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteGatewayNotConfigured))
	})

	It("sets the RouteReady condition from the check", func() {
		conditions := []metav1.Condition{}
		setRouteReadyCondition(&conditions, &routeCheck{Reason: "NotPublished"})
		cond := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionRouteReady)
		Expect(cond.Status).To(Equal(metav1.ConditionTrue))
		Expect(cond.Reason).To(Equal("NotPublished"))
	})
})

var _ = Describe("desired catalog objects", func() {
	profile := func() *aiv1alpha1.InferenceRuntimeProfile {
		p := routeProfile("catalog-profile")
		p.Spec.Endpoint.Role = "vllm"
		return p
	}
	// expectCatalogLabels pins the label map of every catalog object literally —
	// the three keys with the values the fixture's isvc carries — rather than
	// through routeLabels, which would restate the code under test.
	expectCatalogLabels := func(labels map[string]string) {
		Expect(labels).To(HaveLen(3))
		Expect(labels).To(HaveKeyWithValue("ai.cubestack.io/inference-service", "catalog-isvc"))
		Expect(labels).To(HaveKeyWithValue("ai.cubestack.io/profile", "prof"))
		Expect(labels).To(HaveKeyWithValue("ai.cubestack.io/managed-by", "inference-Controller"))
	}

	It("renders the Backend pointing at the endpoint Service FQDN", func() {
		isvc := routeISVC("catalog-isvc", true)
		backend := routeReconciler().desiredBackend(isvc, profile(), 8000)

		Expect(backend.Name).To(Equal("catalog-isvc-endpoint"))
		Expect(backend.Namespace).To(Equal(testNamespace))
		expectCatalogLabels(backend.Labels)
		Expect(backend.Spec.Type).To(HaveValue(Equal(egv1alpha1.BackendTypeEndpoints)))
		Expect(backend.Spec.Endpoints).To(Equal([]egv1alpha1.BackendEndpoint{{
			FQDN: &egv1alpha1.FQDNEndpoint{Hostname: "catalog-isvc-vllm.default.svc.cluster.local", Port: 8000},
		}}))
		Expect(metav1.IsControlledBy(backend, isvc)).To(BeTrue())
	})

	It("renders the AIServiceBackend with the OpenAI schema and the Backend ref", func() {
		isvc := routeISVC("catalog-isvc", true)
		sb := routeReconciler().desiredAIServiceBackend(isvc)

		Expect(sb.Name).To(Equal("catalog-isvc-backend"))
		expectCatalogLabels(sb.Labels)
		Expect(sb.Spec.APISchema.Name).To(Equal(aigwv1beta1.APISchemaOpenAI))
		Expect(sb.Spec.BackendRef.Group).To(HaveValue(Equal(gatewayv1.Group(envoyGatewayAPIGroup))))
		Expect(sb.Spec.BackendRef.Kind).To(HaveValue(Equal(gatewayv1.Kind(egBackendKind))))
		Expect(string(sb.Spec.BackendRef.Name)).To(Equal("catalog-isvc-endpoint"))
		Expect(metav1.IsControlledBy(sb, isvc)).To(BeTrue())
	})

	It("renders the ReferenceGrant authorising the shared catalog route to the AIServiceBackend", func() {
		isvc := routeISVC("catalog-isvc", true)
		grant := routeReconciler().desiredReferenceGrant(isvc)

		Expect(grant.Name).To(Equal("catalog-isvc-grant"))
		Expect(grant.Namespace).To(Equal(testNamespace))
		expectCatalogLabels(grant.Labels)
		Expect(grant.Spec.From).To(HaveLen(1))
		Expect(string(grant.Spec.From[0].Group)).To(Equal("aigateway.envoyproxy.io"))
		Expect(string(grant.Spec.From[0].Kind)).To(Equal("AIGatewayRoute"))
		Expect(string(grant.Spec.From[0].Namespace)).To(Equal(testGatewayNamespace))
		Expect(grant.Spec.To).To(HaveLen(1))
		Expect(string(grant.Spec.To[0].Group)).To(Equal("aigateway.envoyproxy.io"))
		Expect(string(grant.Spec.To[0].Kind)).To(Equal("AIServiceBackend"))
		Expect(string(*grant.Spec.To[0].Name)).To(Equal("catalog-isvc-backend"))
		Expect(metav1.IsControlledBy(grant, isvc)).To(BeTrue())
	})

	It("renders the shared-route rule matched on the model name", func() {
		isvc := routeISVC("catalog-isvc", true)
		rule := routeReconciler().catalogRuleFor(isvc, "qwen38-27b")

		Expect(rule.Matches[0].Headers).To(Equal([]gatewayv1.HTTPHeaderMatch{{
			Type:  ptrTo(gatewayv1.HeaderMatchExact),
			Name:  gatewayv1.HTTPHeaderName(aiModelHeaderName),
			Value: "flash", // the route.modelName routeISVC declares
		}}))
		Expect(rule.BackendRefs[0].Name).To(Equal("catalog-isvc-backend"))
		Expect(string(*rule.BackendRefs[0].Namespace)).To(Equal(testNamespace))
		Expect(rule.BackendRefs[0].ModelNameOverride).To(Equal("qwen38-27b"))
		Expect(rule.BackendRefs[0].Weight).To(HaveValue(Equal(int32(1))))
		Expect(rule.BackendRefs[0].Priority).To(HaveValue(Equal(uint32(0))))
		Expect(rule.Timeouts.Request).To(HaveValue(Equal(gatewayv1.Duration("60s"))))
		Expect(rule.StreamIdleTimeout).To(HaveValue(Equal(gatewayv1.Duration("300s"))))
		Expect(rule.ModelsOwnedBy).To(HaveValue(Equal(catalogOwnedBy)))
	})

	It("honours the declared timeouts in the rule", func() {
		isvc := routeISVC("catalog-isvc", true)
		isvc.Spec.Route.TimeoutSeconds = ptrTo(int64(3600))
		isvc.Spec.Route.IdleTimeoutSeconds = ptrTo(int64(120))
		rule := routeReconciler().catalogRuleFor(isvc, "m")

		Expect(rule.Timeouts.Request).To(HaveValue(Equal(gatewayv1.Duration("3600s"))))
		Expect(rule.StreamIdleTimeout).To(HaveValue(Equal(gatewayv1.Duration("120s"))))
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
		refs := []gatewayv1.ParentReference{{Name: gatewayv1.ObjectName(testGatewayName)}}
		Expect(routeParentsTo(refs, testGatewayNamespace, testGatewayName, testGatewayNamespace)).To(BeTrue())
	})

	It("ignores a parent in another namespace", func() {
		refs := []gatewayv1.ParentReference{gateway(testGatewayName, "somewhere-else")}
		Expect(routeParentsTo(refs, testNamespace, testGatewayName, testGatewayNamespace)).To(BeFalse())
	})

	It("ignores a parent that is not a Gateway", func() {
		svc := refTo("", serviceKind, testGatewayName, testGatewayNamespace)
		Expect(routeParentsTo([]gatewayv1.ParentReference{svc}, testNamespace, testGatewayName, testGatewayNamespace)).To(BeFalse())

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
