package devenv

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

// The three objects between an environment's spec and a working L4 endpoint,
// none of which the DevEnvironment controller owns outright: the ListenerSet it
// writes for the environment, the conditions Envoy Gateway puts on it, and the
// dataplane Service Envoy Gateway has to add the allocated port to.
//
// They are here rather than in environment.go because they are another
// controller's objects read through this one's conventions, and a case that
// reads them is asserting a handover rather than a DevEnvironment field.

// The controller's naming, restated. Both are unexported in internal/controller
// for the reason the block in environment.go gives: they are the controller's
// internals, and a test that finds an object by convention should break when the
// convention changes.
const (
	l4ListenerSetSuffix = "-l4"
	l4ProtocolTCP       = "tcp"
)

// ListenerSet is the environment's own L4 listener declaration.
func (e *Environment) ListenerSet(ctx context.Context) (*gatewayv1.ListenerSet, error) {
	var ls gatewayv1.ListenerSet
	key := client.ObjectKey{Namespace: e.ns(), Name: e.Name + l4ListenerSetSuffix}
	if err := e.Suite.Client.Get(ctx, key, &ls); err != nil {
		return nil, fmt.Errorf("reading %s/%s: %w", key.Namespace, key.Name, err)
	}
	return &ls, nil
}

// L4Listener finds the ListenerSet listener declared for one endpoint, and the
// status Envoy Gateway wrote for it.
//
// The status is returned even when it is empty, because "the implementation has
// not answered yet" and "the implementation answered badly" are different
// findings and only the caller knows which one it is looking at.
func (e *Environment) L4Listener(
	ctx context.Context,
	endpoint string,
) (gatewayv1.ListenerEntry, gatewayv1.ListenerEntryStatus, error) {
	ls, err := e.ListenerSet(ctx)
	if err != nil {
		return gatewayv1.ListenerEntry{}, gatewayv1.ListenerEntryStatus{}, err
	}

	var entry *gatewayv1.ListenerEntry
	for i := range ls.Spec.Listeners {
		// The listener's name is <endpoint>-<protocol>-<port>. Matched by building
		// that name rather than by prefix: an endpoint name may itself contain "-",
		// and the port is what separates the two.
		l := &ls.Spec.Listeners[i]
		if string(l.Name) == l4ListenerName(endpoint, l.Protocol, l.Port) {
			entry = l
			break
		}
	}
	if entry == nil {
		return gatewayv1.ListenerEntry{}, gatewayv1.ListenerEntryStatus{},
			fmt.Errorf("%s declares no listener for endpoint %q (has %v)", ls.Name, endpoint, ListenerNames(ls))
	}

	for _, st := range ls.Status.Listeners {
		if string(st.Name) == string(entry.Name) {
			return *entry, st, nil
		}
	}
	return *entry, gatewayv1.ListenerEntryStatus{}, nil
}

// L4PortsHeld is every L4 listener port any environment in the cluster is
// holding, mapped to the ListenerSets that declare it.
//
// Cluster-wide rather than scoped to the run's namespace, because the pool is: a
// port this run's environment let go of and an environment in another namespace
// drew is the pool working, and a check that could only see one namespace could
// not tell that apart from a leak.
//
// The value is a list because the pool's whole promise is that it is never more
// than one: a port two environments both declare is a port one of them has
// published an address to and cannot serve, and the second only finds out when a
// route is refused. A reader that kept the last name it saw could not see that.
func (s *Suite) L4PortsHeld(ctx context.Context) (map[int32][]string, error) {
	var sets gatewayv1.ListenerSetList
	if err := s.Client.List(ctx, &sets); err != nil {
		return nil, fmt.Errorf("listing ListenerSets: %w", err)
	}
	held := make(map[int32][]string, len(sets.Items))
	for i := range sets.Items {
		ls := &sets.Items[i]
		for _, l := range ls.Spec.Listeners {
			held[l.Port] = append(held[l.Port], ls.Namespace+"/"+ls.Name)
		}
	}
	return held, nil
}

// ListenerSetAccepted reports the ListenerSet's own Accepted condition, which is
// the Gateway's answer to *may this tenant declare listeners here at all*. It is
// False when allowedListeners refuses the namespace — with the environment
// itself perfectly healthy, which is why it is asserted separately.
func ListenerSetAccepted(ls *gatewayv1.ListenerSet) *metav1.Condition {
	return meta.FindStatusCondition(ls.Status.Conditions, string(gatewayv1.ListenerSetConditionAccepted))
}

// ListenerSetParent is the Gateway the environment's listeners attach to, as the
// ListenerSet declares it.
//
// Returned as the two fields rather than the reference, because what a case has
// to check is the pair against the Gateway the preflight found: a Gateway in
// another namespace is reached by naming that namespace, and a reference that
// left it empty would resolve against the environment's own namespace instead —
// where there is no such Gateway at all.
func ListenerSetParent(ls *gatewayv1.ListenerSet) (namespace, name string) {
	if ls.Spec.ParentRef.Namespace == nil {
		return ls.Namespace, string(ls.Spec.ParentRef.Name)
	}
	return string(*ls.Spec.ParentRef.Namespace), string(ls.Spec.ParentRef.Name)
}

// HTTPRouteRule is one rule of the environment's web route: the path prefix it
// matches, and the Service port behind it.
type HTTPRouteRule struct {
	PathPrefix  string
	BackendPort int32
}

