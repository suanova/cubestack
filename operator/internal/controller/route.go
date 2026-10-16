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
	"errors"
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
	// RouteCatalogNotFound is reported when the platform's pre-installed shared
	// catalog route does not exist. Unlike the per-service routes the previous
	// design created, the shared route is owned by the platform, not the
	// operator, so a missing one is a deployment prerequisite, not something the
	// controller creates.
	RouteCatalogNotFound = "CatalogRouteNotFound"
	// RouteCatalogFull is reported when adding this service's rule would put the
	// shared route over its rule cap (catalogRuleMax).
	RouteCatalogFull = "CatalogFull"
)

// routeCheck reports the route-publish outcome.
type routeCheck struct {
	Reason string // NotPublished | ModelNameConflict | GatewayNotConfigured | CatalogRouteNotFound | CatalogFull | EndpointNotReady | AgentRouterUnavailable | GatewayNotAccepted | ""
	Err    error  // API-level failure
}

// Kinds, API groups and the fixed fields of the Agent Router catalog objects a
// published service owns: the Envoy Gateway Backend naming the endpoint pool,
// the AIServiceBackend declaring the upstream schema and referencing that
// Backend, and the ReferenceGrant authorising the shared catalog route (in the
// Gateway's namespace) to reference this service's AIServiceBackend across
// namespaces. The Backend type, weight, priority and modelsOwnedBy are spelled
// explicitly so the API server's defaults never read as drift.
const (
	envoyGatewayAPIGroup = "gateway.envoyproxy.io"
	egBackendKind        = "Backend"
	aiModelHeaderName    = "x-ai-eg-model"
	catalogOwnedBy       = "CubeStack"
	// catalogRuleMax is the AIGatewayRoute rule cap: the CRD allows at most 15
	// rules (one slot is reserved for the controller's catch-all), so a shared
	// route can hold at most this many published models.
	catalogRuleMax = 15
)

// Names of the catalog objects a published service owns.
func backendName(isvc *aiv1alpha1.InferenceService) string          { return isvc.Name + "-endpoint" }
func aiServiceBackendName(isvc *aiv1alpha1.InferenceService) string { return isvc.Name + "-backend" }
func referenceGrantName(isvc *aiv1alpha1.InferenceService) string   { return isvc.Name + "-grant" }

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

