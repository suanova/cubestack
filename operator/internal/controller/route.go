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
	"slices"
	"strconv"
	"strings"

	aigwv1beta1 "github.com/envoyproxy/ai-gateway/api/v1beta1"
	egv1alpha1 "github.com/envoyproxy/gateway/api/v1alpha1"

	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// Reasons reported by checkRoute when the route is not published or cannot be
// published ("" means the route is published and accepted by the Agent Router).
const (
	RouteNotPublished           = "NotPublished"
	RouteModelNameConflict      = "ModelNameConflict"
	RouteGatewayNotConfigured   = "GatewayNotConfigured"
	RouteGatewayNotAccepted     = "GatewayNotAccepted"
	RouteAgentRouterUnavailable = "AgentRouterUnavailable"
	// RouteCatalogFull is reported when adding this service's rule would put the
	// shared route over its rule cap (catalogRuleMax).
	RouteCatalogFull = "CatalogFull"
)

// routeCheck reports the route-publish outcome.
type routeCheck struct {
	Reason string // NotPublished | ModelNameConflict | GatewayNotConfigured | CatalogFull | EndpointNotReady | AgentRouterUnavailable | GatewayNotAccepted | ""
	Err    error  // API-level failure
}

// Kinds, API groups and the fixed fields of the Agent Router catalog objects a
// published service owns: the Envoy Gateway Backend naming the endpoint pool,
// two AIServiceBackends declaring the upstream schema over that Backend (one
// OpenAI, one Anthropic — the schema is a property of the AIServiceBackend, so
// the Anthropic surface cannot share the OpenAI object), and the ReferenceGrant
// authorising the shared catalog route (in the Gateway's namespace) to
// reference either of them. The Backend type, weight, priority and
// modelsOwnedBy are spelled explicitly so the API server's defaults never read
// as drift. The plain OpenAI-paths HTTPRoute reaches the Backend through the
// platform's namespace-wide cubestack-ai-gateway-backends grant.
const (
	envoyGatewayAPIGroup = "gateway.envoyproxy.io"
	egBackendKind        = "Backend"
	aiModelHeaderName    = "x-ai-eg-model"
	catalogOwnedBy       = "CubeStack"
	// catalogRuleMax is the AIGatewayRoute rule cap: the CRD allows at most 15
	// rules (one slot is reserved for the controller's catch-all), so a shared
	// route can hold at most this many published models.
	catalogRuleMax = 15
	// openAIPathsRuleMax is the HTTPRoute rule cap. Each model contributes one
	// rule per selected OpenAI path, so a full catalog surface can hold only a
	// few models when every path is exposed.
	openAIPathsRuleMax = 16
)

// Names of the catalog objects a published service owns.
func backendName(isvc *aiv1alpha1.InferenceService) string { return isvc.Name + "-endpoint" }
func aiServiceBackendName(isvc *aiv1alpha1.InferenceService) string {
	return isvc.Name + "-backend"
}
func anthropicServiceBackendName(isvc *aiv1alpha1.InferenceService) string {
	return isvc.Name + "-anthropic"
}
func referenceGrantName(isvc *aiv1alpha1.InferenceService) string { return isvc.Name + "-grant" }

// openAIPathsRouteName is the shared plain HTTPRoute that serves the OpenAI
// paths of the named catalog route. It lives beside the AIGatewayRoute in
// GatewayNamespace and is maintained in full by the operator.
func openAIPathsRouteName(route aiv1alpha1.AIGatewayRouterName) string {
	if route == aiv1alpha1.AIGatewayRouterPrivate {
		return "cubestack-openai-paths-private"
	}
	return "cubestack-openai-paths"
}

// catalogOpenAIPaths are the paths served directly by the plain HTTPRoute.
// /v1/messages is not among them: the Agent Router serves it through the
// Anthropic-schema AIServiceBackend.
var catalogOpenAIPaths = []aiv1alpha1.CatalogPath{
	aiv1alpha1.CatalogPathChatCompletions,
	aiv1alpha1.CatalogPathResponses,
	aiv1alpha1.CatalogPathImages,
}

// sharedRouteLabels are the labels the two shared catalog surfaces carry.
func sharedRouteLabels() map[string]string {
	return map[string]string{managedByLabelKey: managedByValue}
}

// routeLabels are the labels every catalog object carries.
func routeLabels(isvc *aiv1alpha1.InferenceService) map[string]string {
	return map[string]string{
		inferenceServiceLabelKey: isvc.Name,
		profileLabelKey:          isvc.Spec.ProfileRef,
		managedByLabelKey:        managedByValue,
	}
}

// desiredBackend builds the Envoy Gateway Backend an AIServiceBackend must
// reference: an FQDN endpoint pointing at the endpoint role's Service.
func (r *InferenceServiceReconciler) desiredBackend(isvc *aiv1alpha1.InferenceService, profile *aiv1alpha1.InferenceRuntimeProfile, port int32) *egv1alpha1.Backend {
	backend := &egv1alpha1.Backend{
		ObjectMeta: metav1.ObjectMeta{Name: backendName(isvc), Namespace: isvc.Namespace, Labels: routeLabels(isvc)},
		Spec: egv1alpha1.BackendSpec{
			Type: ptr(egv1alpha1.BackendTypeEndpoints),
			Endpoints: []egv1alpha1.BackendEndpoint{{
				FQDN: &egv1alpha1.FQDNEndpoint{
					Hostname: fmt.Sprintf("%s-%s.%s.svc.cluster.local", isvc.Name, profile.Spec.Endpoint.Role, isvc.Namespace),
					Port:     port,
				},
			}},
		},
	}
	_ = ctrl.SetControllerReference(isvc, backend, r.Scheme)
	return backend
}

// desiredAIServiceBackend builds the AIServiceBackend declaring the OpenAI
// upstream schema (the model servers are vLLM) and referencing the Backend.
func (r *InferenceServiceReconciler) desiredAIServiceBackend(isvc *aiv1alpha1.InferenceService) *aigwv1beta1.AIServiceBackend {
	return r.desiredAIServiceBackendFor(isvc, aiServiceBackendName(isvc), aigwv1beta1.APISchemaOpenAI)
}