// HTTPRouteRules is the environment's web route as the two things a case can
// check it against: what the platform published in status, and which container
// port the request is forwarded to.
//
// The backend *port* rather than the backend name: the Service carries one entry
// per published port, and a rule that named the environment's Service but
// forwarded to the wrong port is a route that is accepted and answers nothing.
func (e *Environment) HTTPRouteRules(ctx context.Context) ([]HTTPRouteRule, error) {
	var route gatewayv1.HTTPRoute
	key := client.ObjectKey{Namespace: e.ns(), Name: e.Name + webRouteSuffix}
	if err := e.Suite.Client.Get(ctx, key, &route); err != nil {
		return nil, fmt.Errorf("reading %s/%s: %w", key.Namespace, key.Name, err)
	}
	rules := make([]HTTPRouteRule, 0, len(route.Spec.Rules))
	for _, r := range route.Spec.Rules {
		rule := HTTPRouteRule{}
		if len(r.Matches) > 0 && r.Matches[0].Path != nil && r.Matches[0].Path.Value != nil {
			rule.PathPrefix = *r.Matches[0].Path.Value
		}
		if len(r.BackendRefs) > 0 && r.BackendRefs[0].Port != nil {
			rule.BackendPort = *r.BackendRefs[0].Port
		}
		rules = append(rules, rule)
	}
	return rules, nil
}

// webRouteSuffix is the controller's naming for the environment's HTTPRoute.
const webRouteSuffix = "-web"

// ListenerProgrammed reports the listener's Programmed condition, set by the
// implementation once the port is actually being served. A listener can be
// Accepted and not yet Programmed, so the two are distinct claims.
func ListenerProgrammed(st gatewayv1.ListenerEntryStatus) *metav1.Condition {
	return meta.FindStatusCondition(st.Conditions, string(gatewayv1.ListenerEntryConditionProgrammed))
}

// ConditionSummary renders a condition for a failure message, tolerating its
// absence: "not recorded" and "recorded as False" are different findings and a
// message that printed nothing for the first would read as the second.
func ConditionSummary(c *metav1.Condition) string {
	if c == nil {
		return "not recorded"
	}
	return fmt.Sprintf("%s (%s: %s)", c.Status, c.Reason, c.Message)
}

// l4ListenerName mirrors the controller's naming of one listener within a
// ListenerSet.
func l4ListenerName(endpoint string, protocol gatewayv1.ProtocolType, port int32) string {
	return fmt.Sprintf("%s-%s-%d", endpoint, strings.ToLower(string(protocol)), port)
}

// ListenerNames lists an environment's declared L4 listeners, sorted, for a
// failure message that says what was there instead of only what was not. A
// listener's name carries its endpoint, its protocol and its port, so the list
// is also what a reader needs to see a stale declaration beside the current one.
func ListenerNames(ls *gatewayv1.ListenerSet) []string {
	names := make([]string, 0, len(ls.Spec.Listeners))
	for _, l := range ls.Spec.Listeners {
		names = append(names, string(l.Name))
	}
	slices.Sort(names)
	return names
}

// DataplaneService is the Service Envoy Gateway fronts the Gateway with, found
// by the preflight and carried on the suite.
//
// Found once at setup rather than per case: which Service it is is a property of
// the install, and looking it up again in every case would make a change to the
// lookup indistinguishable from a change to what the case is about.
func (s *Suite) DataplaneService(ctx context.Context) (*corev1.Service, error) {
	if s.Cluster.DataplaneServiceName == "" {
		return nil, errors.New("the preflight found no dataplane Service")
	}
	var svc corev1.Service
	key := client.ObjectKey{
		Namespace: s.Cluster.DataplaneServiceNamespace,
		Name:      s.Cluster.DataplaneServiceName,
	}
	if err := s.Client.Get(ctx, key, &svc); err != nil {
		return nil, fmt.Errorf("reading %s/%s: %w", key.Namespace, key.Name, err)
	}
	return &svc, nil
}

// DataplanePort reports whether the dataplane Service publishes a port.
//
// A port declared by a ListenerSet is not a port being served: the dataplane
// Service is what the Gateway's address actually points at, and until the
// allocated port appears there the address the environment publishes leads
// nowhere. That is the gap between "the platform published an endpoint" and "the
// endpoint answers", and it is the one a case about publication has to close.
func (s *Suite) DataplanePort(ctx context.Context, port int32) (corev1.ServicePort, bool, error) {
	svc, err := s.DataplaneService(ctx)
	if err != nil {
		return corev1.ServicePort{}, false, err
	}
	for _, p := range svc.Spec.Ports {
		if p.Port == port {
			return p, true, nil
		}
	}
	return corev1.ServicePort{}, false, nil
}

// DataplaneExternalPort is the port a listener is reachable on at the Gateway's
// address, which is what the endpoint's Address must name.
//
// It mirrors the controller's own rule (::externalPorts) rather than restating
// one of its two outcomes: a NodePort dataplane renumbers every listener onto a
// nodePort, and every other kind serves it on the listener's own port. A case
// that hardcoded one of the two would be asserting the cluster it was written
// against; asking the Service is what makes the assertion hold on both.
func (s *Suite) DataplaneExternalPort(ctx context.Context, port int32) (int32, bool, error) {
	p, found, err := s.DataplanePort(ctx, port)
	if err != nil || !found {
		return 0, found, err
	}
	svc, err := s.DataplaneService(ctx)
	if err != nil {
		return 0, false, err
	}
	if svc.Spec.Type == corev1.ServiceTypeNodePort {
		return p.NodePort, true, nil
	}
	return p.Port, true, nil
}
