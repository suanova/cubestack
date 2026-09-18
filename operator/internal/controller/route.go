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
	"strconv"
	"strings"

	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// Reasons reported by checkRoute when the route is not published or cannot be
// published ("" means the route is published and accepted by the gateway).
const (
	RouteNotPublished         = "NotPublished"
	RouteModelNameConflict    = "ModelNameConflict"
	RouteGatewayNotConfigured = "GatewayNotConfigured"
	RouteGatewayNotAccepted   = "GatewayNotAccepted"
)

// routeCheck reports the route-publish outcome.
type routeCheck struct {
	Reason string // NotPublished | ModelNameConflict | GatewayNotConfigured | EndpointNotReady | ""
	Err    error  // API-level failure
}

// publicHostname is <modelName>.<gatewayDomain>; "" when the route is not
// published.
func publicHostname(isvc *aiv1alpha1.InferenceService, gatewayDomain string) string {
	if isvc.Spec.Route == nil || !isvc.Spec.Route.Publish || gatewayDomain == "" {
		return ""
	}
	return fmt.Sprintf("%s.%s", isvc.Spec.Route.ModelName, gatewayDomain)
}

// desiredHTTPRoute builds the HTTPRoute of a published service: hostname
// <modelName>.<domain>, parentRef to the platform Gateway, backendRef to the
// endpoint Service port, request timeout from spec.route.timeoutSeconds.
func (r *InferenceServiceReconciler) desiredHTTPRoute(isvc *aiv1alpha1.InferenceService, profile *aiv1alpha1.InferenceRuntimeProfile, port int32) *gatewayv1.HTTPRoute {
	timeout := 60
	if isvc.Spec.Route != nil && isvc.Spec.Route.TimeoutSeconds != nil {
		timeout = int(*isvc.Spec.Route.TimeoutSeconds)
	}
	route := &gatewayv1.HTTPRoute{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("%s-route", isvc.Name),
			Namespace: isvc.Namespace,
			Labels: map[string]string{
				inferenceServiceLabelKey: isvc.Name,
				profileLabelKey:          isvc.Spec.ProfileRef,
				managedByLabelKey:        managedByValue,
			},
		},
		Spec: gatewayv1.HTTPRouteSpec{
			CommonRouteSpec: gatewayv1.CommonRouteSpec{
				ParentRefs: []gatewayv1.ParentReference{{
					Name:      gatewayv1.ObjectName(r.GatewayName),
					Namespace: ptr(gatewayv1.Namespace(r.GatewayNamespace)),
				}},
			},
			Hostnames: []gatewayv1.Hostname{gatewayv1.Hostname(publicHostname(isvc, r.GatewayDomain))},
			Rules: []gatewayv1.HTTPRouteRule{{
				BackendRefs: []gatewayv1.HTTPBackendRef{{
					BackendRef: gatewayv1.BackendRef{
						BackendObjectReference: gatewayv1.BackendObjectReference{
							Name: gatewayv1.ObjectName(fmt.Sprintf("%s-%s", isvc.Name, profile.Spec.Endpoint.Role)),
							Port: ptr(port),
						},
					},
				}},
				Timeouts: &gatewayv1.HTTPRouteTimeouts{
					Request: ptr(gatewayv1.Duration(fmt.Sprintf("%ds", timeout))),
				},
			}},
		},
	}
	_ = ctrl.SetControllerReference(isvc, route, r.Scheme)
	return route
}

// checkRoute applies the publish decision (design §4.1 step 6): publish=false
// → NotPublished (and deletes an existing owned route); publish=true with
// EndpointReady → modelName uniqueness check, then create/update the
// HTTPRoute. A missing gateway-api CRD degrades gracefully to
// GatewayNotConfigured. The route is never deleted when the endpoint goes
// unready (design: route lifecycle follows the Service).
func (r *InferenceServiceReconciler) checkRoute(ctx context.Context, isvc *aiv1alpha1.InferenceService, profile *aiv1alpha1.InferenceRuntimeProfile, endpoint *endpointCheck, publicHostname string) (*routeCheck, error) {
	check := &routeCheck{}
	// publish=false: the service does not want a public route; delete an
	// existing owned route (an endpoint flap never deletes the route, but
	// turning publishing off does).
	if isvc.Spec.Route == nil || !isvc.Spec.Route.Publish {
		existing := &gatewayv1.HTTPRoute{}
		err := r.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-route", isvc.Name), Namespace: isvc.Namespace}, existing)
		if apierrors.IsNotFound(err) {
			check.Reason = RouteNotPublished
			return check, nil
		}
		if err != nil {
			return routeErr(check, err)
		}
		if err := ensureOwned(existing, isvc.UID); err != nil {
			return check, err
		}
		if err := r.Delete(ctx, existing); err != nil && !apierrors.IsNotFound(err) {
			return check, err
		}
		check.Reason = RouteNotPublished
		return check, nil
	}
	if endpoint == nil || endpoint.Internal == "" {
		check.Reason = EndpointNotReady
		return check, nil
	}
	if r.GatewayDomain == "" || r.GatewayName == "" {
		// The platform gateway is not configured: degrade like a missing
		// gateway-api CRD instead of publishing a route with no parent.
		check.Reason = RouteGatewayNotConfigured
		return check, nil
	}
	// ModelName uniqueness: no other published service's route may carry the
	// hostname; the route of this service itself is excluded by owner.
	routeList := &gatewayv1.HTTPRouteList{}
	if err := r.List(ctx, routeList); err != nil {
		return routeErr(check, err)
	}
	for i := range routeList.Items {
		item := &routeList.Items[i]
		if owner := metav1.GetControllerOf(item); owner != nil && owner.UID == isvc.UID {
			continue
		}
		for _, hostname := range item.Spec.Hostnames {
			if string(hostname) == publicHostname {
				check.Reason = RouteModelNameConflict
				return check, nil
			}
		}
	}

	port, err := endpointPort(endpoint.Internal)
	if err != nil {
		check.Reason = EndpointNotReady
		return check, nil
	}
	desired := r.desiredHTTPRoute(isvc, profile, port)
	existing := &gatewayv1.HTTPRoute{}
	err = r.Get(ctx, client.ObjectKey{Name: desired.Name, Namespace: desired.Namespace}, existing)
	if apierrors.IsNotFound(err) {
		if err := r.Create(ctx, desired); err != nil {
			return routeErr(check, err)
		}
		// The route is persisted but not yet accepted by the gateway; the
		// acceptance check below reports GatewayNotAccepted until the gateway
		// controller writes status.parents (watched via enqueueForOwnedHTTPRoute).
		return routeAcceptance(check, desired, r.GatewayName, r.GatewayNamespace), nil
	}
	if err != nil {
		return routeErr(check, err)
	}
	if err := ensureOwned(existing, isvc.UID); err != nil {
		return check, err
	}
	if routeNeedsUpdate(existing, desired) {
		desired.SetResourceVersion(existing.GetResourceVersion())
		if err := r.Update(ctx, desired); err != nil {
			return routeErr(check, err)
		}
	}
	// Re-fetch after an update: the acceptance check must not run against the
	// pre-update status — a status written for a previous generation must not
	// report RouteReady for the new spec.
	fresh := &gatewayv1.HTTPRoute{}
	if err := r.Get(ctx, client.ObjectKey{Name: desired.Name, Namespace: desired.Namespace}, fresh); err != nil {
		return routeErr(check, err)
	}
	return routeAcceptance(check, fresh, r.GatewayName, r.GatewayNamespace), nil
}