// desiredAnthropicAIServiceBackend builds a second AIServiceBackend over the
// same Backend, declaring the Anthropic schema. The schema is a property of the
// AIServiceBackend, so the Anthropic surface cannot share the OpenAI object;
// one per published service is what lets the Agent Router serve /v1/messages.
func (r *InferenceServiceReconciler) desiredAnthropicAIServiceBackend(isvc *aiv1alpha1.InferenceService) *aigwv1beta1.AIServiceBackend {
	return r.desiredAIServiceBackendFor(isvc, anthropicServiceBackendName(isvc), aigwv1beta1.APISchemaAnthropic)
}

func (r *InferenceServiceReconciler) desiredAIServiceBackendFor(isvc *aiv1alpha1.InferenceService, name string, schema aigwv1beta1.APISchema) *aigwv1beta1.AIServiceBackend {
	sb := &aigwv1beta1.AIServiceBackend{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: isvc.Namespace, Labels: routeLabels(isvc)},
		Spec: aigwv1beta1.AIServiceBackendSpec{
			APISchema: aigwv1beta1.VersionedAPISchema{Name: schema},
			BackendRef: gatewayv1.BackendObjectReference{
				Group: ptr(gatewayv1.Group(envoyGatewayAPIGroup)),
				Kind:  ptr(gatewayv1.Kind(egBackendKind)),
				Name:  gatewayv1.ObjectName(backendName(isvc)),
			},
		},
	}
	_ = ctrl.SetControllerReference(isvc, sb, r.Scheme)
	return sb
}

// desiredReferenceGrant builds the ReferenceGrant, in the service's namespace,
// that authorises the shared catalog AIGatewayRoute (in the Gateway's
// namespace) to reference this service's AIServiceBackends — the route's
// backendRef is what crosses the namespace boundary. Both schemas are named so
// the grant survives a switch between the OpenAI and Anthropic rules. The
// Backend itself is referenced by the plain OpenAI-paths HTTPRoute, which the
// platform's namespace-wide cubestack-ai-gateway-backends grant already covers.
func (r *InferenceServiceReconciler) desiredReferenceGrant(isvc *aiv1alpha1.InferenceService) *gatewayv1.ReferenceGrant {
	grant := &gatewayv1.ReferenceGrant{
		ObjectMeta: metav1.ObjectMeta{Name: referenceGrantName(isvc), Namespace: isvc.Namespace, Labels: routeLabels(isvc)},
		Spec: gatewayv1.ReferenceGrantSpec{
			From: []gatewayv1.ReferenceGrantFrom{{
				Group:     gatewayv1.Group(aigwv1beta1.GroupName),
				Kind:      gatewayv1.Kind("AIGatewayRoute"),
				Namespace: gatewayv1.Namespace(r.GatewayNamespace),
			}},
			To: []gatewayv1.ReferenceGrantTo{
				{
					Group: gatewayv1.Group(aigwv1beta1.GroupName),
					Kind:  gatewayv1.Kind("AIServiceBackend"),
					Name:  ptr(gatewayv1.ObjectName(aiServiceBackendName(isvc))),
				},
				{
					Group: gatewayv1.Group(aigwv1beta1.GroupName),
					Kind:  gatewayv1.Kind("AIServiceBackend"),
					Name:  ptr(gatewayv1.ObjectName(anthropicServiceBackendName(isvc))),
				},
			},
		},
	}
	_ = ctrl.SetControllerReference(isvc, grant, r.Scheme)
	return grant
}

// catalogRuleFor builds the one rule of the shared catalog route this service
// contributes for /v1/messages: a match on the catalog model name — set by the
// Agent Router's ext_proc from the request body's "model" field and injected as
// the x-ai-eg-model header — routing to the service's Anthropic-schema
// AIServiceBackend (in its namespace, hence the explicit Namespace and the
// ReferenceGrant) with the engine's served model name written back over it. The
// per-service timeouts and the owned-by tag ride on the rule, as the shared
// route is a single object.
func (r *InferenceServiceReconciler) catalogRuleFor(isvc *aiv1alpha1.InferenceService, modelName string) aigwv1beta1.AIGatewayRouteRule {
	timeout := int64(0)
	if isvc.Spec.Route != nil && isvc.Spec.Route.TimeoutSeconds != nil {
		timeout = *isvc.Spec.Route.TimeoutSeconds
	}
	idle := int64(300)
	if isvc.Spec.Route != nil && isvc.Spec.Route.IdleTimeoutSeconds != nil {
		idle = *isvc.Spec.Route.IdleTimeoutSeconds
	}
	return aigwv1beta1.AIGatewayRouteRule{
		Matches: []aigwv1beta1.AIGatewayRouteRuleMatch{{
			Headers: []gatewayv1.HTTPHeaderMatch{{
				Type:  ptr(gatewayv1.HeaderMatchExact),
				Name:  gatewayv1.HTTPHeaderName(aiModelHeaderName),
				Value: isvc.Spec.Route.ModelName,
			}},
		}},
		BackendRefs: []aigwv1beta1.AIGatewayRouteRuleBackendRef{{
			Name:              anthropicServiceBackendName(isvc),
			Namespace:         ptr(gatewayv1.Namespace(isvc.Namespace)),
			ModelNameOverride: modelName,
			Weight:            ptr(int32(1)),
			Priority:          ptr(uint32(0)),
		}},
		Timeouts:          &gatewayv1.HTTPRouteTimeouts{Request: ptr(gatewayv1.Duration(fmt.Sprintf("%ds", timeout)))},
		StreamIdleTimeout: ptr(gatewayv1.Duration(fmt.Sprintf("%ds", idle))),
		ModelsOwnedBy:     ptr(catalogOwnedBy),
	}
}

