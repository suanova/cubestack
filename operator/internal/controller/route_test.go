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
	// AIGatewayRoute published services attach a rule to by default.
	testCatalogRoute = aiv1alpha1.AIGatewayRouterPublic
	// testPrivateCatalogRoute is the second pre-installed shared route.
	testPrivateCatalogRoute = aiv1alpha1.AIGatewayRouterPrivate
	// testEngineModel is the engine's served model name the reconcile reads
	// from the ModelVersion and writes into the rule as the modelNameOverride.
	testEngineModel = "flash-engine"
	// testCatalogModelName is the catalog model name the route fixtures declare.
	testCatalogModelName = "flash"
	// testOpenAISuffix is the suffix of the OpenAI-schema AIServiceBackend.
	testOpenAISuffix = "-backend"
	// testAnthropicSuffix is the suffix of the Anthropic-schema AIServiceBackend
	// that serves /v1/messages.
	testAnthropicSuffix = "-anthropic"
)

func routeISVC(name string, publish bool) *aiv1alpha1.InferenceService {
	isvc := isvcForApply(name)
	isvc.Spec.Route = &aiv1alpha1.RouteSpec{ModelName: testCatalogModelName, TimeoutSeconds: ptrTo[int64](60)}
	if publish {
		isvc.Spec.Route.AIGatewayRouter = aiv1alpha1.AIGatewayRouterPublic
	}
	return isvc
}

func routeProfile(name string) *aiv1alpha1.InferenceRuntimeProfile {
	return endpointProfile(name)
}

// routeReconciler returns the reconciler under test with the platform gateway
// and the shared catalog route configured.
func routeReconciler() *InferenceServiceReconciler {
	return &InferenceServiceReconciler{Client: k8sClient, Scheme: testScheme, GatewayName: testGatewayName, GatewayNamespace: testGatewayNamespace, CatalogHostname: testCatalogHostname, AgentRouterAvailable: true}
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

// catalogRouteNamed returns one of the platform's pre-installed shared
// AIGatewayRoutes, addressed in the gateway namespace.
func catalogRouteNamed(name aiv1alpha1.AIGatewayRouterName) *aigwv1beta1.AIGatewayRoute {
	return &aigwv1beta1.AIGatewayRoute{ObjectMeta: metav1.ObjectMeta{Name: string(name), Namespace: testGatewayNamespace}}
}

// sharedCatalogRoute returns the public shared AIGatewayRoute.
func sharedCatalogRoute() *aigwv1beta1.AIGatewayRoute {
	return catalogRouteNamed(testCatalogRoute)
}

// privateCatalogRoute returns the private shared AIGatewayRoute.
func privateCatalogRoute() *aigwv1beta1.AIGatewayRoute {
	return catalogRouteNamed(testPrivateCatalogRoute)
}

// ruleIndexByRef returns the index of the rule whose first backendRef carries
// the given name, or -1. The shared route carries two rules per model — the
// native-Anthropic one and the OpenAI one — so tests cannot index by position.
func ruleIndexByRef(rules []aigwv1beta1.AIGatewayRouteRule, backendName string) int {
	for i := range rules {
		if len(rules[i].BackendRefs) > 0 && rules[i].BackendRefs[0].Name == backendName {
			return i
		}
	}
	return -1
}

// ensureCatalogRoute persists the named shared route with no rules. The
// platform owns the object; the specs only need it to exist so a published
// service has a route to attach a rule to. It is reset to zero rules on every
// call: the suite shares one envtest cluster and one set of shared routes, so a
// spec must not see another spec's rules.
func ensureCatalogRoute(name aiv1alpha1.AIGatewayRouterName) {
	ensureGatewayNamespace()
	route := catalogRouteNamed(name)
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

// ensureSharedCatalogRoute persists the public shared route with no rules.
func ensureSharedCatalogRoute() {
	ensureCatalogRoute(testCatalogRoute)
}

// ensureCatalogRoutes persists both shared routes with no rules.
func ensureCatalogRoutes() {
	for _, name := range catalogRouteNames {
		ensureCatalogRoute(name)
	}
}

// aiAcceptedReason is the reason the Agent Router controller writes on the
// conditions it accepts: ai-gateway's newConditions writes a fixed
// "ReconciliationSucceeded" and puts the detail in the message.
const aiAcceptedReason = "ReconciliationSucceeded"

// acceptCatalogRoute marks the named shared route accepted by the Agent Router
// controller for its current generation, together with the OpenAI-paths
// HTTPRoute paired with it.
func acceptCatalogRoute(name aiv1alpha1.AIGatewayRouterName) {
	route := catalogRouteNamed(name)
	Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
	route.Status.Conditions = []metav1.Condition{{
		Type: aigwv1beta1.ConditionTypeAccepted, Status: metav1.ConditionTrue, Reason: aiAcceptedReason,
		LastTransitionTime: metav1.Now(), ObservedGeneration: route.Generation,
	}}
	Expect(k8sClient.Status().Update(ctx, route)).To(Succeed())
	acceptOpenAIPathsRoute(name)
}

// acceptSharedCatalogRoute marks the public shared route accepted.
func acceptSharedCatalogRoute() {
	acceptCatalogRoute(testCatalogRoute)
}

// acceptAIServiceBackend writes the Accepted condition the Agent Router
// controller would set on the service's AIServiceBackends.
func acceptAIServiceBackend(name string) {
	for _, suffix := range []string{testOpenAISuffix, testAnthropicSuffix} {
		sb := &aigwv1beta1.AIServiceBackend{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + suffix, Namespace: testNamespace}, sb)).To(Succeed())
		sb.Status.Conditions = []metav1.Condition{{
			Type: aigwv1beta1.ConditionTypeAccepted, Status: metav1.ConditionTrue, Reason: aiAcceptedReason,
			LastTransitionTime: metav1.Now(), ObservedGeneration: sb.Generation,
		}}
		Expect(k8sClient.Status().Update(ctx, sb)).To(Succeed())
	}
}

