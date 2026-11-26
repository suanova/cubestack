package controller

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// portPoolConfig is the part of a controller's configuration the L4 pool draws
// on. It is named apart from DevEnvironmentControllerConfig so the allocator
// carries nothing about the kind of environment that asks it for a port.
type portPoolConfig struct {
	GatewayName               string
	GatewayNamespace          string
	GatewayDataplaneNamespace string
	L4PortRangeStart          int32
	L4PortRangeEnd            int32
}

// portPool is the allocator's view of this controller's configuration.
func (c DevEnvironmentControllerConfig) portPool() portPoolConfig {
	return portPoolConfig{
		GatewayName:               c.GatewayName,
		GatewayNamespace:          c.GatewayNamespace,
		GatewayDataplaneNamespace: c.GatewayDataplaneNamespace,
		L4PortRangeStart:          c.L4PortRangeStart,
		L4PortRangeEnd:            c.L4PortRangeEnd,
	}
}

// portAllocator hands out the shared Gateway's L4 listener ports.
//
// The pool has no object of its own: the ListenerSets attached to the Gateway
// are the ledger, so taking a port is a read of the ledger followed by the
// write that claims a number in it. The mutex (::locked) spans that whole
// sequence, which is what makes the pool safe to draw from in more than one
// place at once.
//
// It knows nothing about the kind of environment that asks: each method takes
// the caller's own inputs — its namespace and name, its recorded endpoints, the
// labels its ListenerSet carries — and the reader to use. One allocator serves
// every kind in the manager process, because serialising each kind's reconciles
// on its own (as MaxConcurrentReconciles does) says nothing about the other
// kind's.
//
// Ports deliberately get no PortPool / PortClaim CRD (D-VM26): a route's name
// and a ListenerSet's listeners already hold the numbers, and a second ledger
// would be a second truth to reconcile against.
type portAllocator struct {
	mu sync.Mutex
}

// locked runs fn with the pool held. A caller wraps its whole allocation in it
// — the read of what is taken, and every write that claims or releases a
// number. Locking the read alone would leave the window the lock exists to
// close: another caller reads the same pool before this one has written its
// claim, and both take the same port.
func (a *portAllocator) locked(fn func() error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return fn()
}

// matchesLabels reports whether labels carries every pair in selector. An
// environment names its own objects with its kind's label — the pool spans
// kinds, so this rather than the label's name is what tells them apart.
func matchesLabels(labels map[string]string, selector client.MatchingLabels) bool {
	for k, v := range selector {
		if labels[k] != v {
			return false
		}
	}
	return true
}