// openAIPathsRuleFor builds the rule the shared plain HTTPRoute carries for one
// selected OpenAI path of this service: a path match narrowed by the
// x-ai-eg-model header (a plain HTTPRoute cannot parse the request body, so the
// client sends the catalog name as a header) forwarding directly to the
// service's Envoy Gateway Backend. The Backend is in the service's namespace,
// hence the explicit namespace; the platform's namespace-wide
// cubestack-ai-gateway-backends ReferenceGrant authorises the cross-namespace
// reference. request timeouts follow the catalog contract: 0s disables the cap.
func (r *InferenceServiceReconciler) openAIPathsRuleFor(isvc *aiv1alpha1.InferenceService, path aiv1alpha1.CatalogPath) gatewayv1.HTTPRouteRule {
	timeout := int64(0)
	if isvc.Spec.Route != nil && isvc.Spec.Route.TimeoutSeconds != nil {
		timeout = *isvc.Spec.Route.TimeoutSeconds
	}
	return gatewayv1.HTTPRouteRule{
		Matches: []gatewayv1.HTTPRouteMatch{{
			Path: &gatewayv1.HTTPPathMatch{
				Type:  ptr(gatewayv1.PathMatchPathPrefix),
				Value: ptr(string(path)),
			},
			Headers: []gatewayv1.HTTPHeaderMatch{{
				Type:  ptr(gatewayv1.HeaderMatchExact),
				Name:  gatewayv1.HTTPHeaderName(aiModelHeaderName),
				Value: isvc.Spec.Route.ModelName,
			}},
		}},
		BackendRefs: []gatewayv1.HTTPBackendRef{{
			BackendRef: gatewayv1.BackendRef{
				BackendObjectReference: gatewayv1.BackendObjectReference{
					Group:     ptr(gatewayv1.Group(envoyGatewayAPIGroup)),
					Kind:      ptr(gatewayv1.Kind(egBackendKind)),
					Name:      gatewayv1.ObjectName(backendName(isvc)),
					Namespace: ptr(gatewayv1.Namespace(isvc.Namespace)),
				},
				Weight: ptr(int32(1)),
			},
		}},
		Timeouts: &gatewayv1.HTTPRouteTimeouts{Request: ptr(gatewayv1.Duration(fmt.Sprintf("%ds", timeout)))},
	}
}

// catalogRuleLocator reports whether a rule belongs to this service: it is the
// one whose first backendRef is this service's AIServiceBackend (namespace and
// name). The locator is stable across modelName changes and unique per service,
// unlike the rule name or the header value.
func catalogRuleIsMine(rule aigwv1beta1.AIGatewayRouteRule, isvc *aiv1alpha1.InferenceService) bool {
	if len(rule.BackendRefs) == 0 {
		return false
	}
	ref := rule.BackendRefs[0]
	if ref.Name != anthropicServiceBackendName(isvc) {
		return false
	}
	if ref.Namespace == nil {
		return false
	}
	return string(*ref.Namespace) == isvc.Namespace
}

// findCatalogRuleIndex returns the index of this service's rule in the shared
// route's rules, or -1 when absent.
func findCatalogRuleIndex(rules []aigwv1beta1.AIGatewayRouteRule, isvc *aiv1alpha1.InferenceService) int {
	for i := range rules {
		if catalogRuleIsMine(rules[i], isvc) {
			return i
		}
	}
	return -1
}

// catalogRuleEqual reports whether two rules are identical for the purpose of
// deciding whether a write is needed. modelsCreatedAt is zeroed on both sides:
// the shared route is a single object owned by the platform, and a rule's
// modelsCreatedAt can be set out from under us, so it must never read as drift
// of our own write — the same reason the per-service comparison used to skip
// the API server's parentRef defaults.
func catalogRuleEqual(a, b aigwv1beta1.AIGatewayRouteRule) bool {
	a.ModelsCreatedAt = nil
	b.ModelsCreatedAt = nil
	return apiequality.Semantic.DeepEqual(a, b)
}

// catalogRulesEqual compares two rule sets positionally, with the same
// modelsCreatedAt-blind equality as catalogRuleEqual.
func catalogRulesEqual(a, b []aigwv1beta1.AIGatewayRouteRule) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !catalogRuleEqual(a[i], b[i]) {
			return false
		}
	}
	return true
}

// sharedRuleSet is the complete set of rules the operator maintains in one
// catalog surface, built from every published service attached to the route.
// The two flags report why the service being reconciled, when known, did not
// end up with its own rule.
type sharedRuleSet struct {
	ai        []aigwv1beta1.AIGatewayRouteRule
	openAI    []gatewayv1.HTTPRouteRule
	nameTaken bool // its model name is claimed by an earlier service
	routeFull bool // its rules would exceed a shared route's rule cap
}

// desiredSharedRuleSet lists every published service on routeName and builds
// the full rule sets for the AIGatewayRoute and its OpenAI-paths HTTPRoute. The
// operator owns both surfaces: the rules are replaced wholesale, so a rule left
// behind by a deleted service or added by hand disappears on the next pass.
//
// The list is filtered in memory rather than through the route index: the index
// backs the watches, while this pass needs every field of every candidate and
// runs against whatever client the reconciler holds.
//
// Services are ordered by creation time (then namespace/name), so the first
// service to claim a catalog model name keeps it. A duplicate loses all of its
// rules and reports a conflict. Each shared surface has its own rule cap — 15
// for the AIGatewayRoute and 16 for the HTTPRoute, which spends one rule per
// selected OpenAI path — and a service whose rules would overflow one is given
// none of that surface's rules and reports the route full. The current
// service, when non-nil, is matched by UID so a status echo lagging behind the
// freshly resolved engine name does not build a stale override.
func (r *InferenceServiceReconciler) desiredSharedRuleSet(ctx context.Context, routeName aiv1alpha1.AIGatewayRouterName, current *aiv1alpha1.InferenceService, currentModelName string) (*sharedRuleSet, error) {
	var list aiv1alpha1.InferenceServiceList
	if err := r.List(ctx, &list); err != nil {
		return nil, err
	}
	slices.SortFunc(list.Items, func(a, b aiv1alpha1.InferenceService) int {
		if c := a.CreationTimestamp.Compare(b.CreationTimestamp.Time); c != 0 {
			return c
		}
		if c := strings.Compare(a.Namespace, b.Namespace); c != 0 {
			return c
		}
		return strings.Compare(a.Name, b.Name)
	})
	set := &sharedRuleSet{}
	claimed := map[string]bool{}
	for i := range list.Items {
		svc := &list.Items[i]
		if svc.Spec.Route == nil || !svc.Spec.Route.Published() || svc.Spec.Route.AIGatewayRouter != routeName || !svc.DeletionTimestamp.IsZero() {
			continue
		}
		isCurrent := current != nil && svc.UID == current.UID
		if !isCurrent {
			// A service that has not reached a ready endpoint has no catalog
			// objects yet. Its rule would reference a Backend the shared route
			// cannot resolve, and one dangling reference rejects the whole route
			// — taking every other service on it down. The current service is
			// exempt: checkRoute applied its objects just before this pass, and
			// the cached client may not observe the writes yet.
			//
			// The gate is object existence, not endpoint readiness, so a rule
			// survives an endpoint going unready: its objects stay behind.
			exists, err := r.catalogObjectsExist(ctx, svc)
			if err != nil {
				return nil, err
			}
			if !exists {
				continue
			}
		}
		modelName := ""
		if svc.Status.Model != nil {
			modelName = svc.Status.Model.Name
		}
		if isCurrent && currentModelName != "" {
			modelName = currentModelName
		}
		if modelName == "" {
			// The service's own reconcile fills the echo once it resolves the
			// model; until then the catalog name is the honest fallback.
			modelName = svc.Spec.Route.ModelName
		}
		if claimed[svc.Spec.Route.ModelName] {
			if isCurrent {
				set.nameTaken = true
			}
			continue
		}
		claimed[svc.Spec.Route.ModelName] = true
		if svc.Spec.Route.Exposes(aiv1alpha1.CatalogPathMessages) {
			if len(set.ai) >= catalogRuleMax {
				if isCurrent {
					set.routeFull = true
				}
			} else {
				set.ai = append(set.ai, r.catalogRuleFor(svc, modelName))
			}
		}
		var openAIRules []gatewayv1.HTTPRouteRule
		for _, path := range catalogOpenAIPaths {
			if svc.Spec.Route.Exposes(path) {
				openAIRules = append(openAIRules, r.openAIPathsRuleFor(svc, path))
			}
		}
		if len(set.openAI)+len(openAIRules) > openAIPathsRuleMax {
			if isCurrent {
				set.routeFull = true
			}
		} else {
			set.openAI = append(set.openAI, openAIRules...)
		}
	}
	return set, nil
}