// desiredAIServiceBackend builds the AIServiceBackend declaring the upstream
// schema (OpenAI: the model servers are vLLM) and referencing the Backend.
func (r *InferenceServiceReconciler) desiredAIServiceBackend(isvc *aiv1alpha1.InferenceService) *aigwv1beta1.AIServiceBackend {
	sb := &aigwv1beta1.AIServiceBackend{
		ObjectMeta: metav1.ObjectMeta{Name: aiServiceBackendName(isvc), Namespace: isvc.Namespace, Labels: routeLabels(isvc)},
		Spec: aigwv1beta1.AIServiceBackendSpec{
			APISchema: aigwv1beta1.VersionedAPISchema{Name: aigwv1beta1.APISchemaOpenAI},
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
// namespace) to reference this service's AIServiceBackend — the route's
// backendRef is what crosses the namespace boundary, the Gateway itself never
// names the AIServiceBackend. The grant's `to` names only the
// AIServiceBackend; the Backend is referenced by a same-namespace
// AIServiceBackend and needs none.
func (r *InferenceServiceReconciler) desiredReferenceGrant(isvc *aiv1alpha1.InferenceService) *gatewayv1.ReferenceGrant {
	grant := &gatewayv1.ReferenceGrant{
		ObjectMeta: metav1.ObjectMeta{Name: referenceGrantName(isvc), Namespace: isvc.Namespace, Labels: routeLabels(isvc)},
		Spec: gatewayv1.ReferenceGrantSpec{
			From: []gatewayv1.ReferenceGrantFrom{{
				Group:     gatewayv1.Group(aigwv1beta1.GroupName),
				Kind:      gatewayv1.Kind("AIGatewayRoute"),
				Namespace: gatewayv1.Namespace(r.GatewayNamespace),
			}},
			To: []gatewayv1.ReferenceGrantTo{{
				Group: gatewayv1.Group(aigwv1beta1.GroupName),
				Kind:  gatewayv1.Kind("AIServiceBackend"),
				Name:  ptr(gatewayv1.ObjectName(aiServiceBackendName(isvc))),
			}},
		},
	}
	_ = ctrl.SetControllerReference(isvc, grant, r.Scheme)
	return grant
}

// catalogRuleFor builds the one rule of the shared catalog route this service
// contributes: a match on the catalog model name — set by the Agent Router's
// ext_proc from the request body's "model" field and injected as the
// x-ai-eg-model header — routing to the service's backend (in its namespace,
// hence the explicit Namespace and the ReferenceGrant) with the engine's served
// model name written back over it. The per-service timeouts and the owned-by
// tag ride on the rule, as the shared route is a single object.
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
			Name:              aiServiceBackendName(isvc),
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

// catalogRuleLocator reports whether a rule belongs to this service: it is the
// one whose first backendRef is this service's AIServiceBackend (namespace and
// name). The locator is stable across modelName changes and unique per service,
// unlike the rule name or the header value.
func catalogRuleIsMine(rule aigwv1beta1.AIGatewayRouteRule, isvc *aiv1alpha1.InferenceService) bool {
	if len(rule.BackendRefs) == 0 {
		return false
	}
	ref := rule.BackendRefs[0]
	if ref.Name != aiServiceBackendName(isvc) {
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

// upsertCatalogRule adds or updates this service's rule in the shared catalog
// route, leaving every other rule untouched. The shared route is one object
// many services write to concurrently, so the mutation is optimistic: it reads
// the route, applies the idempotent delta, and writes it back with the
// resourceVersion it read; a 409 conflict re-reads and re-applies. Because each
// service only ever touches its own rule, the retries converge. An unchanged
// rule is left untouched: updating an identical object would bump the
// resourceVersion and re-enqueue through the shared-route watch in a loop.
//
// The model-name uniqueness and rule-capacity checks run inside the retry
// closure against the freshly read route, not against a snapshot taken earlier
// in checkRoute: two services publishing at once with the same model name
// would otherwise both pass a pre-check and the conflict retry would append
// both rules, and the same race could push the route past its cap. When a
// check fails the closure returns the matching sentinel so the caller maps it
// to the condition reason instead of a hard error.
func (r *InferenceServiceReconciler) upsertCatalogRule(ctx context.Context, isvc *aiv1alpha1.InferenceService, modelName string) error {
	// No shared route configured: nothing to write, and building the addressing
	// object with an empty name would reject every request. checkRoute reaches
	// here only with a configured route, but the helper is shared with the
	// removal path, so it guards on its own.
	if r.CatalogRoute == "" {
		return nil
	}
	desired := r.catalogRuleFor(isvc, modelName)
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		route := r.getSharedCatalogRoute()
		if err := r.Get(ctx, client.ObjectKeyFromObject(route), route); err != nil {
			return err
		}
		// Re-validate against the current route on every attempt: the checks are
		// only meaningful against the state we are about to write into.
		if r.catalogModelNameTaken(route, isvc) {
			return errCatalogModelNameTaken
		}
		if findCatalogRuleIndex(route.Spec.Rules, isvc) < 0 && len(route.Spec.Rules) >= catalogRuleMax {
			return errCatalogRouteFull
		}
		idx := findCatalogRuleIndex(route.Spec.Rules, isvc)
		if idx >= 0 {
			if catalogRuleEqual(route.Spec.Rules[idx], desired) {
				return nil // already there: no write
			}
			route.Spec.Rules[idx] = desired
		} else {
			route.Spec.Rules = append(route.Spec.Rules, desired)
		}
		return r.Update(ctx, route)
	})
}

// Sentinel errors from the shared-route write's optimistic retry, mapped to the
// matching RouteReady reason by checkRoute. They are deliberately not API
// errors: RetryOnConflict must not treat them as a 409 to back off and
// re-run, and the caller must report them as a stable condition rather than
// fail the reconcile.
var (
	errCatalogModelNameTaken = errors.New("catalog model name is claimed by another rule")
	errCatalogRouteFull      = errors.New("shared catalog route is at its rule cap")
)

// removeCatalogRule deletes this service's rule from the shared catalog route.
// A missing route or an absent rule is a no-op, so it is safe to call on every
// unpublish and on the ISVC's deletion.
func (r *InferenceServiceReconciler) removeCatalogRule(ctx context.Context, isvc *aiv1alpha1.InferenceService) error {
	// No shared route configured: nothing to remove. This guard is what keeps
	// the publish=false and deletion paths working on a reconciler that has no
	// catalog route set — building the addressing object with an empty name
	// would reject every request.
	if r.CatalogRoute == "" {
		return nil
	}
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
		route := r.getSharedCatalogRoute()
		err := r.Get(ctx, client.ObjectKeyFromObject(route), route)
		if apierrors.IsNotFound(err) || meta.IsNoMatchError(err) {
			// Absent route, or a cluster serving no AIGatewayRoute CRD: there is
			// no rule to remove. The latter also covers the deletion path, where
			// a cluster without the Agent Router never had a rule to begin with.
			return nil
		}
		if err != nil {
			return err
		}
		idx := findCatalogRuleIndex(route.Spec.Rules, isvc)
		if idx < 0 {
			return nil
		}
		route.Spec.Rules = slices.Delete(route.Spec.Rules, idx, idx+1)
		return r.Update(ctx, route)
	})
}

// getSharedCatalogRoute returns an empty object addressing the platform's
// pre-installed shared catalog route: the object the operator's published
// services attach a rule to.
func (r *InferenceServiceReconciler) getSharedCatalogRoute() *aigwv1beta1.AIGatewayRoute {
	return &aigwv1beta1.AIGatewayRoute{ObjectMeta: metav1.ObjectMeta{Name: r.CatalogRoute, Namespace: r.GatewayNamespace}}
}

// checkRoute applies the publish decision: publish=false removes the service's
// catalog objects and its rule from the shared route (a valid state reported
// as NotPublished); publish=true creates the Backend, AIServiceBackend and
// ReferenceGrant in the service's namespace and upserts the service's rule into
// the platform's pre-installed shared catalog route, reporting acceptance from
// the shared route and the service's AIServiceBackend. A cluster without the
// Agent Router CRDs degrades to AgentRouterUnavailable; a missing shared route
// degrades to CatalogRouteNotFound.
func (r *InferenceServiceReconciler) checkRoute(ctx context.Context, isvc *aiv1alpha1.InferenceService, profile *aiv1alpha1.InferenceRuntimeProfile, endpoint *endpointCheck, modelName string) (*routeCheck, error) {
	check := &routeCheck{}
	// The retired per-model hostname HTTPRoute is removed on every pass: an
	// object left behind would keep serving the old hostname with the old
	// timeout semantics.
	if err := r.deleteLegacyHTTPRoute(ctx, isvc); err != nil {
		return routeErr(check, err)
	}
	if isvc.Spec.Route == nil || !isvc.Spec.Route.Publish {
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
	if r.GatewayName == "" {
		check.Reason = RouteGatewayNotConfigured
		return check, nil
	}
	// The shared route is a platform prerequisite: the operator reads and edits
	// a rule in it but never creates it.
	shared := r.getSharedCatalogRoute()
	if err := r.Get(ctx, client.ObjectKeyFromObject(shared), shared); err != nil {
		if apierrors.IsNotFound(err) {
			check.Reason = RouteCatalogNotFound
			return check, nil
		}
		return routeErr(check, err)
	}
	if r.catalogModelNameTaken(shared, isvc) {
		check.Reason = RouteModelNameConflict
		return check, nil
	}
	if findCatalogRuleIndex(shared.Spec.Rules, isvc) < 0 && len(shared.Spec.Rules) >= catalogRuleMax {
		check.Reason = RouteCatalogFull
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
	grant := r.desiredReferenceGrant(isvc)
	if err := applyOwned(ctx, r.Client, isvc, grant, referenceGrantNeedsUpdate); err != nil {
		return routeErr(check, err)
	}
	// The optimistic retry re-validates the model name and the rule cap against
	// the route's current state and reports a conflict or a full route through
	// a sentinel rather than a hard error: a lost race is a stable condition for
	// this service (first-come-keeps / at capacity), not a failure to requeue.
	if err := r.upsertCatalogRule(ctx, isvc, modelName); err != nil {
		if errors.Is(err, errCatalogModelNameTaken) {
			check.Reason = RouteModelNameConflict
			return check, nil
		}
		if errors.Is(err, errCatalogRouteFull) {
			check.Reason = RouteCatalogFull
			return check, nil
		}
		return routeErr(check, err)
	}
	// Re-fetch after the writes: the acceptance check must not run against a
	// status written for a previous generation.
	fresh := r.getSharedCatalogRoute()
	if err := r.Get(ctx, client.ObjectKeyFromObject(fresh), fresh); err != nil {
		return routeErrAfterApply(check, err)
	}
	freshSB := &aigwv1beta1.AIServiceBackend{}
	if err := r.Get(ctx, client.ObjectKeyFromObject(sb), freshSB); err != nil {
		return routeErrAfterApply(check, err)
	}
	return sharedRouteAcceptance(check, fresh, freshSB, isvc), nil
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

// catalogModelNameTaken reports whether another service already claims this
// service's catalog model name: the x-ai-eg-model match value of a rule in the
// shared route that is not this service's rule.
func (r *InferenceServiceReconciler) catalogModelNameTaken(route *aigwv1beta1.AIGatewayRoute, isvc *aiv1alpha1.InferenceService) bool {
	for i := range route.Spec.Rules {
		rule := route.Spec.Rules[i]
		if catalogRuleIsMine(rule, isvc) {
			continue
		}
		for _, match := range rule.Matches {
			for _, header := range match.Headers {
				if header.Name == aiModelHeaderName && header.Value == isvc.Spec.Route.ModelName {
					return true
				}
			}
		}
	}
	return false
}

// sharedRouteAcceptance reports the acceptance of a published service: RouteReady
// requires both the shared catalog route and the service's AIServiceBackend to
// be Accepted for the current generation, and the service's rule to be present in
// the shared route. The shared route carries a single route-level Accepted
// condition — with many services in one route, the per-service granularity lives
// on the AIServiceBackend, which the Agent Router also accepts per object.
func sharedRouteAcceptance(check *routeCheck, route *aigwv1beta1.AIGatewayRoute, backend *aigwv1beta1.AIServiceBackend, isvc *aiv1alpha1.InferenceService) *routeCheck {
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
// Backend, AIServiceBackend and ReferenceGrant in its namespace, plus its rule
// from the shared catalog route. The three objects carry a controller ownerRef
// to the service, so they also cascade on deletion; the rule lives in another
// namespace and is not owned by the service, so it is removed explicitly here
// and on the ISVC's finalizer.
func (r *InferenceServiceReconciler) deleteCatalogObjects(ctx context.Context, isvc *aiv1alpha1.InferenceService) error {
	if err := r.removeCatalogRule(ctx, isvc); err != nil {
		return err
	}
	for _, obj := range []client.Object{
		&gatewayv1.ReferenceGrant{ObjectMeta: metav1.ObjectMeta{Name: referenceGrantName(isvc), Namespace: isvc.Namespace}},
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
// publish=false is a valid state reported as True/NotPublished (the service
// simply did not request a public route); any other non-empty reason is a
// failure reported as False.
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
