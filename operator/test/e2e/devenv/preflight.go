package devenv

import (
	"context"
	"fmt"
	"net"
	"slices"
	"strconv"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

// The platform's own defaults, mirroring the manager's. They are only reached
// when a flag is absent, and a flag being absent is itself reported — so these
// exist to make the pool bounds computable while that failure is on screen, not
// to paper over a missing flag.
const (
	defaultGatewayNamespace = "envoy-gateway-system"
	defaultL4Start          = 20000
	defaultL4End            = 20999
)

// Result is one precondition's outcome.
//
// Detail is what was found, printed whether or not the check passed: a run whose
// report says "gateway … address=10.66.3.210:80" is one somebody can compare
// against what they expected, and a run that only prints failures makes them ask
// the cluster.
type Result struct {
	Name   string
	Detail string
	Err    error
}

// Ok reports whether the precondition held.
func (r Result) Ok() bool { return r.Err == nil }

// String renders the result the way the run prints it.
func (r Result) String() string {
	if r.Ok() {
		return fmt.Sprintf("PASS  %-28s %s", r.Name, r.Detail)
	}
	return fmt.Sprintf("FAIL  %-28s %v", r.Name, r.Err)
}

// Cluster is what the preconditions established: the objects and numbers every
// case and every later check needs, read once from the cluster that will do the
// work rather than from constants that could disagree with it.
type Cluster struct {
	// ManagerNamespace and ManagerName identify the Deployment found by the flag
	// it carries — the only way to find the DevEnvironment controller without
	// assuming a release name.
	ManagerNamespace string
	ManagerName      string

	GatewayNamespace string
	GatewayName      string
	// Address is the Gateway's published address, the host every endpoint's
	// address is built on.
	Address string
	// HTTPPort is the Gateway listener port that carries HTTP.
	HTTPPort int32

	// DataplaneNamespace is where the manager admits ingress from, read from its
	// own flag. It is where each environment's NetworkPolicy points, which is not
	// necessarily where the dataplane Service lives.
	DataplaneNamespace string
	DataplaneType      corev1.ServiceType

	// DataplaneServiceNamespace and DataplaneServiceName identify the Service
	// Envoy Gateway fronts the Gateway with. An accepted ListenerSet's port has
	// to appear on it for the published address to answer, which is what the
	// publication cases read it for.
	DataplaneServiceNamespace string
	DataplaneServiceName      string

	L4Start int32
	L4End   int32
}

// Check runs every precondition and returns them all.
//
// All of them, never stopping at the first: several of these make a run silently
// vacuous rather than failing it, and a person who fixes one only to be told
// about the next has been made to work for something the cluster already knew.
type Preflight struct {
	Client client.Client
	Dialer Dialer
	// PullSecretNamespace and PullSecretName are checked for presence only; the
	// copy into the run's namespace is Setup's job.
	PullSecretNamespace string
	PullSecretName      string
	// NeededPorts is how many L4 ports this selection will hold at once, which is
	// what the pool check measures against.
	NeededPorts int
}

// Run performs every check and returns the cluster description it built.
//
// The description is returned even when checks failed, because it is what the
// failure messages were built from, and a caller reporting the results wants to
// name the objects it could not use.
func (p Preflight) Run(ctx context.Context) (Cluster, []Result) {
	var c Cluster
	var results []Result

	add := func(r Result) { results = append(results, r) }

	add(p.checkContext())
	add(p.checkManager(ctx, &c))
	add(p.checkGateway(ctx, &c))
	add(p.checkAllowedListeners(ctx, &c))
	add(p.checkDataplane(ctx, &c))
	add(p.checkL4Pool(ctx, &c))
	add(p.checkStorage(ctx))
	add(p.checkPullCredential(ctx))
	add(p.checkAgentRouter(ctx))
	// Last, and only when the Gateway produced an address: there is nothing to
	// probe otherwise, and reporting an unreachable address as its own failure on
	// top of the missing one says the same thing twice.
	if c.Address != "" {
		add(p.checkReach(ctx, &c))
	}
	return c, results
}

// --- each check ---------------------------------------------------------------

// checkContext refuses a kind cluster.
//
// This is the guard against the one way the conformance mode can be entered by
// accident: `DEVENV_E2E=1` left set while running the existing kind path. That
// would skip the cluster build and point the kind specs at whatever KUBECONFIG
// holds — a silent misdirection, and an expensive one, because the existing
// specs deploy a manager and expect to have made the cluster themselves.
func (p Preflight) checkContext() Result {
	const name = "cluster identity"
	current, err := CurrentContext()
	if err != nil {
		return Result{Name: name, Err: err}
	}
	if strings.HasPrefix(current, "kind-") {
		return Result{
			Name: name,
			Err: fmt.Errorf("context %q is a kind cluster; this suite runs against an existing "+
				"cluster and DEVENV_E2E=1 must not be set on the kind path", current),
		}
	}
	return Result{Name: name, Detail: "context " + current}
}

// checkManager finds the DevEnvironment controller by the flag it carries.
//
// Discovered rather than named, because the thing being checked is that *this
// cluster's* manager points at *this cluster's* Gateway. Reading a Deployment
// called cubestack-controller-manager would answer a question about a release
// name instead. The L4 bounds are read out of it here and used by every check
// below, so the pool is always the one the process doing the allocating will use.
func (p Preflight) checkManager(ctx context.Context, c *Cluster) Result {
	const name = "manager"
	var deploys appsv1.DeploymentList
	if err := p.Client.List(ctx, &deploys); err != nil {
		return Result{Name: name, Err: fmt.Errorf("listing Deployments: %w", err)}
	}

	for i := range deploys.Items {
		d := &deploys.Items[i]
		for _, container := range d.Spec.Template.Spec.Containers {
			args := flagMap(container.Args)
			if _, ok := args["gateway-name"]; !ok {
				continue
			}
			c.ManagerNamespace, c.ManagerName = d.Namespace, d.Name
			c.GatewayName = args["gateway-name"]
			c.GatewayNamespace = args["gateway-namespace"]
			c.DataplaneNamespace = args["gateway-dataplane-namespace"]
			if c.GatewayNamespace == "" {
				c.GatewayNamespace = defaultGatewayNamespace
			}
			c.L4Start = int32(atoiOr(args["l4-port-range-start"], defaultL4Start))
			c.L4End = int32(atoiOr(args["l4-port-range-end"], defaultL4End))

			var missing []string
			if c.DataplaneNamespace == "" {
				missing = append(missing, "--gateway-dataplane-namespace")
			}
			if _, ok := args["l4-port-range-start"]; !ok {
				missing = append(missing, "--l4-port-range-start")
			}
			if _, ok := args["l4-port-range-end"]; !ok {
				missing = append(missing, "--l4-port-range-end")
			}
			if len(missing) > 0 {
				return Result{
					Name: name,
					Err: fmt.Errorf("%s/%s sets no %s; without the dataplane namespace each environment's "+
						"NetworkPolicy admits no ingress and its L4 ports draw from a pool nobody stated",
						d.Namespace, d.Name, strings.Join(missing, ", ")),
				}
			}
			return Result{
				Name: name,
				Detail: fmt.Sprintf("%s/%s → %s/%s, L4 %d-%d",
					d.Namespace, d.Name, c.GatewayNamespace, c.GatewayName, c.L4Start, c.L4End),
			}
		}
	}
	return Result{
		Name: name,
		Err: fmt.Errorf("no Deployment carries --gateway-name; the DevEnvironment controller " +
			"does not appear to be running"),
	}
}

// checkGateway reports whether the platform's Gateway is up and published.
func (p Preflight) checkGateway(ctx context.Context, c *Cluster) Result {
	const name = "gateway"
	if c.GatewayName == "" {
		return Result{Name: name, Err: fmt.Errorf("not reached: the manager check found no --gateway-name")}
	}
	var gw gatewayv1.Gateway
	key := client.ObjectKey{Namespace: c.GatewayNamespace, Name: c.GatewayName}
	if err := p.Client.Get(ctx, key, &gw); err != nil {
		return Result{Name: name, Err: fmt.Errorf("reading %s/%s: %w", c.GatewayNamespace, c.GatewayName, err)}
	}

	var unmet []string
	for _, t := range []gatewayv1.GatewayConditionType{
		gatewayv1.GatewayConditionAccepted,
		gatewayv1.GatewayConditionProgrammed,
	} {
		cond := gatewayCondition(gw.Status.Conditions, t)
		if cond == nil {
			unmet = append(unmet, fmt.Sprintf("%s not recorded", t))
			continue
		}
		if cond.Status != metav1.ConditionTrue {
			unmet = append(unmet, fmt.Sprintf("%s=%s (%s: %s)", t, cond.Status, cond.Reason, cond.Message))
		}
	}
	if len(unmet) > 0 {
		return Result{Name: name, Err: fmt.Errorf("%s/%s: %s", c.GatewayNamespace, c.GatewayName, strings.Join(unmet, "; "))}
	}
	if len(gw.Status.Addresses) == 0 {
		// Without an address the controller withholds every endpoint, so the whole
		// run would report unreachable endpoints that were never published.
		return Result{
			Name: name,
			Err: fmt.Errorf("%s/%s is Programmed but published no address; status.endpoints stays empty "+
				"without one, because a dataplane Service needs an ingress address",
				c.GatewayNamespace, c.GatewayName),
		}
	}
	c.Address = gw.Status.Addresses[0].Value

	for _, l := range gw.Spec.Listeners {
		if l.Protocol == gatewayv1.HTTPProtocolType {
			c.HTTPPort = l.Port
			break
		}
	}
	if c.HTTPPort == 0 {
		return Result{
			Name: name,
			Err: fmt.Errorf("%s/%s has no HTTP listener; the web endpoint's address is built on one",
				c.GatewayNamespace, c.GatewayName),
		}
	}
	return Result{
		Name: name,
		Detail: fmt.Sprintf("%s/%s Accepted, Programmed, address=%s, http=%d",
			c.GatewayNamespace, c.GatewayName, c.Address, c.HTTPPort),
	}
}

// checkAllowedListeners reports whether the Gateway admits tenant ListenerSets.
//
// The API default is None, which refuses every ListenerSet — so every
// environment's L4 port stays unprogrammed while the environment reads healthy.
// That is the failure this check exists to turn into one sentence.
func (p Preflight) checkAllowedListeners(ctx context.Context, c *Cluster) Result {
	const name = "allowedListeners"
	if c.GatewayName == "" {
		return Result{Name: name, Err: fmt.Errorf("not reached: no Gateway to read")}
	}
	var gw gatewayv1.Gateway
	key := client.ObjectKey{Namespace: c.GatewayNamespace, Name: c.GatewayName}
	if err := p.Client.Get(ctx, key, &gw); err != nil {
		return Result{Name: name, Err: fmt.Errorf("reading %s/%s: %w", c.GatewayNamespace, c.GatewayName, err)}
	}
	if gw.Spec.AllowedListeners == nil || gw.Spec.AllowedListeners.Namespaces == nil {
		return Result{
			Name: name,
			Err: fmt.Errorf("%s/%s sets no allowedListeners; the API default is None, which refuses "+
				"every ListenerSet, so no ssh endpoint can be programmed", c.GatewayNamespace, c.GatewayName),
		}
	}
	from := gw.Spec.AllowedListeners.Namespaces.From
	if from == nil || *from != gatewayv1.NamespacesFromAll {
		got := "<unset>"
		if from != nil {
			got = string(*from)
		}
		return Result{
			Name: name,
			Err: fmt.Errorf("%s/%s has allowedListeners.namespaces.from=%s, expected All",
				c.GatewayNamespace, c.GatewayName, got),
		}
	}
	return Result{Name: name, Detail: "from: All"}
}

// checkDataplane finds the Service that fronts the Gateway and asks whether it
// carries the HTTP listener.
//
// The Service's type is reported either way, because a NodePort dataplane
// renumbers the address: the listener port and the published port then differ,
// and a case comparing them has to know that it is expected rather than a bug.
func (p Preflight) checkDataplane(ctx context.Context, c *Cluster) Result {
	const name = "dataplane"
	if c.GatewayName == "" {
		return Result{Name: name, Err: fmt.Errorf("not reached: no Gateway to look behind")}
	}
	var svcs corev1.ServiceList
	sel := labels.SelectorFromSet(labels.Set{"gateway.envoyproxy.io/owning-gateway-name": c.GatewayName})
	if err := p.Client.List(ctx, &svcs, client.MatchingLabelsSelector{Selector: sel}); err != nil {
		return Result{Name: name, Err: fmt.Errorf("listing the Gateway's dataplane Services: %w", err)}
	}
	if len(svcs.Items) == 0 {
		return Result{
			Name: name,
			Err: fmt.Errorf("no Service carries gateway.envoyproxy.io/owning-gateway-name=%s",
				c.GatewayName),
		}
	}
	svc := &svcs.Items[0]
	c.DataplaneType = svc.Spec.Type
	c.DataplaneServiceNamespace, c.DataplaneServiceName = svc.Namespace, svc.Name

	if svc.Spec.Type != corev1.ServiceTypeLoadBalancer {
		return Result{
			Name: name,
			Detail: fmt.Sprintf("%s/%s type=%s (not LoadBalancer: listener and published ports may differ)",
				svc.Namespace, svc.Name, svc.Spec.Type),
		}
	}
	for _, port := range svc.Spec.Ports {
		if port.Port == c.HTTPPort {
			return Result{
				Name:   name,
				Detail: fmt.Sprintf("%s/%s LoadBalancer publishes http port %d", svc.Namespace, svc.Name, c.HTTPPort),
			}
		}
	}
	return Result{
		Name: name,
		Err: fmt.Errorf("%s/%s (LoadBalancer) does not publish port %d; the web endpoint's address "+
			"names an address nothing is listening on", svc.Namespace, svc.Name, c.HTTPPort),
	}
}

// checkL4Pool refuses a run that would exhaust the port range.
//
// The range is cluster-wide and shared with every other tenant's environments,
// and Kubernetes makes a duplicate listener port a conflict rather than a queue.
// Counting before allocating is what turns "the pool is nearly full" into a
// sentence instead of a run that fails at a different place each time.
func (p Preflight) checkL4Pool(ctx context.Context, c *Cluster) Result {
	const name = "L4 port pool"
	if c.L4Start == 0 || c.L4End == 0 {
		return Result{Name: name, Err: fmt.Errorf("not reached: the manager check found no pool bounds")}
	}
	var sets gatewayv1.ListenerSetList
	if err := p.Client.List(ctx, &sets); err != nil {
		return Result{Name: name, Err: fmt.Errorf("listing ListenerSets: %w", err)}
	}
	used := map[int32]bool{}
	for i := range sets.Items {
		for _, l := range sets.Items[i].Spec.Listeners {
			port := l.Port
			if port >= c.L4Start && port <= c.L4End {
				used[port] = true
			}
		}
	}
	size := int(c.L4End - c.L4Start + 1)
	free := size - len(used)

	detail := fmt.Sprintf("%d-%d: %d of %d free, this selection needs %d", c.L4Start, c.L4End, free, size, p.NeededPorts)
	if free < p.NeededPorts {
		return Result{
			Name: name,
			Err: fmt.Errorf("%s — %d ports are held by ListenerSets already on the cluster",
				detail, len(used)),
		}
	}
	return Result{Name: name, Detail: detail}
}

// checkStorage reports whether the workspace StorageClass exists.
//
// The controller hardcodes cephfs-ephemeral for the workspace claim rather than
// taking it from the spec, so this is the class an environment needs whether the
// user asked for it or not.
func (p Preflight) checkStorage(ctx context.Context) Result {
	const name = "workspace StorageClass"
	const class = "cephfs-ephemeral"
	var sc storagev1.StorageClass
	if err := p.Client.Get(ctx, client.ObjectKey{Name: class}, &sc); err != nil {
		return Result{
			Name: name,
			Err: fmt.Errorf("StorageClass %s: %v; every workspace claim is provisioned from it, so "+
				"no environment binds without it", class, err),
		}
	}
	return Result{Name: name, Detail: fmt.Sprintf("%s (%s)", class, sc.Provisioner)}
}

// checkPullCredential reports whether the credential the suite copies exists.
//
// Only the source Secret: the copy and the ServiceAccount reference are Setup's
// job, and it either did them or said why not. This check exists so that a run
// whose images will never pull says so once, in the preflight, rather than as
// twelve ImagePullBackOff failures that read as image findings.
func (p Preflight) checkPullCredential(ctx context.Context) Result {
	const name = "pull credential"
	var s corev1.Secret
	key := client.ObjectKey{Namespace: p.PullSecretNamespace, Name: p.PullSecretName}
	if err := p.Client.Get(ctx, key, &s); err != nil {
		return Result{
			Name: name,
			Err:  fmt.Errorf("reading the source credential %s/%s: %w", p.PullSecretNamespace, p.PullSecretName, err),
		}
	}
	return Result{Name: name, Detail: fmt.Sprintf("%s/%s", p.PullSecretNamespace, p.PullSecretName)}
}

// checkAgentRouter reports whether ai-gateway's Agent Router is installed.
//
// Not a preference. Its xDS translator aborts Envoy Gateway's whole translation
// as soon as any TCP listener exists, so an installed Agent Router leaves every
// ssh listener unprogrammed while the environments themselves look perfectly
// healthy. Diagnosing that from the cases costs twelve identical transport
// failures and points at the wrong component.
func (p Preflight) checkAgentRouter(ctx context.Context) Result {
	const name = "no Agent Router"
	const group = "aigateway.envoyproxy.io"
	var crds apiextensionsv1.CustomResourceDefinitionList
	if err := p.Client.List(ctx, &crds); err != nil {
		return Result{Name: name, Err: fmt.Errorf("listing CRDs: %w", err)}
	}
	var found []string
	for i := range crds.Items {
		if crds.Items[i].Spec.Group == group {
			found = append(found, crds.Items[i].Name)
		}
	}
	if len(found) == 0 {
		return Result{Name: name, Detail: "no " + group + " CRDs"}
	}
	slices.Sort(found)
	return Result{
		Name: name,
		Err: fmt.Errorf("%s installed (%s); with the Agent Router enabled, Envoy Gateway aborts xDS "+
			"translation as soon as any TCP listener exists, so no ssh endpoint is ever programmed",
			group, strings.Join(found, ", ")),
	}
}

// checkReach reports whether this host can get to the Gateway at all.
//
// Last, because it needs the address. A failure here would otherwise surface as
// the first case reporting a Jupyter 000, which reads as an image problem.
func (p Preflight) checkReach(ctx context.Context, c *Cluster) Result {
	const name = "reach"
	addr := joinHostPort(c.Address, c.HTTPPort)

	probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := p.Dialer.Prober()(probeCtx, addr); err != nil {
		via := "directly"
		if p.Dialer.Proxy != "" {
			via = "through " + p.Dialer.Proxy
		}
		return Result{
			Name: name,
			Err: fmt.Errorf("cannot reach %s %s: %v; on a private network start a proxy and set %s, e.g. "+
				"ssh -D 1080 <node> then DEVENV_E2E_PROXY=socks5h://127.0.0.1:1080",
				addr, via, err, envProxy),
		}
	}
	via := "direct"
	if p.Dialer.Proxy != "" {
		via = p.Dialer.Proxy
	}
	return Result{Name: name, Detail: fmt.Sprintf("%s via %s", addr, via)}
}

// --- helpers ------------------------------------------------------------------

func joinHostPort(host string, port int32) string {
	return net.JoinHostPort(host, strconv.Itoa(int(port)))
}

// flagMap turns a container's args into a name→value map. A flag with no "="
// keeps an empty value, which is enough for "is it set at all".
func flagMap(args []string) map[string]string {
	m := make(map[string]string, len(args))
	for _, a := range args {
		name, value, _ := strings.Cut(strings.TrimPrefix(a, "--"), "=")
		m[name] = value
	}
	return m
}

func atoiOr(s string, fallback int) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return fallback
	}
	return n
}

func gatewayCondition(conds []metav1.Condition, t gatewayv1.GatewayConditionType) *metav1.Condition {
	return meta.FindStatusCondition(conds, string(t))
}