// catalogObjectsExist reports whether the objects a rule references exist: the
// Backend serving the OpenAI paths and the Anthropic-schema AIServiceBackend
// serving /v1/messages. checkRoute creates them together once the service's
// endpoint is ready, so a published service without them has never been
// publishable.
func (r *InferenceServiceReconciler) catalogObjectsExist(ctx context.Context, isvc *aiv1alpha1.InferenceService) (bool, error) {
	backend := &egv1alpha1.Backend{}
	err := r.Get(ctx, client.ObjectKey{Namespace: isvc.Namespace, Name: backendName(isvc)}, backend)
	if apierrors.IsNotFound(err) || meta.IsNoMatchError(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	anthropic := &aigwv1beta1.AIServiceBackend{}
	err = r.Get(ctx, client.ObjectKey{Namespace: isvc.Namespace, Name: anthropicServiceBackendName(isvc)}, anthropic)
	if apierrors.IsNotFound(err) || meta.IsNoMatchError(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// syncSharedCatalogRoute rewrites both shared surfaces of one catalog route
// from the current state of every published service, and rewrites the other
// route's surfaces too: a service that has just moved must lose its rules from
// the route it left. Concurrent services each write the same full set
// optimistically; the retries and the no-write-on-equal check converge them.
func (r *InferenceServiceReconciler) syncSharedCatalogRoute(ctx context.Context, routeName aiv1alpha1.AIGatewayRouterName, current *aiv1alpha1.InferenceService, currentModelName string) (*sharedRuleSet, error) {
	set, err := r.syncRoutePair(ctx, routeName, current, currentModelName)
	if err != nil {
		return nil, err
	}
	for _, other := range catalogRouteNames {
		if other == routeName {
			continue
		}
		if _, err := r.syncRoutePair(ctx, other, nil, ""); err != nil {
			return nil, err
		}
	}
	return set, nil
}

// syncRoutePair rewrites the AIGatewayRoute and OpenAI-paths HTTPRoute of one
// catalog route from the published services attached to it.
func (r *InferenceServiceReconciler) syncRoutePair(ctx context.Context, routeName aiv1alpha1.AIGatewayRouterName, current *aiv1alpha1.InferenceService, currentModelName string) (*sharedRuleSet, error) {
	set, err := r.desiredSharedRuleSet(ctx, routeName, current, currentModelName)
	if err != nil {
		return nil, err
	}
	if err := r.applyCatalogRoute(ctx, routeName, set.ai); err != nil {
		return nil, err
	}
	if err := r.applyOpenAIPathsRoute(ctx, routeName, set.openAI); err != nil {
		return nil, err
	}
	return set, nil
}

// syncSharedCatalogRoutes rewrites both catalog surfaces of both known routes,
// with no service being the subject. Unpublish and deletion use it: the
// service's rules must disappear from whichever route held them, and the
// remaining rules must survive.
func (r *InferenceServiceReconciler) syncSharedCatalogRoutes(ctx context.Context) error {
	if r.GatewayName == "" || r.GatewayNamespace == "" {
		// No shared catalog surface is configured, so there is nothing this
		// reconciler could have written to shed. Addressing the routes anyway
		// would fail: the empty namespace fails a direct-client Get, and an
		// empty Gateway name is rejected when a route would have to be created.
		return nil
	}
	for _, routeName := range catalogRouteNames {
		if _, err := r.syncRoutePair(ctx, routeName, nil, ""); err != nil {
			return err
		}
	}
	return nil
}

// applyCatalogRoute writes the full rule set to the named AIGatewayRoute,
// creating the object when it does not exist yet and the set is not empty. An
// unchanged set is left untouched: updating an identical object would bump the
// resourceVersion and re-enqueue through the shared-route watch in a loop.
func (r *InferenceServiceReconciler) applyCatalogRoute(ctx context.Context, routeName aiv1alpha1.AIGatewayRouterName, rules []aigwv1beta1.AIGatewayRouteRule) error {
	if rules == nil {
		rules = []aigwv1beta1.AIGatewayRouteRule{}
	}
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		route := r.getCatalogRoute(routeName)
		err := r.Get(ctx, client.ObjectKeyFromObject(route), route)
		if meta.IsNoMatchError(err) {
			return nil // cluster serves no AIGatewayRoute CRD
		}
		if apierrors.IsNotFound(err) {
			if len(rules) == 0 {
				return nil // nothing to publish: leave the platform surface absent
			}
			if err := r.Create(ctx, r.desiredCatalogRoute(routeName, rules)); err != nil && !apierrors.IsAlreadyExists(err) {
				return err
			}
			return nil
		}
		if err != nil {
			return err
		}
		if catalogRulesEqual(route.Spec.Rules, rules) {
			return nil
		}
		route.Spec.Rules = rules
		return r.Update(ctx, route)
	})
}

// applyOpenAIPathsRoute writes the full rule set to the named shared HTTPRoute,
// creating it when absent and the set is not empty. The platform owns any
// existing object's other spec fields (hostnames, parentRefs); only the rules
// are reconciled.
func (r *InferenceServiceReconciler) applyOpenAIPathsRoute(ctx context.Context, routeName aiv1alpha1.AIGatewayRouterName, rules []gatewayv1.HTTPRouteRule) error {
	if rules == nil {
		rules = []gatewayv1.HTTPRouteRule{}
	}
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		route := r.getOpenAIPathsRoute(routeName)
		err := r.Get(ctx, client.ObjectKeyFromObject(route), route)
		if apierrors.IsNotFound(err) {
			if len(rules) == 0 {
				return nil // nothing to publish: leave the platform surface absent
			}
			if err := r.Create(ctx, r.desiredOpenAIPathsRoute(routeName, rules)); err != nil && !apierrors.IsAlreadyExists(err) {
				return err
			}
			return nil
		}
		if err != nil {
			return err
		}
		if len(rules) == 0 {
			// The Gateway API CRD defaults an empty or omitted rule list to a
			// catch-all PathPrefix "/" rule, so an update could never store "no
			// rules": the defaulted object would differ from the desired one on
			// every pass and be rewritten forever. Drop the surface instead,
			// matching the create path that leaves it absent.
			return client.IgnoreNotFound(r.Delete(ctx, route))
		}
		if apiequality.Semantic.DeepEqual(route.Spec.Rules, rules) {
			return nil
		}
		route.Spec.Rules = rules
		return r.Update(ctx, route)
	})
}