// usedPorts collects every L4 port already allocated to another environment
// (the port pool is gateway-wide, so it spans namespaces and kinds). own is the
// label set the caller writes on the objects it owns, so its own allocations
// are free for it to reuse. Allocations
// are read from the objects that declare them, not from status.endpoints: the
// endpoint list is withheld while a route is unaccepted, and a reservation that
// disappears from under an environment lets two of them claim the same listener
// port. Both objects below are durable records — the ListenerSet holds the port
// outright, and the route's name embeds the port it holds.
//
// The L4 listeners are declared by each environment's ListenerSet, and legacy
// routes attached straight to the Gateway are still counted: the pool is that
// Gateway's listeners, whatever declared them, and counting both is what carries
// ports across the cutover, when routes and ListenerSets briefly coexist. A port
// held by either is taken.
//
// Only objects attached to the configured Gateway count: one parented elsewhere
// holds no listener here. A failed List is returned rather than read as an empty
// pool, which would hand out ports other environments already hold — the one
// exception is a kind the API server does not serve, which holds no objects by
// definition (see the TCPRoute read below).
//
// Every L4 protocol shares this pool: a UDP exposure allocates from here and
// never takes a number TCP already holds. Allocation identity is
// the port number alone — the ListenerSet scan below reads listener ports without
// consulting protocol or listener name, which is what makes that structural. Do
// not add a (protocol, port) key to "reclaim" the shared numbers: the Gateway
// accepts TCP and UDP on one port, so the collision would not be rejected here
// and envtest could not see it (design §8.3).
//
// The Lists go through the API server, not a cache, and the caller holds the
// allocator while it reads: allocation is a read followed by a create, and a
// cached List serves whatever the informer last saw. Reading through is what
// lets the read see the claim another caller wrote a moment ago, and the lock
// keeps the two apart so this one cannot be superseded between the read and
// the write (::locked).
func (a *portAllocator) usedPorts(ctx context.Context, reader client.Reader, cfg portPoolConfig, namespace string, own client.MatchingLabels) (map[int32]bool, error) {
	used := map[int32]bool{}
	// A cluster serving the Gateway API's standard channel has no TCPRoute kind
	// at all. That means there are no legacy routes to count — the ListenerSet
	// scan below is what holds every port this operator allocates — so only "no
	// such kind" is tolerated here: read as a failure it would fail allocation
	// for every L4 environment, including the udp-only and ssh-only ones that
	// never had a TCPRoute to count. Every other error is a failed read of a
	// pool this must not mistake for empty.
	var trs gatewayv1.TCPRouteList
	if err := reader.List(ctx, &trs); err != nil && !meta.IsNoMatchError(err) {
		return nil, err
	}
	// Only TCPRoutes are scanned for their own parent here, and deliberately so:
	// the legacy attachment this covers is a TCPRoute pointed at a listener on
	// the Gateway itself, from before the environment declared its own. UDP had
	// no such era, so every UDPRoute this operator writes hangs off a
	// ListenerSet and its port is already counted below.
	for i := range trs.Items {
		route := &trs.Items[i]
		if route.Namespace == namespace && matchesLabels(route.Labels, own) {
			continue // this environment's own allocations are free for it to reuse
		}
		if !routeParentsTo(route.Spec.ParentRefs, route.Namespace, cfg.GatewayName, cfg.GatewayNamespace) {
			continue
		}
		if p := tcpRoutePort(route.Name); p != 0 {
			used[p] = true
		}
	}
	var lss gatewayv1.ListenerSetList
	if err := reader.List(ctx, &lss); err != nil {
		return nil, err
	}
	for i := range lss.Items {
		ls := &lss.Items[i]
		if ls.Namespace == namespace && matchesLabels(ls.Labels, own) {
			continue
		}
		if !listenerSetParentsToGateway(ls, cfg.GatewayName, cfg.GatewayNamespace) {
			continue
		}
		for _, listener := range ls.Spec.Listeners {
			used[listener.Port] = true
		}
	}
	return used, nil
}

// heldPorts is the listener port each endpoint of this environment already
// holds, for allocatePort to keep. The endpoint list carries it whenever it is
// published; the environment's own ListenerSet — found by the labels the caller
// writes on it — is where it is read from when it is not. That fallback is the
// difference between a stable address and a moving one: the list is withheld
// while a route or the Gateway is unaccepted, and a Gateway is an object the
// platform creates, replaces and deletes underneath an install, so an
// environment reads as holding nothing at exactly the moment its listeners are
// still declared. Allocation would then hand out the lowest free port instead of
// the environment's own, and the SSH address a user was given would stop being
// the one that answers.
//
// wanted names every endpoint the environment publishes, so a caller can tell
// a complete record from one that is missing an entry.
//
// The endpoint list wins where both name the same endpoint. They can only
// disagree after a reconcile that allocated a port, applied the ListenerSet and
// then failed before writing the endpoints, and settling on the published port
// is the choice that leaves the address the user was last shown unchanged.
func (a *portAllocator) heldPorts(ctx context.Context, reader client.Reader, namespace string, selector client.MatchingLabels, endpoints []aiv1alpha1.Endpoint, wanted []string) (map[string]int32, error) {
	held := make(map[string]int32, len(wanted))
	for _, ep := range endpoints {
		if ep.ListenerPort != 0 {
			held[ep.Name] = ep.ListenerPort
		}
	}
	unrecorded := false
	for _, endpointName := range wanted {
		if _, ok := held[endpointName]; !ok {
			unrecorded = true
			break
		}
	}
	if !unrecorded {
		return held, nil // every endpoint has a record; the ListenerSet adds nothing
	}
	// Read through the API server for the reason usedPorts does: this read is
	// followed by the write of the port it returns, and a cache may not have
	// caught up with the previous reconcile's.
	var lss gatewayv1.ListenerSetList
	err := reader.List(ctx, &lss, client.InNamespace(namespace), selector)
	if err != nil {
		// No ListenerSet kind means no listener was ever declared, and so nothing
		// to recover — the same tolerance usedPorts extends to the TCPRoute read.
		if meta.IsNoMatchError(err) {
			return held, nil
		}
		return nil, err
	}
	for i := range lss.Items {
		for _, listener := range lss.Items[i].Spec.Listeners {
			endpointName := l4ListenerEndpoint(listener.Name)
			if endpointName == "" {
				continue
			}
			if _, recorded := held[endpointName]; !recorded {
				held[endpointName] = listener.Port
			}
		}
	}
	return held, nil
}