// acceptOpenAIPathsRoute writes the status.parents a gateway reports for the
// shared OpenAI-paths HTTPRoute of the named catalog route. A route that does
// not exist yet is skipped: nothing is published there.
func acceptOpenAIPathsRoute(name aiv1alpha1.AIGatewayRouterName) {
	route := &gatewayv1.HTTPRoute{}
	err := k8sClient.Get(ctx, client.ObjectKey{Name: openAIPathsRouteName(name), Namespace: testGatewayNamespace}, route)
	if apierrors.IsNotFound(err) {
		return
	}
	Expect(err).NotTo(HaveOccurred())
	// Report the status for the Gateway the route actually declares: the
	// platform owns the attachment, and the private surface may name its own.
	parent := gatewayv1.ParentReference{
		Name:      gatewayv1.ObjectName(testGatewayName),
		Namespace: ptrTo(gatewayv1.Namespace(testGatewayNamespace)),
	}
	if len(route.Spec.ParentRefs) > 0 {
		parent = route.Spec.ParentRefs[0]
		if parent.Namespace == nil {
			parent.Namespace = ptrTo(gatewayv1.Namespace(route.Namespace))
		}
	}
	route.Status.Parents = gatewayRouteParents(parent, route.Generation, true, "", "")
	Expect(k8sClient.Status().Update(ctx, route)).To(Succeed())
}

// acceptRoute marks the catalog objects accepted by the Agent Router
// controller: the shared route and HTTPRoute (route-level) and the service's
// AIServiceBackends.
func acceptRoute(name string) {
	acceptSharedCatalogRoute()
	acceptAIServiceBackend(name)
}

// sharedHTTPRoute returns the OpenAI-paths HTTPRoute paired with the named
// catalog route, addressed in the gateway namespace.
func sharedHTTPRoute(name aiv1alpha1.AIGatewayRouterName) *gatewayv1.HTTPRoute {
	return &gatewayv1.HTTPRoute{ObjectMeta: metav1.ObjectMeta{Name: openAIPathsRouteName(name), Namespace: testGatewayNamespace}}
}

// resetCatalogState removes every published service the suite left behind and
// deletes both shared catalog surfaces. The operator's full-takeover sync builds
// the rules from every published service in the cluster, so a spec must see only
// the services it creates — otherwise another spec's model names compete for
// the catalog and its rules occupy the route.
func resetCatalogState() {
	ensureGatewayNamespace()
	var list aiv1alpha1.InferenceServiceList
	Expect(k8sClient.List(ctx, &list, client.InNamespace(testNamespace))).To(Succeed())
	for i := range list.Items {
		if list.Items[i].Spec.Route != nil && list.Items[i].Spec.Route.Published() {
			Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, &list.Items[i]))).To(Succeed())
		}
	}
	// The manager drops the catalog finalizer on the delete reconcile; wait for
	// the deletions to complete so no deleting service lingers in the list.
	Eventually(func(g Gomega) {
		var rest aiv1alpha1.InferenceServiceList
		g.Expect(k8sClient.List(ctx, &rest, client.InNamespace(testNamespace))).To(Succeed())
		for i := range rest.Items {
			if rest.Items[i].Spec.Route != nil && rest.Items[i].Spec.Route.Published() {
				g.Expect(rest.Items[i].Name).To(BeEmpty(), "service %q is still published", rest.Items[i].Name)
			}
		}
	}, "10s").Should(Succeed())
	for _, name := range catalogRouteNames {
		Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, catalogRouteNamed(name)))).To(Succeed())
		Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, sharedHTTPRoute(name)))).To(Succeed())
	}
}

// persistCatalogObjects writes the catalog objects a rule references — the
// Backend and the Anthropic-schema AIServiceBackend — without running a full
// reconcile. The shared rule set includes a published service only when those
// objects exist, so a spec that stages published services this way needs them.
func persistCatalogObjects(name string) {
	isvc := mustGetISVC(ctx, name)
	r := routeReconciler()
	Expect(k8sClient.Create(ctx, r.desiredBackend(isvc, routeProfile(name+"-prof"), 8001))).To(Succeed())
	Expect(k8sClient.Create(ctx, r.desiredAnthropicAIServiceBackend(isvc))).To(Succeed())
}