// desiredCatalogRoute builds the shared AIGatewayRoute the operator maintains:
// attached to the platform Gateway and carrying only the rules it computed.
func (r *InferenceServiceReconciler) desiredCatalogRoute(name aiv1alpha1.AIGatewayRouterName, rules []aigwv1beta1.AIGatewayRouteRule) *aigwv1beta1.AIGatewayRoute {
	return &aigwv1beta1.AIGatewayRoute{
		ObjectMeta: metav1.ObjectMeta{Name: string(name), Namespace: r.GatewayNamespace, Labels: sharedRouteLabels()},
		Spec: aigwv1beta1.AIGatewayRouteSpec{
			ParentRefs: []gatewayv1.ParentReference{{Name: gatewayv1.ObjectName(r.GatewayName)}},
			Rules:      rules,
		},
	}
}

// desiredOpenAIPathsRoute builds the shared plain HTTPRoute the operator
// maintains: attached to the platform Gateway and carrying only the rules it
// computed.
func (r *InferenceServiceReconciler) desiredOpenAIPathsRoute(name aiv1alpha1.AIGatewayRouterName, rules []gatewayv1.HTTPRouteRule) *gatewayv1.HTTPRoute {
	return &gatewayv1.HTTPRoute{
		ObjectMeta: metav1.ObjectMeta{Name: openAIPathsRouteName(name), Namespace: r.GatewayNamespace, Labels: sharedRouteLabels()},
		Spec: gatewayv1.HTTPRouteSpec{
			CommonRouteSpec: gatewayv1.CommonRouteSpec{
				ParentRefs: []gatewayv1.ParentReference{{Name: gatewayv1.ObjectName(r.GatewayName)}},
			},
			Rules: rules,
		},
	}
}

// catalogRouteNames are the catalog surfaces a service can select. Both are
// pre-installed by the platform in GatewayNamespace; the operator only edits
// the one named by spec.route.aigatewayRouter.
var catalogRouteNames = []aiv1alpha1.AIGatewayRouterName{
	aiv1alpha1.AIGatewayRouterPublic,
	aiv1alpha1.AIGatewayRouterPrivate,
}

// selectedCatalogRoute returns the shared route the service publishes to, or ""
// when it is not published.
func selectedCatalogRoute(isvc *aiv1alpha1.InferenceService) aiv1alpha1.AIGatewayRouterName {
	if isvc.Spec.Route == nil {
		return ""
	}
	return isvc.Spec.Route.AIGatewayRouter
}

// getCatalogRoute returns an empty object addressing one of the platform's
// pre-installed shared catalog routes: the object a published service attaches
// its rule to.
func (r *InferenceServiceReconciler) getCatalogRoute(name aiv1alpha1.AIGatewayRouterName) *aigwv1beta1.AIGatewayRoute {
	return &aigwv1beta1.AIGatewayRoute{ObjectMeta: metav1.ObjectMeta{Name: string(name), Namespace: r.GatewayNamespace}}
}

// getOpenAIPathsRoute returns an empty object addressing the shared plain
// HTTPRoute paired with the named catalog route.
func (r *InferenceServiceReconciler) getOpenAIPathsRoute(name aiv1alpha1.AIGatewayRouterName) *gatewayv1.HTTPRoute {
	return &gatewayv1.HTTPRoute{ObjectMeta: metav1.ObjectMeta{Name: openAIPathsRouteName(name), Namespace: r.GatewayNamespace}}
}