// allocatePort picks a port for the named endpoint, reusing the port that
// endpoint already holds when it is still free (stable across restarts) and
// otherwise the lowest free port in the configured range. The record is the
// listener port the environment holds, never the port in an endpoint's address:
// that one says where the endpoint is reachable, not which pool port the
// environment was given.
//
// It marks its choice in used, so a second port for the same environment cannot
// be the same one. Callers hold the allocator across the whole set of calls
// (::locked): the marking is only meaningful inside one read of the pool.
func (a *portAllocator) allocatePort(cfg portPoolConfig, name string, used map[int32]bool, held map[string]int32) int32 {
	if p, ok := held[name]; ok && p >= cfg.L4PortRangeStart && p <= cfg.L4PortRangeEnd && !used[p] {
		used[p] = true
		return p
	}
	for p := cfg.L4PortRangeStart; p <= cfg.L4PortRangeEnd; p++ {
		if !used[p] {
			used[p] = true
			return p
		}
	}
	return 0
}

// externalPorts maps each given listener port to the port it is reachable on at
// the Gateway's address. Its argument is the listener ports keyed to the
// transport each speaks, since a dataplane Service names both.
//
// A LoadBalancer or ClusterIP dataplane serves a listener on the listener's own
// port, so the mapping is the identity. A NodePort dataplane renumbers every
// listener onto a nodePort instead, and only the dataplane Service knows the
// assignment: the Gateway's status carries an address but no ports. Reading the
// Service is what keeps a published endpoint an address that works.
//
// It reads through the API server rather than a cache: an address published
// from a stale read is wrong in the user's hands, and this read is all that
// stands between the dataplane's port assignment and the address a user is
// handed. A listener the dataplane does not expose yet is reported rather than
// passed through as its own port, so an endpoint is either known-reachable or
// withheld — never silently dead.
func (a *portAllocator) externalPorts(ctx context.Context, reader client.Reader, cfg portPoolConfig, gw *gatewayv1.Gateway, ports map[int32]corev1.Protocol) (map[int32]int32, error) {
	external := make(map[int32]int32, len(ports))
	for p := range ports {
		external[p] = p
	}
	if cfg.GatewayDataplaneNamespace == "" {
		return external, nil
	}
	var svcs corev1.ServiceList
	if err := reader.List(ctx, &svcs, client.InNamespace(cfg.GatewayDataplaneNamespace), client.MatchingLabels{
		gatewayDataplaneNameLabel:      gw.Name,
		gatewayDataplaneNamespaceLabel: gw.Namespace,
	}); err != nil {
		return nil, err
	}
	var dataplane *corev1.Service
	for i := range svcs.Items {
		if svcs.Items[i].Spec.Type == corev1.ServiceTypeNodePort {
			dataplane = &svcs.Items[i]
			break
		}
	}
	if dataplane == nil {
		return external, nil
	}
	for p, protocol := range ports {
		nodePort := int32(0)
		for _, sp := range dataplane.Spec.Ports {
			// The protocol is matched as well as the number. A dataplane
			// Service carries one entry per TCP and per UDP listener, and the
			// two are not obliged to agree on a number outside this operator's
			// pool: a protocol-blind match could return the other entry's
			// nodePort, naming a port that does not serve this endpoint at all.
			if sp.Port == p && sp.Protocol == protocol {
				nodePort = sp.NodePort
				break
			}
		}
		if nodePort == 0 {
			return nil, fmt.Errorf("dataplane Service %s/%s exposes no nodePort for the %s listener port %d", dataplane.Namespace, dataplane.Name, protocol, p)
		}
		external[p] = nodePort
	}
	return external, nil
}