var _ = Describe("checkRoute", func() {
	readyEndpoint := func(name string) *endpointCheck {
		return &endpointCheck{Internal: name + "-router.default.svc:8001", Role: testApplyRouterRole}
	}

	BeforeEach(resetCatalogState)

	It("creates the shared catalog surfaces when the platform has not installed them", func() {
		name := "route-noshared"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		// The surfaces exist now, but no gateway has accepted them yet.
		Expect(check.Reason).To(Equal(RouteGatewayNotAccepted))

		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).NotTo(Equal(-1))
		Expect(string(route.Spec.ParentRefs[0].Name)).To(Equal(testGatewayName))

		// The plain OpenAI-paths HTTPRoute stays absent: every published path
		// rides on the AIGatewayRoute now.
		httpRoute := sharedHTTPRoute(testCatalogRoute)
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(httpRoute), httpRoute))).To(BeTrue())
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
		for suffix, schema := range map[string]aigwv1beta1.APISchema{
			testOpenAISuffix:    aigwv1beta1.APISchemaOpenAI,
			testAnthropicSuffix: aigwv1beta1.APISchemaAnthropic,
		} {
			sb := &aigwv1beta1.AIServiceBackend{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + suffix, Namespace: testNamespace}, sb)).To(Succeed())
			Expect(sb.Spec.APISchema.Name).To(Equal(schema))
			Expect(string(sb.Spec.BackendRef.Name)).To(Equal(name + "-endpoint"))
		}
		// The ReferenceGrant authorises both cross-namespace hops: the shared
		// catalog route to either AIServiceBackend, and the child HTTPRoute the
		// Agent Router expands that route into to this service's Backend.
		grant := &gatewayv1.ReferenceGrant{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-grant", Namespace: testNamespace}, grant)).To(Succeed())
		Expect(grant.Spec.To).To(HaveLen(3))
		Expect(string(grant.Spec.To[2].Group)).To(Equal(envoyGatewayAPIGroup))
		Expect(string(grant.Spec.To[2].Kind)).To(Equal(egBackendKind))
		Expect(string(*grant.Spec.To[2].Name)).To(Equal(name + "-endpoint"))

		// Both schemas are registered for the model: the native-Anthropic rule
		// (model + anthropic-version) comes first, then the OpenAI rule that
		// serves every other catalog path.
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(route.Spec.Rules).To(HaveLen(2))
		aiIdx := ruleIndexByRef(route.Spec.Rules, name+testAnthropicSuffix)
		oaIdx := ruleIndexByRef(route.Spec.Rules, name+testOpenAISuffix)
		Expect(aiIdx).To(Equal(0))
		Expect(oaIdx).To(Equal(1))
		anth := route.Spec.Rules[aiIdx]
		Expect(anth.Matches[0].Headers).To(HaveLen(2))
		Expect(anth.Matches[0].Headers[0].Value).To(Equal(testCatalogModelName))
		Expect(string(anth.Matches[0].Headers[1].Name)).To(Equal("anthropic-version"))
		Expect(anth.Matches[0].Headers[1].Value).To(Equal("2023-06-01"))
		Expect(anth.BackendRefs[0].ModelNameOverride).To(Equal(testEngineModel))
		Expect(string(*anth.StreamIdleTimeout)).To(Equal("0s"))
		oa := route.Spec.Rules[oaIdx]
		Expect(oa.Matches[0].Headers).To(HaveLen(1))
		Expect(oa.Matches[0].Headers[0].Value).To(Equal(testCatalogModelName))
		Expect(oa.BackendRefs[0].ModelNameOverride).To(Equal(testEngineModel))
		Expect(string(*oa.StreamIdleTimeout)).To(Equal("0s"))

		// No plain HTTPRoute is created next to it.
		httpRoute := sharedHTTPRoute(testCatalogRoute)
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(httpRoute), httpRoute))).To(BeTrue())

		// The Agent Router accepts; the next check reports the catalog entry ready.
		acceptRoute(name)
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())
	})

	It("creates only the selected paths", func() {
		ensureSharedCatalogRoute()
		name := "route-paths"
		isvc := routeISVC(name, true)
		isvc.Spec.Route.ModelName = "paths-model"
		isvc.Spec.Route.Paths = []aiv1alpha1.CatalogPath{aiv1alpha1.CatalogPathChatCompletions}
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		r := routeReconciler()
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteGatewayNotAccepted))

		// A chat-only selection still owns one catalog rule: the AIGatewayRoute
		// serves every published path through the OpenAI-schema backend.
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).NotTo(Equal(-1))

		httpRoute := sharedHTTPRoute(testCatalogRoute)
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(httpRoute), httpRoute))).To(BeTrue())

		// Readiness needs the shared route and the backend accepted.
		acceptCatalogRoute(testCatalogRoute)
		acceptAIServiceBackend(name)
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())
	})

	It("creates the rule in the private route when the service selects it", func() {
		ensureCatalogRoutes()
		name := "route-private"
		isvc := routeISVC(name, false)
		isvc.Spec.Route.AIGatewayRouter = aiv1alpha1.AIGatewayRouterPrivate
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		r := routeReconciler()
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteGatewayNotAccepted))

		private := privateCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(private), private)).To(Succeed())
		Expect(private.Spec.Rules).To(HaveLen(2))
		Expect(ruleIndexByRef(private.Spec.Rules, name+testAnthropicSuffix)).To(Equal(0))
		Expect(ruleIndexByRef(private.Spec.Rules, name+testOpenAISuffix)).To(Equal(1))
		public := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(public), public)).To(Succeed())
		Expect(findCatalogRuleIndex(public.Spec.Rules, mustGetISVC(ctx, name))).To(Equal(-1))
		// The plain HTTPRoute surface is retired for both visibilities.
		privateHTTP := sharedHTTPRoute(testPrivateCatalogRoute)
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(privateHTTP), privateHTTP))).To(BeTrue())
		publicHTTP := sharedHTTPRoute(testCatalogRoute)
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(publicHTTP), publicHTTP))).To(BeTrue())

		acceptCatalogRoute(testPrivateCatalogRoute)
		acceptAIServiceBackend(name)
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())
	})

	It("reports ready on the private route without any plain HTTPRoute", func() {
		ensureCatalogRoutes()
		name := "route-private-gateway"
		isvc := routeISVC(name, false)
		isvc.Spec.Route.AIGatewayRouter = aiv1alpha1.AIGatewayRouterPrivate
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		r := routeReconciler()
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteGatewayNotAccepted))

		// No plain HTTPRoute carries traffic for the private visibility either:
		// accepting the private catalog route and the service's OpenAI-schema
		// backend is what makes the entry ready.
		retired := sharedHTTPRoute(testPrivateCatalogRoute)
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(retired), retired))).To(BeTrue())

		acceptCatalogRoute(testPrivateCatalogRoute)
		acceptAIServiceBackend(name)
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())
	})

	It("moves the rule when the selected route changes", func() {
		ensureCatalogRoutes()
		name := "route-switch"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())

		// Public → private: the private rule appears and the public one goes —
		// from both surfaces.
		current := mustGetISVC(ctx, name)
		current.Spec.Route.AIGatewayRouter = aiv1alpha1.AIGatewayRouterPrivate
		Expect(k8sClient.Update(ctx, current)).To(Succeed())
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteGatewayNotAccepted))
		public := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(public), public)).To(Succeed())
		Expect(findCatalogRuleIndex(public.Spec.Rules, mustGetISVC(ctx, name))).To(Equal(-1))
		publicHTTP := sharedHTTPRoute(testCatalogRoute)
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(publicHTTP), publicHTTP))).To(BeTrue())
		private := privateCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(private), private)).To(Succeed())
		Expect(findCatalogRuleIndex(private.Spec.Rules, mustGetISVC(ctx, name))).NotTo(Equal(-1))

		// The private route accepts: the entry is live on the new route.
		acceptCatalogRoute(testPrivateCatalogRoute)
		acceptAIServiceBackend(name)
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())

		// Private → public: the move is symmetric.
		current = mustGetISVC(ctx, name)
		current.Spec.Route.AIGatewayRouter = aiv1alpha1.AIGatewayRouterPublic
		Expect(k8sClient.Update(ctx, current)).To(Succeed())
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteGatewayNotAccepted))
		acceptCatalogRoute(testCatalogRoute)
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(public), public)).To(Succeed())
		Expect(findCatalogRuleIndex(public.Spec.Rules, mustGetISVC(ctx, name))).NotTo(Equal(-1))
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(private), private)).To(Succeed())
		Expect(findCatalogRuleIndex(private.Spec.Rules, mustGetISVC(ctx, name))).To(Equal(-1))
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())
	})

	It("rebuilds the shared route with every published service's rule", func() {
		ensureSharedCatalogRoute()
		// Two services publish to the same route. The first to reconcile writes
		// the rules of every published service that has catalog objects; the
		// other has not reached a ready endpoint, so it contributes nothing yet.
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
		Expect(route.Spec.Rules).To(HaveLen(2))

		// The other service reconciles: its own rules are added, the first
		// pair is kept.
		_, err = r.checkRoute(ctx, mustGetISVC(ctx, "route-mine"), routeProfile("p1"), readyEndpoint("route-mine"), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(route.Spec.Rules).To(HaveLen(4))
		mine := route.Spec.Rules[ruleIndexByRef(route.Spec.Rules, "route-mine"+testOpenAISuffix)]
		theirs := route.Spec.Rules[ruleIndexByRef(route.Spec.Rules, "route-theirs"+testOpenAISuffix)]
		Expect(mine.Matches[0].Headers[0].Value).To(Equal(testCatalogModelName))
		Expect(theirs.Matches[0].Headers[0].Value).To(Equal("theirs-model"))
		// Each service's native-Anthropic rule sits immediately before its own
		// OpenAI rule, so the specific match wins for that model.
		mineAnth := route.Spec.Rules[ruleIndexByRef(route.Spec.Rules, "route-mine"+testAnthropicSuffix)]
		Expect(mineAnth.Matches[0].Headers[0].Value).To(Equal(testCatalogModelName))
		Expect(ruleIndexByRef(route.Spec.Rules, "route-mine"+testAnthropicSuffix) + 1).
			To(Equal(ruleIndexByRef(route.Spec.Rules, "route-mine"+testOpenAISuffix)))

		// The plain OpenAI-paths surface stays absent: every path rides on the
		// shared AIGatewayRoute.
		httpRoute := sharedHTTPRoute(testCatalogRoute)
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(httpRoute), httpRoute))).To(BeTrue())
	})

	It("reports ModelNameConflict for the later service claiming the same model name", func() {
		ensureSharedCatalogRoute()
		// The first-created service keeps the name; the later one — whichever
		// reconciles first — must lose all of its rules. Creation timestamps have
		// second granularity, so the names also order the two deterministically.
		other := routeISVC("route-other", true)
		Expect(k8sClient.Create(ctx, other)).To(Succeed())
		name := "route-other-later"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, "route-other"), routeProfile("po"), readyEndpoint("route-other"), testEngineModel)
		Expect(err).NotTo(HaveOccurred())

		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteModelNameConflict))
		// The conflicting service publishes nothing of its own, on either surface.
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).To(Equal(-1))
		httpRoute := sharedHTTPRoute(testCatalogRoute)
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(httpRoute), httpRoute))).To(BeTrue())
	})

	It("reports CatalogFull when the shared route is at its rule cap", func() {
		ensureSharedCatalogRoute()
		// The cap is enforced while rebuilding the full rule set: the first
		// catalogRuleMax services (oldest first) keep their /v1/messages rules.
		// Each service now contributes two rules — native Anthropic first, then
		// OpenAI — so the oldest catalogRuleMax/2 services fill the route and the
		// next one needs two free slots it cannot get.
		for i := range catalogRuleMax / 2 {
			name := "route-cap-" + strconv.Itoa(i)
			isvc := routeISVC(name, true)
			isvc.Spec.Route.ModelName = "cap-model-" + strconv.Itoa(i)
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			persistCatalogObjects(name)
		}
		name := "route-full"
		full := routeISVC(name, true)
		full.Spec.Route.ModelName = "cap-model-overflow"
		Expect(k8sClient.Create(ctx, full)).To(Succeed())

		check, err := routeReconciler().checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteCatalogFull))

		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(route.Spec.Rules).To(HaveLen(2 * (catalogRuleMax / 2)))
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).To(Equal(-1))
		// The overflow service is dropped from the only surface there is.
		httpRoute := sharedHTTPRoute(testCatalogRoute)
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(httpRoute), httpRoute))).To(BeTrue())
	})

	It("stages only published services whose catalog objects exist", func() {
		// A published service that has not reached a ready endpoint owns no
		// Backend, so its rule would reference something the shared route cannot
		// resolve. One dangling backendRef rejects the whole route, taking every
		// other service on it down with it.
		ensureSharedCatalogRoute()
		readySvc := "route-staged-ready"
		pending := "route-staged-pending"
		Expect(k8sClient.Create(ctx, routeISVC(readySvc, true))).To(Succeed())
		pendingISVC := routeISVC(pending, true)
		pendingISVC.Spec.Route.ModelName = "staged-pending-model"
		Expect(k8sClient.Create(ctx, pendingISVC)).To(Succeed())

		r := routeReconciler()
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, readySvc), routeProfile(readySvc+"-prof"), readyEndpoint(readySvc), testEngineModel)
		Expect(err).NotTo(HaveOccurred())

		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(route.Spec.Rules).To(HaveLen(2))
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, pending))).To(Equal(-1))
		httpRoute := sharedHTTPRoute(testCatalogRoute)
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(httpRoute), httpRoute))).To(BeTrue())

		// Its objects appear: the next rebuild picks it up.
		persistCatalogObjects(pending)
		_, err = r.checkRoute(ctx, mustGetISVC(ctx, readySvc), routeProfile(readySvc+"-prof"), readyEndpoint(readySvc), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(route.Spec.Rules).To(HaveLen(4))
	})

	It("does not create the shared surfaces when no Gateway name is configured", func() {
		// Publishing is off without a Gateway name, and the routes cannot be
		// created with an empty parentRef. The rebuild must leave them absent
		// instead of failing every unpublished service and blocking the
		// finalizer of a deleted one.
		name := "route-nogwname"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		persistCatalogObjects(name)

		r := routeReconciler()
		r.GatewayName = ""
		Expect(r.syncSharedCatalogRoutes(ctx)).To(Succeed())
		for _, routeName := range catalogRouteNames {
			Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(catalogRouteNamed(routeName)), catalogRouteNamed(routeName)))).To(BeTrue())
		}
		httpRoute := sharedHTTPRoute(testCatalogRoute)
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(httpRoute), httpRoute))).To(BeTrue())
	})

	It("publishes an OpenAI-only selection through the shared catalog route", func() {
		// Every published path rides on the AIGatewayRoute, so a chat-only
		// selection creates the shared route and waits for it to be accepted.
		name := "route-openai-only"
		isvc := routeISVC(name, true)
		isvc.Spec.Route.Paths = []aiv1alpha1.CatalogPath{aiv1alpha1.CatalogPathChatCompletions}
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())

		r := routeReconciler()
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteGatewayNotAccepted))
		route := catalogRouteNamed(testCatalogRoute)
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).NotTo(Equal(-1))

		// The shared route and the OpenAI-schema backend both accepted: live.
		acceptRoute(name)
		check, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(BeEmpty())
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

	It("reports NotPublished and deletes the catalog objects and rule when aigatewayRouter is cleared", func() {
		ensureCatalogRoutes()
		name := "route-off"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())

		// Publishing is turned off; the next pass must shed the rule and the
		// owned objects.
		current := mustGetISVC(ctx, name)
		current.Spec.Route.AIGatewayRouter = ""
		Expect(k8sClient.Update(ctx, current)).To(Succeed())

		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteNotPublished))

		backend := &egv1alpha1.Backend{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-endpoint", Namespace: testNamespace}, backend))).To(BeTrue())
		for _, suffix := range []string{testOpenAISuffix, testAnthropicSuffix} {
			sb := &aigwv1beta1.AIServiceBackend{}
			Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + suffix, Namespace: testNamespace}, sb))).To(BeTrue())
		}
		grant := &gatewayv1.ReferenceGrant{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-grant", Namespace: testNamespace}, grant))).To(BeTrue())
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).To(Equal(-1))
		route = privateCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).To(Equal(-1))
		// The OpenAI-paths HTTPRoute here was created by the operator, which
		// stamps its managed-by label on creation: with no rules left it is
		// removed rather than left attached with the CRD's defaulted catch-all
		// rule.
		httpRoute := sharedHTTPRoute(testCatalogRoute)
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(httpRoute), httpRoute))).To(BeTrue())
	})

	It("leaves a platform-installed OpenAI-paths HTTPRoute in place when nothing is published", func() {
		// The platform may install the shared surfaces itself. They carry no
		// managed-by label, so their lifetime is not the operator's: an empty rule
		// set — which the CRD cannot store — must not end in the object being
		// deleted.
		ensureSharedCatalogRoute()
		platform := &gatewayv1.HTTPRoute{
			ObjectMeta: metav1.ObjectMeta{Name: openAIPathsRouteName(testCatalogRoute), Namespace: testGatewayNamespace},
			Spec: gatewayv1.HTTPRouteSpec{
				CommonRouteSpec: gatewayv1.CommonRouteSpec{
					ParentRefs: []gatewayv1.ParentReference{{Name: gatewayv1.ObjectName(testGatewayName)}},
				},
				// The rule the last published service left: it references the
				// Backend cleanup deletes along with that service.
				Rules: []gatewayv1.HTTPRouteRule{{
					BackendRefs: []gatewayv1.HTTPBackendRef{{
						BackendRef: gatewayv1.BackendRef{
							BackendObjectReference: gatewayv1.BackendObjectReference{
								Group: ptrTo(gatewayv1.Group(envoyGatewayAPIGroup)),
								Kind:  ptrTo(gatewayv1.Kind(egBackendKind)),
								Name:  "gone-endpoint",
							},
						},
					}},
				}},
			},
		}
		Expect(k8sClient.Create(ctx, platform)).To(Succeed())

		Expect(routeReconciler().syncSharedCatalogRoutes(ctx)).To(Succeed())

		stored := sharedHTTPRoute(testCatalogRoute)
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(stored), stored)).To(Succeed())
		Expect(stored.Labels).NotTo(HaveKey(managedByLabelKey))
		// The stale backendRefs are gone: the object is left with the CRD's
		// default rule, which references nothing.
		Expect(stored.Spec.Rules).To(HaveLen(1))
		Expect(stored.Spec.Rules[0].BackendRefs).To(BeEmpty())
		Expect(stored.Spec.Rules[0].Filters).To(BeEmpty())

		// A second pass is a no-op: the neutralized object must not be rewritten
		// on every reconcile.
		before := stored.ResourceVersion
		Expect(routeReconciler().syncSharedCatalogRoutes(ctx)).To(Succeed())
		again := sharedHTTPRoute(testCatalogRoute)
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(again), again)).To(Succeed())
		Expect(again.ResourceVersion).To(Equal(before))
	})

	It("removes the rule from both shared routes when a service is deleted", func() {
		// The finalizer path: a service being deleted must shed its rule before it
		// goes. The rule lives in another namespace and is not owned by the
		// service, so the finalizer is what removes it. The spec may already name
		// the other route by then, so cleanup must cover both.
		ensureCatalogRoutes()
		name := "route-del"
		isvc := routeISVC(name, true)
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		r := routeReconciler()
		_, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).NotTo(Equal(-1))

		// The service is deleted after its spec switched to the other route:
		// cleanup must still find and remove the public rule.
		current := mustGetISVC(ctx, name)
		current.Spec.Route.AIGatewayRouter = testPrivateCatalogRoute
		Expect(k8sClient.Update(ctx, current)).To(Succeed())
		Expect(r.syncSharedCatalogRoutes(ctx)).To(Succeed())
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))).To(Equal(-1))
	})

	It("gives the grant the same name-and-owner contract as the AIServiceBackends", func() {
		// The grant is what authorises the child HTTPRoute to reach the
		// Backend, so it must disappear with the service exactly like the
		// AIServiceBackends do: a fixed name derived from the service and a
		// controller ownerRef to it. Anything cluster-wide and unowned would
		// outlive the service and keep authorising a backend that is gone.
		// (The deletion itself is the API server's garbage collector, which
		// envtest does not run, so this asserts the contract it acts on.)
		ensureSharedCatalogRoute()
		name := "route-cascade"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		_, err := routeReconciler().checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())

		live := mustGetISVC(ctx, name)
		grant := &gatewayv1.ReferenceGrant{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-grant", Namespace: testNamespace}, grant)).To(Succeed())
		Expect(grant.Name).To(Equal(referenceGrantName(live)))
		Expect(grant.Spec.To).To(HaveLen(3))

		sb := &aigwv1beta1.AIServiceBackend{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testOpenAISuffix, Namespace: testNamespace}, sb)).To(Succeed())

		// The same owner the AIServiceBackends carry: same kind, name and UID,
		// controller=true — so the API server collects the grant on the same
		// delete as the backends.
		Expect(metav1.IsControlledBy(grant, live)).To(BeTrue())
		Expect(metav1.IsControlledBy(sb, live)).To(BeTrue())
		Expect(grant.OwnerReferences).To(Equal(sb.OwnerReferences))
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

	It("rebuilds the route when the declared timeout changes, keeping the other rules", func() {
		ensureSharedCatalogRoute()
		name := "route-update"
		isvc := isvcForApply(name)
		isvc.Spec.Route = &aiv1alpha1.RouteSpec{AIGatewayRouter: aiv1alpha1.AIGatewayRouterPublic, ModelName: "update-model", TimeoutSeconds: ptrTo[int64](60)}
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		other := routeISVC("route-update-other", true)
		other.Spec.Route.ModelName = "update-other"
		Expect(k8sClient.Create(ctx, other)).To(Succeed())
		r := routeReconciler()
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
		Expect(route.Spec.Rules[theirsIdx].BackendRefs[0].Name).To(Equal("route-update-other" + testOpenAISuffix))

		// The in-cluster spec changes the timeout; the next pass rebuilds the set.
		current := mustGetISVC(ctx, name)
		*current.Spec.Route.TimeoutSeconds = 30
		Expect(k8sClient.Update(ctx, current)).To(Succeed())

		_, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(route.Spec.Rules).To(HaveLen(4))
		Expect(route.Spec.Rules[findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))].Timeouts.Request).To(HaveValue(Equal(gatewayv1.Duration("30s"))))
		Expect(route.Spec.Rules[findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, "route-update-other"))].Timeouts.Request).To(HaveValue(Equal(gatewayv1.Duration("60s"))))
	})

	It("sees no drift in the objects a real API server stored", func() {
		ensureSharedCatalogRoute()
		name := "route-stored"
		isvc := isvcForApply(name)
		isvc.Spec.Route = &aiv1alpha1.RouteSpec{AIGatewayRouter: aiv1alpha1.AIGatewayRouterPublic, ModelName: "stored-model", TimeoutSeconds: ptrTo[int64](60)}
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
		stored(sb, name+testOpenAISuffix, testNamespace)
		anthropicSB := &aigwv1beta1.AIServiceBackend{}
		stored(anthropicSB, name+testAnthropicSuffix, testNamespace)
		grant := &gatewayv1.ReferenceGrant{}
		stored(grant, name+"-grant", testNamespace)
		route := sharedCatalogRoute()
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		myIdx := findCatalogRuleIndex(route.Spec.Rules, mustGetISVC(ctx, name))
		myRule := route.Spec.Rules[myIdx]
		routeRV := route.ResourceVersion
		// The retired plain HTTPRoute is not part of the stored set any more.
		retired := sharedHTTPRoute(testCatalogRoute)

		// A second pass must touch none of the objects or the rules: the shared
		// routes' RVs are stable because nothing changed.
		_, err = r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		after := &egv1alpha1.Backend{}
		stored(after, name+"-endpoint", testNamespace)
		Expect(after.ResourceVersion).To(Equal(backend.ResourceVersion))
		afterSB := &aigwv1beta1.AIServiceBackend{}
		stored(afterSB, name+testOpenAISuffix, testNamespace)
		Expect(afterSB.ResourceVersion).To(Equal(sb.ResourceVersion))
		afterAnthropic := &aigwv1beta1.AIServiceBackend{}
		stored(afterAnthropic, name+testAnthropicSuffix, testNamespace)
		Expect(afterAnthropic.ResourceVersion).To(Equal(anthropicSB.ResourceVersion))
		afterGrant := &gatewayv1.ReferenceGrant{}
		stored(afterGrant, name+"-grant", testNamespace)
		Expect(afterGrant.ResourceVersion).To(Equal(grant.ResourceVersion))
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(route), route)).To(Succeed())
		Expect(route.ResourceVersion).To(Equal(routeRV))
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKeyFromObject(retired), retired))).To(BeTrue())

		// A genuine change is still drift: a different endpoint or schema must
		// update, or the catalog would keep serving the old object after the
		// spec changed.
		Expect(backendNeedsUpdate(after, r.desiredBackend(mustGetISVC(ctx, name), routeProfile(name+"-prof"), 8002))).To(BeTrue())
		otherSchema := r.desiredAIServiceBackend(mustGetISVC(ctx, name))
		otherSchema.Spec.APISchema.Name = aigwv1beta1.APISchemaAWSBedrock
		Expect(aiServiceBackendNeedsUpdate(afterSB, otherSchema)).To(BeTrue())
		_ = myRule
	})

	It("adds the Backend authorization to a ReferenceGrant created before it was needed", func() {
		ensureSharedCatalogRoute()
		name := "route-legacy-grant"
		isvc := isvcForApply(name)
		isvc.Spec.Route = &aiv1alpha1.RouteSpec{AIGatewayRouter: aiv1alpha1.AIGatewayRouterPublic, ModelName: "legacy-grant-model", TimeoutSeconds: ptrTo[int64](60)}
		Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		// The shape every grant shipped before this fix has: the two
		// AIServiceBackends and no Backend, which left the child HTTPRoute the
		// Agent Router expands the route into unresolvable.
		legacy := &gatewayv1.ReferenceGrant{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-grant", Namespace: testNamespace},
			Spec: gatewayv1.ReferenceGrantSpec{
				From: []gatewayv1.ReferenceGrantFrom{{
					Group:     gatewayv1.Group("aigateway.envoyproxy.io"),
					Kind:      gatewayv1.Kind("AIGatewayRoute"),
					Namespace: gatewayv1.Namespace(testGatewayNamespace),
				}},
				To: []gatewayv1.ReferenceGrantTo{
					{
						Group: gatewayv1.Group("aigateway.envoyproxy.io"),
						Kind:  gatewayv1.Kind("AIServiceBackend"),
						Name:  ptrTo(gatewayv1.ObjectName(name + testOpenAISuffix)),
					},
					{
						Group: gatewayv1.Group("aigateway.envoyproxy.io"),
						Kind:  gatewayv1.Kind("AIServiceBackend"),
						Name:  ptrTo(gatewayv1.ObjectName(name + testAnthropicSuffix)),
					},
				},
			},
		}
		Expect(k8sClient.Create(ctx, legacy)).To(Succeed())
		// A shipped grant carries the controller reference: the apply path only
		// rewrites objects it controls.
		Expect(ctrl.SetControllerReference(mustGetISVC(ctx, name), legacy, routeReconciler().Scheme)).To(Succeed())
		Expect(k8sClient.Update(ctx, legacy)).To(Succeed())

		_, err := routeReconciler().checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())

		grant := &gatewayv1.ReferenceGrant{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-grant", Namespace: testNamespace}, grant)).To(Succeed())
		Expect(grant.Spec.To).To(HaveLen(3))
		Expect(string(grant.Spec.To[2].Group)).To(Equal(envoyGatewayAPIGroup))
		Expect(string(grant.Spec.To[2].Kind)).To(Equal(egBackendKind))
		Expect(string(*grant.Spec.To[2].Name)).To(Equal(name + "-endpoint"))
		Expect(metav1.IsControlledBy(grant, mustGetISVC(ctx, name))).To(BeTrue())
	})

	It("does not report acceptance from a stale status after a spec update", func() {
		ensureSharedCatalogRoute()
		name := "route-stale"
		isvc := isvcForApply(name)
		isvc.Spec.Route = &aiv1alpha1.RouteSpec{AIGatewayRouter: aiv1alpha1.AIGatewayRouterPublic, ModelName: "stale-model", TimeoutSeconds: ptrTo[int64](60)}
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

	It("reports GatewayNotConfigured when the shared routes' namespace is not configured", func() {
		ensureSharedCatalogRoute()
		name := "route-nons"
		Expect(k8sClient.Create(ctx, routeISVC(name, true))).To(Succeed())
		r := routeReconciler()
		r.GatewayNamespace = ""
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteGatewayNotConfigured))
	})

	It("leaves the shared routes alone when no gateway is configured", func() {
		// The reconcile of an unpublished service rebuilds the shared routes to
		// shed a rule it may have had. Without a gateway namespace there is no
		// route to address, so the pass must succeed without one — an empty
		// namespace fails a direct-client Get.
		name := "route-nocfg"
		Expect(k8sClient.Create(ctx, routeISVC(name, false))).To(Succeed())
		r := routeReconciler()
		r.GatewayName = ""
		r.GatewayNamespace = ""
		check, err := r.checkRoute(ctx, mustGetISVC(ctx, name), routeProfile(name+"-prof"), readyEndpoint(name), testEngineModel)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal(RouteNotPublished))
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

	It("renders the ReferenceGrant authorising both cross-namespace hops to the catalog objects", func() {
		isvc := routeISVC("catalog-isvc", true)
		grant := routeReconciler().desiredReferenceGrant(isvc)

		Expect(grant.Name).To(Equal("catalog-isvc-grant"))
		Expect(grant.Namespace).To(Equal(testNamespace))
		expectCatalogLabels(grant.Labels)
		// The shared AIGatewayRoute references the AIServiceBackends; the child
		// HTTPRoute the Agent Router expands it into references the Backend.
		Expect(grant.Spec.From).To(HaveLen(2))
		Expect(string(grant.Spec.From[0].Group)).To(Equal("aigateway.envoyproxy.io"))
		Expect(string(grant.Spec.From[0].Kind)).To(Equal("AIGatewayRoute"))
		Expect(string(grant.Spec.From[0].Namespace)).To(Equal(testGatewayNamespace))
		Expect(string(grant.Spec.From[1].Group)).To(Equal("gateway.networking.k8s.io"))
		Expect(string(grant.Spec.From[1].Kind)).To(Equal("HTTPRoute"))
		Expect(string(grant.Spec.From[1].Namespace)).To(Equal(testGatewayNamespace))
		Expect(grant.Spec.To).To(HaveLen(3))
		for i, want := range []string{"catalog-isvc-backend", "catalog-isvc-anthropic"} {
			Expect(string(grant.Spec.To[i].Group)).To(Equal("aigateway.envoyproxy.io"))
			Expect(string(grant.Spec.To[i].Kind)).To(Equal("AIServiceBackend"))
			Expect(string(*grant.Spec.To[i].Name)).To(Equal(want))
		}
		Expect(string(grant.Spec.To[2].Group)).To(Equal("gateway.envoyproxy.io"))
		Expect(string(grant.Spec.To[2].Kind)).To(Equal("Backend"))
		Expect(string(*grant.Spec.To[2].Name)).To(Equal("catalog-isvc-endpoint"))
		Expect(metav1.IsControlledBy(grant, isvc)).To(BeTrue())
	})

	It("renders the Anthropic-schema AIServiceBackend over the same Backend", func() {
		isvc := routeISVC("catalog-isvc", true)
		sb := routeReconciler().desiredAnthropicAIServiceBackend(isvc)

		Expect(sb.Name).To(Equal("catalog-isvc-anthropic"))
		expectCatalogLabels(sb.Labels)
		Expect(sb.Spec.APISchema.Name).To(Equal(aigwv1beta1.APISchemaAnthropic))
		Expect(string(sb.Spec.BackendRef.Name)).To(Equal("catalog-isvc-endpoint"))
		Expect(metav1.IsControlledBy(sb, isvc)).To(BeTrue())
	})

	It("renders the shared-route rule matched on the model name", func() {
		isvc := routeISVC("catalog-isvc", true)
		rule := routeReconciler().catalogRuleFor(isvc, "qwen38-27b")

		Expect(rule.Matches[0].Headers).To(Equal([]gatewayv1.HTTPHeaderMatch{{
			Type:  ptrTo(gatewayv1.HeaderMatchExact),
			Name:  gatewayv1.HTTPHeaderName(aiModelHeaderName),
			Value: testCatalogModelName, // the route.modelName routeISVC declares
		}}))
		Expect(rule.BackendRefs[0].Name).To(Equal("catalog-isvc" + testOpenAISuffix))
		Expect(string(*rule.BackendRefs[0].Namespace)).To(Equal(testNamespace))
		Expect(rule.BackendRefs[0].ModelNameOverride).To(Equal("qwen38-27b"))
		Expect(rule.BackendRefs[0].Weight).To(HaveValue(Equal(int32(1))))
		Expect(rule.BackendRefs[0].Priority).To(HaveValue(Equal(uint32(0))))
		Expect(rule.Timeouts.Request).To(HaveValue(Equal(gatewayv1.Duration("60s"))))
		Expect(rule.StreamIdleTimeout).To(HaveValue(Equal(gatewayv1.Duration("0s"))))
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

var _ = Describe("routeParentsAcceptedForRef", func() {
	refWithSection := func(section string) gatewayv1.ParentReference {
		return gatewayv1.ParentReference{
			Name:        gatewayv1.ObjectName(testGatewayName),
			Namespace:   ptrTo(gatewayv1.Namespace(testGatewayNamespace)),
			SectionName: ptrTo(gatewayv1.SectionName(section)),
		}
	}
	statusFor := func(ref gatewayv1.ParentReference, accepted bool) gatewayv1.RouteParentStatus {
		reason := ""
		if !accepted {
			reason = string(gatewayv1.RouteReasonNoMatchingParent)
		}
		return gatewayRouteParents(ref, 3, accepted, reason, "")[0]
	}

	It("reads the status of the listener it asked about", func() {
		// Two listeners on one Gateway: the first status entry rejects another
		// section, the second accepts this ref. Matching on name and namespace
		// alone would return the rejection.
		parents := []gatewayv1.RouteParentStatus{
			statusFor(refWithSection("public"), false),
			statusFor(refWithSection("private"), true),
		}
		Expect(routeParentsAcceptedForRef(parents, 3, refWithSection("private"), testGatewayNamespace)).To(BeTrue())
		Expect(routeParentsAcceptedForRef(parents, 3, refWithSection("public"), testGatewayNamespace)).To(BeFalse())
	})

	It("does not borrow another listener's acceptance", func() {
		parents := []gatewayv1.RouteParentStatus{statusFor(refWithSection("public"), true)}
		Expect(routeParentsAcceptedForRef(parents, 3, refWithSection("private"), testGatewayNamespace)).To(BeFalse())
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