// checkRoute applies the publish decision: an empty spec.route.aigatewayRouter
// removes the service's catalog objects and its rules from the shared routes (a
// valid state reported as NotPublished); a non-empty one creates the Backend,
// the two schema-specific AIServiceBackends and the ReferenceGrant in the
// service's namespace, then rebuilds the selected shared catalog surfaces from
// every published service and reports this service's acceptance. A cluster
// without the Agent Router CRDs degrades to AgentRouterUnavailable.
func (r *InferenceServiceReconciler) checkRoute(ctx context.Context, isvc *aiv1alpha1.InferenceService, profile *aiv1alpha1.InferenceRuntimeProfile, endpoint *endpointCheck, modelName string) (*routeCheck, error) {
	check := &routeCheck{}
	// The retired per-model hostname HTTPRoute is removed on every pass: an
	// object left behind would keep serving the old hostname with the old
	// timeout semantics.
	if err := r.deleteLegacyHTTPRoute(ctx, isvc); err != nil {
		return routeErr(check, err)
	}
	routeName := selectedCatalogRoute(isvc)
	if !isvc.Spec.Route.Published() {
		if err := r.deleteCatalogObjects(ctx, isvc); err != nil {
			return routeErr(check, err)
		}
		check.Reason = RouteNotPublished
		return check, nil
	}
	if !r.AgentRouterAvailable {
		check.Reason = RouteAgentRouterUnavailable
		return check, nil
	}
	if endpoint == nil || endpoint.Internal == "" {
		check.Reason = EndpointNotReady
		return check, nil
	}
	if r.GatewayName == "" || r.GatewayNamespace == "" {
		check.Reason = RouteGatewayNotConfigured
		return check, nil
	}
	port, err := endpointPort(endpoint.Internal)
	if err != nil {
		check.Reason = EndpointNotReady
		return check, nil
	}
	backend := r.desiredBackend(isvc, profile, port)
	if err := applyOwned(ctx, r.Client, isvc, backend, backendNeedsUpdate); err != nil {
		return routeErr(check, err)
	}
	sb := r.desiredAIServiceBackend(isvc)
	if err := applyOwned(ctx, r.Client, isvc, sb, aiServiceBackendNeedsUpdate); err != nil {
		return routeErr(check, err)
	}
	anthropicSB := r.desiredAnthropicAIServiceBackend(isvc)
	if err := applyOwned(ctx, r.Client, isvc, anthropicSB, aiServiceBackendNeedsUpdate); err != nil {
		return routeErr(check, err)
	}
	grant := r.desiredReferenceGrant(isvc)
	if err := applyOwned(ctx, r.Client, isvc, grant, referenceGrantNeedsUpdate); err != nil {
		return routeErr(check, err)
	}
	// The shared surfaces are rebuilt from every published service, so a
	// duplicate catalog name is lost by the later service (first-come keeps it)
	// and a full shared route drops the later rules. Both are stable conditions
	// for this service, not failures to requeue.
	set, err := r.syncSharedCatalogRoute(ctx, routeName, isvc, modelName)
	if err != nil {
		return routeErr(check, err)
	}
	if set.nameTaken {
		check.Reason = RouteModelNameConflict
		return check, nil
	}
	if set.routeFull {
		check.Reason = RouteCatalogFull
		return check, nil
	}
	// Re-fetch after the writes: the acceptance check must not run against a
	// status written for a previous generation. The Agent Router surface only
	// exists when some service publishes /v1/messages, so a service that
	// exposes only OpenAI paths must not require the route to be present.
	if isvc.Spec.Route.Exposes(aiv1alpha1.CatalogPathMessages) {
		fresh := r.getCatalogRoute(routeName)
		if err := r.Get(ctx, client.ObjectKeyFromObject(fresh), fresh); err != nil {
			return routeErrAfterApply(check, err)
		}
		freshAnthropic := &aigwv1beta1.AIServiceBackend{}
		if err := r.Get(ctx, client.ObjectKeyFromObject(anthropicSB), freshAnthropic); err != nil {
			return routeErrAfterApply(check, err)
		}
		check = sharedRouteAcceptance(check, fresh, freshAnthropic, isvc)
	}
	if check.Reason != "" || !r.exposesOpenAIPaths(isvc) {
		return check, nil
	}
	freshOpenAI := r.getOpenAIPathsRoute(routeName)
	if err := r.Get(ctx, client.ObjectKeyFromObject(freshOpenAI), freshOpenAI); err != nil {
		return routeErrAfterApply(check, err)
	}
	if !routeParentsAccepted(freshOpenAI.Status.Parents, freshOpenAI.Generation, r.GatewayName, r.GatewayNamespace) {
		check.Reason = RouteGatewayNotAccepted
	}
	return check, nil
}

// exposesOpenAIPaths reports whether the service publishes any path served by
// the plain OpenAI-paths HTTPRoute.
func (r *InferenceServiceReconciler) exposesOpenAIPaths(isvc *aiv1alpha1.InferenceService) bool {
	return slices.ContainsFunc(catalogOpenAIPaths, isvc.Spec.Route.Exposes)
}

// applyOwned creates the desired object, or updates it in place when a
// controller-owned field drifted. An identical object is left untouched:
// updating it would bump the resourceVersion and re-enqueue the service
// through the Owns() watch in an unbounded loop.
func applyOwned[T client.Object](ctx context.Context, c client.Client, owner *aiv1alpha1.InferenceService, desired T, needsUpdate func(existing, desired T) bool) error {
	existing, ok := desired.DeepCopyObject().(T)
	if !ok {
		return fmt.Errorf("deep copy of %T is not the same type", desired)
	}
	err := c.Get(ctx, client.ObjectKeyFromObject(desired), existing)
	if apierrors.IsNotFound(err) {
		return c.Create(ctx, desired)
	}
	if err != nil {
		return err
	}
	if err := ensureOwned(existing, owner.UID); err != nil {
		return err
	}
	if needsUpdate(existing, desired) {
		desired.SetResourceVersion(existing.GetResourceVersion())
		return c.Update(ctx, desired)
	}
	return nil
}

// backendNeedsUpdate reports whether the controller-owned fields of an existing
// Backend differ from the desired ones: the labels and the Spec. Server-side
// fields (owner references, status, the defaults the API server fills into the
// spec) never count as drift. An identical object is left untouched: updating it
// would bump the resourceVersion and re-enqueue the service through the Owns()
// watch in an unbounded loop.
func backendNeedsUpdate(existing, desired *egv1alpha1.Backend) bool {
	return !apiequality.Semantic.DeepEqual(existing.Labels, desired.Labels) ||
		!apiequality.Semantic.DeepEqual(existing.Spec, desired.Spec)
}

// aiServiceBackendNeedsUpdate reports whether the controller-owned fields of an
// existing AIServiceBackend differ from the desired ones (the labels and the
// Spec), with the same no-drift rule as backendNeedsUpdate.
func aiServiceBackendNeedsUpdate(existing, desired *aigwv1beta1.AIServiceBackend) bool {
	return !apiequality.Semantic.DeepEqual(existing.Labels, desired.Labels) ||
		!apiequality.Semantic.DeepEqual(existing.Spec, desired.Spec)
}