// routeAcceptance reports the route's acceptance at the configured Gateway:
// RouteReady requires both Accepted=True and ResolvedRefs=True on the matching
// status.parents entry — the route must be live at the gateway, not merely
// persisted (the design's "已生成" is interpreted as "已生效"; a route without
// acceptance is reported as GatewayNotAccepted).
func routeAcceptance(check *routeCheck, route *gatewayv1.HTTPRoute, gatewayName, gatewayNamespace string) *routeCheck {
	if routeAccepted(route, gatewayName, gatewayNamespace) {
		return check // Reason stays "" — published and accepted.
	}
	check.Reason = RouteGatewayNotAccepted
	return check
}

// routeAccepted reports whether the route's status.parents entry for the
// configured Gateway reports Accepted=True and ResolvedRefs=True for the
// current generation.
func routeAccepted(route *gatewayv1.HTTPRoute, gatewayName, gatewayNamespace string) bool {
	return routeParentsAccepted(route.Status.Parents, route.Generation, gatewayName, gatewayNamespace)
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

// routeNeedsUpdate reports whether the controller-owned fields of an existing
// HTTPRoute differ from the desired ones: the labels and the Spec. Server-side
// fields (owner references, status, the defaults the API server fills into the
// spec) never count as drift. An identical route is left untouched: updating it
// would bump the resourceVersion and, through the Owns() watch, re-enqueue the
// service into an unbounded reconcile loop.
func routeNeedsUpdate(existing, desired *gatewayv1.HTTPRoute) bool {
	return !apiequality.Semantic.DeepEqual(existing.Labels, desired.Labels) ||
		!apiequality.Semantic.DeepEqual(existing.Spec, routeSpecWithDefaults(desired.Spec))
}

// routeSpecWithDefaults spells out the spec as the API server stores it, so the
// comparison above does not read the server's own defaults as drift. The
// Gateway API defaults the parentRef group and kind, the backendRef group, kind
// and weight, and an empty match list (a PathPrefix "/"). A stored route
// therefore differs from the spec we build, and a comparison that counts that
// as drift makes checkRoute issue an update on every reconcile — a write that
// runs the optimistic-concurrency check against the gateway controller's status
// writes and fails the reconcile with "the object has been modified" (409),
// although nothing had drifted. The defaults mirrored here are pinned by the
// spec that stores a route through envtest and expects no drift.
func routeSpecWithDefaults(spec gatewayv1.HTTPRouteSpec) gatewayv1.HTTPRouteSpec {
	out := *spec.DeepCopy()
	for i := range out.ParentRefs {
		if out.ParentRefs[i].Group == nil {
			out.ParentRefs[i].Group = ptr(gatewayv1.Group(gatewayAPIGroup))
		}
		if out.ParentRefs[i].Kind == nil {
			out.ParentRefs[i].Kind = ptr(gatewayv1.Kind(gatewayKind))
		}
	}
	for i := range out.Rules {
		rule := &out.Rules[i]
		for j := range rule.BackendRefs {
			ref := &rule.BackendRefs[j].BackendRef
			if ref.Group == nil {
				ref.Group = ptr(gatewayv1.Group(""))
			}
			if ref.Kind == nil {
				ref.Kind = ptr(gatewayv1.Kind(serviceKind))
			}
			if ref.Weight == nil {
				ref.Weight = ptr(int32(1))
			}
		}
		if len(rule.Matches) == 0 {
			rule.Matches = []gatewayv1.HTTPRouteMatch{{
				Path: &gatewayv1.HTTPPathMatch{Type: ptr(gatewayv1.PathMatchPathPrefix), Value: ptr("/")},
			}}
		}
	}
	return out
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