// referenceGrantNeedsUpdate reports whether the controller-owned fields of an
// existing ReferenceGrant differ from the desired ones: the labels and the
// Spec, with the same no-drift rule as the sibling comparisons.
func referenceGrantNeedsUpdate(existing, desired *gatewayv1.ReferenceGrant) bool {
	return !apiequality.Semantic.DeepEqual(existing.Labels, desired.Labels) ||
		!apiequality.Semantic.DeepEqual(existing.Spec, desired.Spec)
}

// sharedRouteAcceptance reports the Agent Router side of a published service:
// when /v1/messages is exposed, acceptance requires this service's rule to be
// present in the shared AIGatewayRoute and both the route and the
// Anthropic-schema AIServiceBackend to be Accepted for the current generation.
// The shared route carries a single route-level Accepted condition — with many
// services in one route, the per-service granularity lives on the
// AIServiceBackend, which the Agent Router also accepts per object of the
// service.
func sharedRouteAcceptance(check *routeCheck, route *aigwv1beta1.AIGatewayRoute, backend *aigwv1beta1.AIServiceBackend, isvc *aiv1alpha1.InferenceService) *routeCheck {
	if !isvc.Spec.Route.Exposes(aiv1alpha1.CatalogPathMessages) {
		return check // no Agent Router surface requested
	}
	if findCatalogRuleIndex(route.Spec.Rules, isvc) < 0 {
		check.Reason = RouteGatewayNotAccepted
		return check
	}
	if aiObjectAccepted(route.Status.Conditions, route.Generation) && aiObjectAccepted(backend.Status.Conditions, backend.Generation) {
		return check // Reason stays "" — published and accepted.
	}
	check.Reason = RouteGatewayNotAccepted
	return check
}

// aiObjectAccepted reports whether the Agent Router controller accepted the
// object at the given generation. A condition pinned to an older generation is
// stale; an unset observedGeneration counts as current (the schema leaves it
// optional).
//
// The zero tolerance is deliberate: the real Agent Router writes no
// observedGeneration, so in production a stale condition cannot be told from a
// current one this way, while the envtest fixtures do write one (the Agent
// Router runs no controller there). The staleness guarantee the specs assert is
// therefore stricter than production's — it holds for any controller that
// reports observedGeneration, and degrades to the accepted set for one that
// does not.
func aiObjectAccepted(conditions []metav1.Condition, generation int64) bool {
	cond := meta.FindStatusCondition(conditions, aigwv1beta1.ConditionTypeAccepted)
	if cond == nil {
		return false
	}
	if cond.ObservedGeneration != 0 && cond.ObservedGeneration != generation {
		return false
	}
	return cond.Status == metav1.ConditionTrue
}

// deleteCatalogObjects removes the objects a published service owns: the
// Backend, both AIServiceBackends and the ReferenceGrant in its namespace, plus
// its rules from the shared catalog surfaces — rebuilt from the services that
// remain. The objects carry a controller ownerRef to the service, so they also
// cascade on deletion; the shared routes live in another namespace and are not
// owned by the service, so their rules are removed explicitly here and on the
// ISVC's finalizer.
func (r *InferenceServiceReconciler) deleteCatalogObjects(ctx context.Context, isvc *aiv1alpha1.InferenceService) error {
	if err := r.syncSharedCatalogRoutes(ctx); err != nil {
		return err
	}
	for _, obj := range []client.Object{
		&gatewayv1.ReferenceGrant{ObjectMeta: metav1.ObjectMeta{Name: referenceGrantName(isvc), Namespace: isvc.Namespace}},
		&aigwv1beta1.AIServiceBackend{ObjectMeta: metav1.ObjectMeta{Name: anthropicServiceBackendName(isvc), Namespace: isvc.Namespace}},
		&aigwv1beta1.AIServiceBackend{ObjectMeta: metav1.ObjectMeta{Name: aiServiceBackendName(isvc), Namespace: isvc.Namespace}},
		&egv1alpha1.Backend{ObjectMeta: metav1.ObjectMeta{Name: backendName(isvc), Namespace: isvc.Namespace}},
	} {
		if err := r.deleteOwned(ctx, isvc, obj); err != nil {
			return err
		}
	}
	return nil
}

// deleteLegacyHTTPRoute removes the per-model hostname HTTPRoute the previous
// publish primitive created, when it is still around and owned by the service.
//
// Its name and namespace are also the ones the Agent Router's controller gives
// the HTTPRoute it materialises from this service's AIGatewayRoute: that route
// is controlled by the AIGatewayRoute, not by the service, so a foreign object
// under this name must be left to its own controller. Treating it as a conflict
// (as the catalog cleanup's strict ownership check does) would fail every
// reconcile of every published service on a cluster that runs the Agent Router.
func (r *InferenceServiceReconciler) deleteLegacyHTTPRoute(ctx context.Context, isvc *aiv1alpha1.InferenceService) error {
	legacy := &gatewayv1.HTTPRoute{ObjectMeta: metav1.ObjectMeta{Name: isvc.Name + "-route", Namespace: isvc.Namespace}}
	err := r.Get(ctx, client.ObjectKeyFromObject(legacy), legacy)
	if apierrors.IsNotFound(err) || meta.IsNoMatchError(err) {
		return nil // absent, or a cluster serving no HTTPRoute CRD
	}
	if err != nil {
		return err
	}
	if owner := metav1.GetControllerOf(legacy); owner == nil || owner.UID != isvc.UID {
		return nil
	}
	if err := r.Delete(ctx, legacy); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	return nil
}

// deleteOwned deletes a named object when it exists and is controlled by the
// service. A missing object and an unserved kind both count as already gone.
func (r *InferenceServiceReconciler) deleteOwned(ctx context.Context, isvc *aiv1alpha1.InferenceService, obj client.Object) error {
	err := r.Get(ctx, client.ObjectKeyFromObject(obj), obj)
	if apierrors.IsNotFound(err) || meta.IsNoMatchError(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := ensureOwned(obj, isvc.UID); err != nil {
		return err
	}
	if err := r.Delete(ctx, obj); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	return nil
}

// routeParentsAccepted reports whether parents carries an entry for the named
// Gateway reporting Accepted=True and ResolvedRefs=True for the CURRENT
// generation: a condition whose ObservedGeneration is set but does not match the
// route's generation is stale (the gateway has not processed the latest spec
// yet). Without a matching entry the gateway has not processed the route.
//
// A condition with an unset (zero) ObservedGeneration counts as current. The
// Gateway API schema leaves it optional on these conditions, so a gateway may
// simply not report it; reading those conditions as absent would withhold every
// environment's endpoints on such a cluster — a permanent false negative bought
// to close a transient one.
//
// It takes the parents rather than a route so it applies to every route kind:
// HTTPRoute and TCPRoute are distinct types sharing only this status shape.
func routeParentsAccepted(parents []gatewayv1.RouteParentStatus, generation int64, gatewayName, gatewayNamespace string) bool {
	parent := routeParentFor(parents, gatewayName, gatewayNamespace)
	if parent == nil {
		return false
	}
	var accepted, resolved bool
	for _, cond := range parent.Conditions {
		if cond.ObservedGeneration != 0 && cond.ObservedGeneration != generation {
			continue // stale status from a previous generation
		}
		switch cond.Type {
		case string(gatewayv1.RouteConditionAccepted):
			accepted = cond.Status == metav1.ConditionTrue
		case string(gatewayv1.RouteConditionResolvedRefs):
			resolved = cond.Status == metav1.ConditionTrue
		}
	}
	return accepted && resolved
}

// routeParentFor returns the status.parents entry belonging to the named
// Gateway, matched by parentRef name and — when set — namespace. It is nil when
// the gateway has not reported on the route.
func routeParentFor(parents []gatewayv1.RouteParentStatus, gatewayName, gatewayNamespace string) *gatewayv1.RouteParentStatus {
	for i := range parents {
		if parents[i].ParentRef.Name != gatewayv1.ObjectName(gatewayName) {
			continue
		}
		if parents[i].ParentRef.Namespace != nil && string(*parents[i].ParentRef.Namespace) != gatewayNamespace {
			continue
		}
		return &parents[i]
	}
	return nil
}

// routeParentsTo reports whether a route's spec.parentRefs attach it to the
// named Gateway — the question routeParentFor answers for the parents status
// reports. The API's defaults apply to the fields left unset: a parentRef
// without a namespace means the route's own namespace, and one without a group
// or kind means a Gateway in the Gateway API group. A ref that names another
// resource — a Service of the same name, as a mesh route may parent to — is a
// different parent however it is spelled, and holds no listener here.
func routeParentsTo(refs []gatewayv1.ParentReference, routeNamespace, gatewayName, gatewayNamespace string) bool {
	for _, ref := range refs {
		group, kind := gatewayAPIGroup, gatewayKind
		if ref.Group != nil {
			group = string(*ref.Group)
		}
		if ref.Kind != nil {
			kind = string(*ref.Kind)
		}
		if group != gatewayAPIGroup || kind != gatewayKind {
			continue
		}
		if ref.Name != gatewayv1.ObjectName(gatewayName) {
			continue
		}
		namespace := routeNamespace
		if ref.Namespace != nil {
			namespace = string(*ref.Namespace)
		}
		if namespace == gatewayNamespace {
			return true
		}
	}
	return false
}

// listenerSetParentsToGateway reports whether a ListenerSet contributes its
// listeners to the named Gateway — the same question routeParentsTo answers,
// asked of the single parentRef a ListenerSet carries. It delegates rather than
// restating the rule so that a ListenerSet and a route cannot disagree about
// which Gateway they are attached to; only the ref type differs.
func listenerSetParentsToGateway(ls *gatewayv1.ListenerSet, gatewayName, gatewayNamespace string) bool {
	return routeParentsTo([]gatewayv1.ParentReference{{
		Group:     ls.Spec.ParentRef.Group,
		Kind:      ls.Spec.ParentRef.Kind,
		Name:      ls.Spec.ParentRef.Name,
		Namespace: ls.Spec.ParentRef.Namespace,
	}}, ls.Namespace, gatewayName, gatewayNamespace)
}

// endpointPort extracts the port from the reachable internal endpoint
// "<svc>.<ns>.svc:<port>" reported by checkEndpoint.
func endpointPort(internal string) (int32, error) {
	port, err := strconv.Atoi(internal[strings.LastIndex(internal, ":")+1:])
	if err != nil {
		return 0, err
	}
	return int32(port), nil
}

// routeErr maps an error from a route API call: a missing gateway-api CRD
// (NoMatchError) degrades gracefully to GatewayNotConfigured; any other
// failure is a hard error.
func routeErr(check *routeCheck, err error) (*routeCheck, error) {
	if meta.IsNoMatchError(err) {
		check.Reason = RouteGatewayNotConfigured
		return check, nil
	}
	check.Err = err
	return check, err
}

// routeErrAfterApply maps an error from the re-read that follows the apply: it
// reads through the client's cache, so right after a create it can miss an
// object the API server already holds — the cache has not observed it yet. An
// object that exists but cannot be read carries no acceptance status, which is
// GatewayNotAccepted rather than a failure of the pass.
func routeErrAfterApply(check *routeCheck, err error) (*routeCheck, error) {
	if apierrors.IsNotFound(err) {
		check.Reason = RouteGatewayNotAccepted
		return check, nil
	}
	return routeErr(check, err)
}

// setRouteReadyCondition sets the RouteReady condition from the check:
// an empty spec.route.aigatewayRouter is a valid state reported as
// True/NotPublished (the service simply did not request a catalog route); any
// other non-empty reason is a failure reported as False.
func setRouteReadyCondition(conditions *[]metav1.Condition, check *routeCheck) {
	if check.Reason == "" {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionRouteReady,
			Status:  metav1.ConditionTrue,
			Reason:  "RouteReady",
			Message: "The public route is published to the gateway",
		})
		return
	}
	status := metav1.ConditionFalse
	message := fmt.Sprintf("The public route could not be published: %s", check.Reason)
	if check.Reason == RouteNotPublished {
		status = metav1.ConditionTrue
		message = "No public route requested: the service is not published"
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type:    aiv1alpha1.ConditionRouteReady,
		Status:  status,
		Reason:  check.Reason,
		Message: message,
	})
}
