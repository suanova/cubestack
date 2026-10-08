//go:build e2e
// +build e2e

package e2e

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/test/e2e/devenv"
)

// Family K: the L4 port pool (§4.K).
//
// The pool is one number space shared by every environment in the cluster, and
// what it hands out is the address a user is already connected to. So these are
// the cases about the bookkeeping around it: which kind of exposure publishes
// where, which protocol a drawn port speaks, whether a number that is no longer
// used goes back, and whether two environments can ever draw the same one.
//
// One environment carries the first four — a jupyter environment with one
// exposure of each type on top of the ssh listener its manifest already asks
// for. It is deliberately a small image: the subject is the allocator, and a
// multi-gigabyte pull would buy nothing.

// The names the extra exposures are declared under. Each is also the endpoint
// name the platform publishes it as, which is the point of naming them at all:
// a port's user-visible identity is the name in its spec.
const (
	portHTTPName  = "probe-http"
	portHTTP2Name = "probe-http-2"
	portTCPName   = "probe-tcp"
	portUDPName   = "probe-udp"

	// portRepeatName is declared on a container port the Service already
	// publishes, which is what K6 is about and what the four above deliberately
	// avoid.
	portRepeatName = "notebook-again"
)

// The container ports the two http exposures name. Neither is a port the image
// serves — sshd and the notebook are what the other exposures are for — and
// neither repeats one the Service already publishes, so each is an entry of its
// own and the cases below are about the routing rather than about a repeat being
// folded into the platform's own entry (::desiredService, and K6 for that case).
//
// They differ from each other for the same reason: two exposures naming one
// container port are one Service entry, however they are named.
const (
	portHTTPContainer  int32 = 8080
	portHTTP2Container int32 = 8081
)

// describePorts is family K: the exposures an environment publishes, and the
// shared pool the L4 ones draw their numbers from.
func describePorts() {
	describeExtraPorts()
	describePoolIsShared()
}

// extraPorts is the spec family K's first four cases run against.
//
// The container ports are the notebook's own and the image's sshd, so each
// exposure has something behind it that already answers. Nothing here needs a
// process started inside the environment to be reachable, which is what lets
// the tcp one be asserted end to end. The sshd is at 2222 and the Service
// publishes it as 22, so an exposure on 2222 is a port the Service does not
// already carry.
//
// The http one is the exception, and deliberately: 8080 is a port the container
// does not listen on, because the notebook's own 8888 is already published as
// the Service's `main` entry — as are its ssh and jupyter endpoints. An exposure
// naming 8888 anyway is folded into that entry rather than added beside it
// (::desiredService), and is a case of its own below (K6); naming a port of its
// own is what makes this exposure an entry the Service carries for its sake,
// which is what K1 reads the routing against. Nothing dials the http exposure,
// because what it is about is the routing.
func extraPorts(want *aiv1alpha1.DevEnvironment) {
	want.Spec.Ports = []aiv1alpha1.PortSpec{
		{Name: portHTTPName, Type: aiv1alpha1.PortTypeHTTP, ContainerPort: portHTTPContainer},
		{Name: portTCPName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: devenv.ContainerSSHPort},
		{Name: portUDPName, Type: aiv1alpha1.PortTypeUDP, ContainerPort: devenv.ContainerJupyterPort},
	}
}

// describeExtraPorts is K1–K4 and K6: what the exposures an environment
// declares beyond the notebook and sshd are, and where each is published.
func describeExtraPorts() {
	draftCase{
		Name:     "ports-extra",
		Image:    devenv.MustImage("jupyter-minimal"),
		Identity: devenv.NonRoot,
		Shape:    extraPorts,
		Cases: func(open func() *devenv.Environment) {
			It("K1 publishes an http exposure on the Gateway's own HTTP listener",
				Label(devenv.TierP1, devenv.LabelFamily("K")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					ep, ok := env.Endpoint(portHTTPName)
					Expect(ok).To(BeTrue(), "status published no %s endpoint (has %v)",
						portHTTPName, env.EndpointNames())

					// The whole of the claim: an http exposure rides the listener the
					// Gateway already serves HTTP on, and holds no pool port. A port
					// drawn from the L4 pool would be published at the same host and
					// served by nothing — nothing but the environment's own
					// ListenerSet builds a listener, and an http exposure declares
					// none.
					Expect(ep.ListenerPort).To(Equal(cluster.HTTPPort),
						"an http exposure is published on listener port %d, not the Gateway's HTTP port %d",
						ep.ListenerPort, cluster.HTTPPort)

					// And the address is the platform's own, read rather than
					// assembled: the Gateway's address, under the environment's
					// prefix, ending in the port's name.
					wantPath := fmt.Sprintf("/dev/%s/%s/port/%s/", env.Namespace, env.Name, portHTTPName)
					Expect(addressScheme(ep.Address)).To(Equal("http"),
						"an http exposure is published with the scheme its client needs")
					host, err := addressHost(ep.Address)
					Expect(err).NotTo(HaveOccurred())
					Expect(host).To(Equal(cluster.Address),
						"the http exposure is published at a different host from the Gateway's")
					gotPath, err := addressPath(ep.Address)
					Expect(err).NotTo(HaveOccurred())
					Expect(gotPath).To(Equal(wantPath),
						"the address a user is handed does not name the port they declared")

					// The route has to forward to the container port the spec
					// declared. The environment's Service carries one entry per
					// published port, and a rule that names the Service with the
					// wrong port is accepted by every component and answers
					// nothing.
					rules, err := env.HTTPRouteRules(ctx)
					Expect(err).NotTo(HaveOccurred())
					var rule *devenv.HTTPRouteRule
					for i := range rules {
						if rules[i].PathPrefix == wantPath {
							rule = &rules[i]
							break
						}
					}
					Expect(rule).NotTo(BeNil(),
						"the web route has no rule for the port's path (rules: %v)", rules)
					Expect(rule.BackendPort).To(Equal(portHTTPContainer),
						"the rule forwards to a port the spec did not declare")

					svc, err := env.Service(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(servicePortNames(svc)).To(ContainElement(portHTTPName),
						"the environment's Service carries no entry a route could name")

					// And no listener of its own, which is the difference between an
					// http exposure and the two below.
					ls, err := env.ListenerSet(ctx)
					Expect(err).NotTo(HaveOccurred())
					for _, l := range ls.Spec.Listeners {
						Expect(int32(l.Port)).NotTo(Equal(cluster.HTTPPort),
							"the environment declares an L4 listener on the Gateway's own HTTP port")
					}
				})

			It("K2 draws tcp and udp from the pool, and the tcp one serves",
				Label(devenv.TierP1, devenv.LabelFamily("K")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					// One namespace, one number space: ssh and the two L4
					// exposures all draw from the same pool, and no two of them may
					// collide. Distinctness is asserted rather than assumed because
					// the allocator keys on the port alone — tcp and udp share its
					// numbering, so one number serves one protocol for one
					// environment, and these three are the case that says so.
					ports := map[string]int32{}
					for _, name := range []string{devenv.SSHEndpointName, portTCPName, portUDPName} {
						ep, ok := env.Endpoint(name)
						Expect(ok).To(BeTrue(), "status published no %s endpoint (has %v)",
							name, env.EndpointNames())
						Expect(ep.ListenerPort).To(BeNumerically(">=", cluster.L4Start),
							"%s is published below the pool %d-%d", name, cluster.L4Start, cluster.L4End)
						Expect(ep.ListenerPort).To(BeNumerically("<=", cluster.L4End),
							"%s is published above the pool %d-%d", name, cluster.L4Start, cluster.L4End)
						ports[name] = ep.ListenerPort
					}
					seen := map[int32]string{}
					for name, port := range ports {
						if other, taken := seen[port]; taken {
							Fail(fmt.Sprintf("%s and %s share L4 port %d", name, other, port))
						}
						seen[port] = name
					}

					// Each is declared to the Gateway as the transport it speaks,
					// on the port status publishes for it. A udp exposure declared
					// TCP would be accepted and then forward nothing, which is the
					// failure the listener's protocol exists to prevent.
					for name, protocol := range map[string]string{
						portTCPName: "TCP",
						portUDPName: "UDP",
					} {
						entry, _, err := env.L4Listener(ctx, name)
						Expect(err).NotTo(HaveOccurred(),
							"the environment declares no listener for %s", name)
						Expect(strings.ToUpper(string(entry.Protocol))).To(Equal(protocol),
							"%s is declared as %s, not %s", name, entry.Protocol, protocol)
						Expect(int32(entry.Port)).To(Equal(ports[name]),
							"%s is published on port %d and declared on %d",
							name, ports[name], entry.Port)
					}

					// The tcp one end to end. The environment's sshd is what is
					// behind it, and it presents the host key the platform minted
					// whichever listener it is reached on — so a handshake that
					// sees that key proves the whole path at once: the pool port,
					// the environment's listener, its TCPRoute, the Service's entry
					// and the container. A listener that is accepted and programmed
					// but wired to nothing fails here and nowhere earlier.
					tcp, ok := env.Endpoint(portTCPName)
					Expect(ok).To(BeTrue())
					tcpHost, err := addressHost(tcp.Address)
					Expect(err).NotTo(HaveOccurred())
					Expect(tcpHost).To(Equal(cluster.Address),
						"the tcp exposure is published at a different host from the Gateway's")
					Expect(addressScheme(tcp.Address)).To(BeEmpty(),
						"a tcp exposure is published as a bare address, for the client to prefix")

					want, err := env.SSHHostKey(ctx)
					Expect(err).NotTo(HaveOccurred())
					presented, err := conformance.Dialer.SSHPresentedHostKey(ctx, tcp.Address)
					Expect(err).NotTo(HaveOccurred(),
						"nothing answered an ssh handshake on the tcp exposure's address %s", tcp.Address)
					Expect(presented.Marshal()).To(Equal(want.Marshal()),
						"the tcp exposure reaches a server that is not this environment's")

					// The udp one's reachability is not asserted, and the reason is
					// on this side rather than the platform's: a datagram has to
					// leave through the suite's SOCKS5 dialer, which carries a TCP
					// connection and has no UDP association to offer. What is
					// asserted is the platform's whole half of it — declared,
					// programmed, and carried by the dataplane Service — and the
					// address in status is the one a client with a datagram path
					// would use.
					udp, ok := env.Endpoint(portUDPName)
					Expect(ok).To(BeTrue())
					Eventually(func() error {
						_, st, err := env.L4Listener(ctx, portUDPName)
						if err != nil {
							return err
						}
						if c := devenv.ListenerProgrammed(st); c == nil || c.Status != "True" {
							return fmt.Errorf("the udp listener is %s", devenv.ConditionSummary(c))
						}
						_, found, err := conformance.DataplanePort(ctx, udp.ListenerPort)
						if err != nil {
							return err
						}
						if !found {
							return fmt.Errorf("the dataplane Service publishes no port %d", udp.ListenerPort)
						}
						return nil
					}).WithTimeout(3*time.Minute).WithPolling(5*time.Second).
						Should(Succeed(), "the environment's udp exposure")
				})

			It("K3 gives a port back when an exposure is removed, and takes one again when it returns",
				Label(devenv.TierP1, devenv.LabelFamily("K")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					ep, ok := env.Endpoint(portTCPName)
					Expect(ok).To(BeTrue(), "status published no %s endpoint (has %v)",
						portTCPName, env.EndpointNames())
					before := ep.ListenerPort
					owner := env.Namespace + "/" + env.Name + "-l4"

					// The port has to leave the ListenerSet as well as status: the
					// ListenerSet is the durable record of the reservation, and a
					// listener left behind would keep the number claimed in the pool
					// while nothing serves it.
					Expect(env.Patch(ctx, func(want *aiv1alpha1.DevEnvironment) {
						want.Spec.Ports = slices.DeleteFunc(want.Spec.Ports,
							func(p aiv1alpha1.PortSpec) bool { return p.Name == portTCPName })
					})).To(Succeed())

					Eventually(func() error {
						if _, _, err := env.L4Listener(ctx, portTCPName); err == nil {
							return fmt.Errorf("%s still declares a listener for the removed exposure",
								env.Name)
						}
						return nil
					}).WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(Succeed(), "the removed exposure's listener")

					Eventually(func() (bool, error) {
						if err := env.Refresh(ctx); err != nil {
							return false, err
						}
						_, ok := env.Endpoint(portTCPName)
						return ok, nil
					}).WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(BeFalse(), "status still publishes the removed exposure")

					// And it is out of the pool for this environment. Read
					// cluster-wide and not for the port alone: another environment
					// may have drawn it in the meantime, which is the pool working,
					// so what may not hold is that *this* environment still does.
					Eventually(func() (bool, error) {
						held, err := conformance.L4PortsHeld(ctx)
						if err != nil {
							return false, err
						}
						return slices.Contains(held[before], owner), nil
					}).WithTimeout(2*time.Minute).WithPolling(3*time.Second).
						Should(BeFalse(), "port %d is still held by %s after its exposure was removed",
							before, owner)

					// Put it back. The environment draws a port again — the same
					// one or another, which is the allocator's business; what may
					// not happen is a second listener for the same name, or none.
					Expect(env.Patch(ctx, func(want *aiv1alpha1.DevEnvironment) {
						want.Spec.Ports = append(want.Spec.Ports, aiv1alpha1.PortSpec{
							Name:          portTCPName,
							Type:          aiv1alpha1.PortTypeTCP,
							ContainerPort: devenv.ContainerSSHPort,
						})
					})).To(Succeed())

					Eventually(func() (int32, error) {
						if err := env.Refresh(ctx); err != nil {
							return 0, err
						}
						ep, ok := env.Endpoint(portTCPName)
						if !ok {
							return 0, fmt.Errorf("status has not published %s again", portTCPName)
						}
						return ep.ListenerPort, nil
					}).WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(BeNumerically(">=", cluster.L4Start), "the re-added exposure's port")

					// One listener per L4 exposure the spec declares — ssh, tcp,
					// udp. A stale listener from the removal would make it four, and
					// would be a reservation nothing answers on.
					ls, err := env.ListenerSet(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(ls.Spec.Listeners).To(HaveLen(3),
						"the environment declares %d L4 listeners for 3 exposures: %v",
						len(ls.Spec.Listeners), devenv.ListenerNames(ls))

					// And the invariant that makes the pool a pool, read
					// cluster-wide: every port any ListenerSet declares is declared
					// by exactly one. Two owners is a port one environment has
					// published an address to and cannot serve.
					held, err := conformance.L4PortsHeld(ctx)
					Expect(err).NotTo(HaveOccurred())
					for port, owners := range held {
						Expect(owners).To(HaveLen(1),
							"port %d is declared by %s, so neither can rely on serving it",
							port, strings.Join(owners, " and "))
					}
				})

			It("K4 keeps a drawn port across a reconcile, and the address follows the dataplane",
				Label(devenv.TierP1, devenv.LabelFamily("K")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					// The two numbers a published L4 endpoint carries are not the
					// same number, and the design says so: listenerPort is what the
					// Gateway listens on and the thing that must not move, while the
					// address names whatever the dataplane Service says that
					// listener is reached on — a NodePort dataplane renumbers and
					// every other kind leaves alone. Asking the Service is what makes
					// the assertion hold on both.
					held := map[string]int32{}
					for _, name := range []string{devenv.SSHEndpointName, portTCPName, portUDPName} {
						ep, ok := env.Endpoint(name)
						Expect(ok).To(BeTrue(), "status published no %s endpoint (has %v)",
							name, env.EndpointNames())
						held[name] = ep.ListenerPort

						external, found, err := conformance.DataplaneExternalPort(ctx, ep.ListenerPort)
						Expect(err).NotTo(HaveOccurred())
						Expect(found).To(BeTrue(),
							"%s names port %d and the dataplane Service does not carry it",
							name, ep.ListenerPort)
						got, err := addressPort(ep.Address)
						Expect(err).NotTo(HaveOccurred())
						Expect(got).To(Equal(external),
							"the address of %s names port %d where the dataplane serves %d",
							name, got, external)
					}

					// Now make the controller look again. A second http exposure is
					// the edit that does it without disturbing any of the above: it
					// changes the spec, so a new generation is written and a
					// reconcile follows, and it takes no pool port because it rides
					// the HTTP listener.
					Expect(env.Patch(ctx, func(want *aiv1alpha1.DevEnvironment) {
						want.Spec.Ports = append(want.Spec.Ports, aiv1alpha1.PortSpec{
							Name:          portHTTP2Name,
							Type:          aiv1alpha1.PortTypeHTTP,
							ContainerPort: portHTTP2Container,
						})
					})).To(Succeed())

					// The endpoint the edit adds is what only a reconcile after the
					// edit can write, so waiting for it is waiting for that
					// transition rather than for a state that already held.
					Eventually(func() (bool, error) {
						if err := env.Refresh(ctx); err != nil {
							return false, err
						}
						_, ok := env.Endpoint(portHTTP2Name)
						return ok, nil
					}).WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(BeTrue(), "the exposure the edit added is not published")

					now := map[string]int32{}
					for name := range held {
						ep, ok := env.Endpoint(name)
						Expect(ok).To(BeTrue(), "status dropped the %s endpoint", name)
						now[name] = ep.ListenerPort
					}
					Expect(now).To(Equal(held),
						"an L4 port moved while the environment was reconciled\nbefore: %v\nafter:  %v",
						held, now)
				})
		},
	}.declare()

	// K6 is the shape the four above are arranged not to be: an exposure naming a
	// container port the Service already publishes. The platform used to answer
	// such a spec by refusing the Service write outright, which — because
	// applyService errors before the reconcile writes status — left the
	// environment with no Service, no pod and no status at all. So the case is
	// about both halves of the fix: the environment converges, and the exposure
	// the user asked for is still published.
	//
	// This environment's repeat forwards to the container port it declares, which
	// is the fold that takes nothing from the user. It is reported on Accepted
	// rather than passed over, and the case asserts that too, because the other
	// kind of fold — into an entry that forwards somewhere else, which the ssh
	// bridge always does — is a spec the platform refuses to run at all
	// (::portCollisionFindings), and a case that read the Service alone could not
	// tell the two apart.
	draftCase{
		Name:     "ports-repeat",
		Image:    devenv.MustImage("jupyter-minimal"),
		Identity: devenv.NonRoot,
		Shape: func(want *aiv1alpha1.DevEnvironment) {
			want.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: portRepeatName, Type: aiv1alpha1.PortTypeHTTP, ContainerPort: devenv.ContainerJupyterPort},
			}
		},
		Cases: func(open func() *devenv.Environment) {
			It("K6 folds an exposure repeating the notebook's own port into the platform's entry",
				Label(devenv.TierP1, devenv.LabelFamily("K")), func(ctx SpecContext) {
					env := open()
					// Reaching Running is the assertion that the write was
					// accepted: the environment has a status at all, which is
					// exactly what the refused Service used to take away.
					running(ctx, env)

					// The fold is stated, not passed over: an environment that runs
					// with the controller's value says so, and names the entry.
					accepted := env.Condition(aiv1alpha1.ConditionAccepted)
					Expect(accepted).NotTo(BeNil(), "Accepted is not recorded")
					Expect(accepted.Status).To(Equal(metav1.ConditionTrue),
						"a folded exposure left Accepted=%s (%s)", accepted.Status, accepted.Reason)
					Expect(accepted.Reason).To(Equal(devenv.ReasonOverridden),
						"Accepted reads %q for a spec the controller resolved", accepted.Reason)
					Expect(accepted.Message).To(ContainSubstring("spec.ports[0]"),
						"the fold does not name the entry it is about: %s", accepted.Message)

					// The Service carries the notebook's port once — under the
					// platform's own name, not the exposure's — so the repeat is
					// folded in rather than written beside it.
					svc, err := env.Service(ctx)
					Expect(err).NotTo(HaveOccurred())
					var onNotebookPort int
					for _, p := range svc.Spec.Ports {
						if p.Port == devenv.ContainerJupyterPort {
							onNotebookPort++
						}
					}
					Expect(onNotebookPort).To(Equal(1),
						"the Service carries %d entries on the notebook's port %d (ports: %v)",
						onNotebookPort, devenv.ContainerJupyterPort, servicePortNames(svc))

					// And nothing was taken from the user: the exposure keeps a
					// route of its own, forwarding to the number it declared —
					// which is what makes folding the entry in honest rather than
					// silent.
					wantPath := fmt.Sprintf("/dev/%s/%s/port/%s/", env.Namespace, env.Name, portRepeatName)
					rules, err := env.HTTPRouteRules(ctx)
					Expect(err).NotTo(HaveOccurred())
					var rule *devenv.HTTPRouteRule
					for i := range rules {
						if rules[i].PathPrefix == wantPath {
							rule = &rules[i]
							break
						}
					}
					Expect(rule).NotTo(BeNil(),
						"the repeat lost its route (rules: %v)", rules)
					Expect(rule.BackendPort).To(Equal(int32(devenv.ContainerJupyterPort)),
						"the rule forwards to a port the exposure did not declare")
				})
		},
	}.declare()
}

// describePoolIsShared is K5.
//
// The claim is that the pool spans namespaces, and that is only visible while
// two environments in two of them hold ports at once. So the case makes the
// second one itself: it is the instrument rather than the subject, which is why
// it is created inside the case rather than declared beside it.
func describePoolIsShared() {
	const (
		envName = "ports-two-namespaces"
		peerEnv = "ports-peer"
	)

	// A function and not a constant, because conformance.Namespace is not known
	// until BeforeSuite has run and the spec tree is built before it.
	secondNS := func() string { return conformance.Namespace + "-second" }

	draftCase{
		Name:     envName,
		Image:    devenv.MustImage("jupyter-minimal"),
		Identity: devenv.NonRoot,
		Shape:    extraPorts,
		Cases: func(open func() *devenv.Environment) {
			It("K5 gives an environment in another namespace a different port",
				Label(devenv.TierP1, devenv.LabelFamily("K")), func(ctx SpecContext) {
					mine := open()
					running(ctx, mine)

					// The other half of the pair, in a namespace the first cannot
					// see: the same image and the catalogue's own manifest, so the
					// only thing it contributes is a second environment holding a
					// pool port somewhere else in the cluster.
					peer := conformance.DraftIn(secondNS(), peerEnv,
						devenv.MustImage("jupyter-minimal"), devenv.NonRoot)
					Expect(conformance.PrepareNamespace(ctx, secondNS())).To(Succeed())
					DeferCleanup(func() {
						cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
						defer cancel()
						// The namespace first: deleting it takes the environment
						// with it, and a DevEnvironment that is already gone is
						// nothing to complain about.
						if err := conformance.RemoveNamespace(cleanup, secondNS()); err != nil {
							_, _ = fmt.Fprintf(GinkgoWriter, "removing %s: %v\n", secondNS(), err)
						}
						if err := peer.TearDown(cleanup); err != nil {
							_, _ = fmt.Fprintf(GinkgoWriter, "deleting %s: %v\n", peer.Name, err)
						}
					})
					Expect(peer.Apply(ctx, nil)).To(Succeed())
					Eventually(func() error { return peer.Ready(ctx) }).
						WithTimeout(devenv.UpTimeout()).WithPolling(10*time.Second).
						Should(Succeed(), "the environment in %s", secondNS())

					// Every port either one holds, keyed by where it lives, so a
					// collision says which two are the same.
					drawn := func(env *devenv.Environment, names ...string) map[string]int32 {
						GinkgoHelper()
						Expect(env.Refresh(ctx)).To(Succeed())
						out := map[string]int32{}
						for _, n := range names {
							ep, ok := env.Endpoint(n)
							Expect(ok).To(BeTrue(), "%s published no %s endpoint (has %v)",
								env.Name, n, env.EndpointNames())
							out[env.Namespace+"/"+n] = ep.ListenerPort
						}
						return out
					}
					all := drawn(mine, devenv.SSHEndpointName, portTCPName, portUDPName)
					for k, v := range drawn(peer, devenv.SSHEndpointName) {
						all[k] = v
					}

					// The whole of the case: four exposures, four numbers. Both
					// environments are in one cluster and neither can see the
					// other's namespace, so a number drawn twice is a number two
					// environments have published an address to.
					seen := map[int32]string{}
					for name, port := range all {
						if other, taken := seen[port]; taken {
							Fail(fmt.Sprintf("%s and %s both drew L4 port %d", name, other, port))
						}
						seen[port] = name
					}

					// And the same reading taken from the cluster rather than from
					// the two statuses: each of those ports is declared by one
					// ListenerSet and one only.
					held, err := conformance.L4PortsHeld(ctx)
					Expect(err).NotTo(HaveOccurred())
					for name, port := range all {
						Expect(held[port]).To(HaveLen(1),
							"%s drew port %d, which %s declares",
							name, port, strings.Join(held[port], " and "))
					}

					// The two are served by different environments and not by one
					// address published twice: the peer's own sshd answers on its
					// own port, which is the key test K2 makes.
					ep, ok := peer.Endpoint(devenv.SSHEndpointName)
					Expect(ok).To(BeTrue())
					// The port the address publishes, and not the listener's:
					// where the dataplane renumbers a listener onto a nodePort the
					// two are different numbers, and dialing the listener's would
					// ask about a port nothing serves.
					target, err := hostPortOf(ep.Address)
					Expect(err).NotTo(HaveOccurred())
					want, err := peer.SSHHostKey(ctx)
					Expect(err).NotTo(HaveOccurred())
					presented, err := conformance.Dialer.SSHPresentedHostKey(ctx, target)
					Expect(err).NotTo(HaveOccurred(),
						"nothing answered on %s's ssh endpoint at %s", peer.Name, ep.Address)
					Expect(presented.Marshal()).To(Equal(want.Marshal()),
						"the second namespace's port answers with another environment's host key")
				})
		},
	}.declare()
}

// --- readers ------------------------------------------------------------------

// servicePortNames is the names on an environment's Service, which is what a
// route's backend can refer to.
func servicePortNames(svc *corev1.Service) []string {
	names := make([]string, 0, len(svc.Spec.Ports))
	for _, p := range svc.Spec.Ports {
		names = append(names, p.Name)
	}
	return names
}

// --- addresses ----------------------------------------------------------------

// addressScheme is the scheme an endpoint address carries, empty for the bare
// address a tcp or udp exposure is published as.
func addressScheme(address string) string {
	i := strings.Index(address, "://")
	if i < 0 {
		return ""
	}
	return address[:i]
}

// addressHost is the host an endpoint address names, whichever shape it has.
//
// The shapes are not the same thing and none of them is assembled here: a web
// or http exposure is a URL with a path, an ssh one a URL with a user, and a
// tcp or udp one a bare address because the client supplies the scheme its
// protocol needs.
func addressHost(address string) (string, error) {
	hostPort, err := hostPortOf(address)
	if err != nil {
		return "", err
	}
	host, _, err := net.SplitHostPort(hostPort)
	if err != nil {
		return "", fmt.Errorf("reading the host out of the endpoint address %q: %w", address, err)
	}
	return host, nil
}

// addressPort is the port an endpoint address names.
func addressPort(address string) (int32, error) {
	hostPort, err := hostPortOf(address)
	if err != nil {
		return 0, err
	}
	_, port, err := net.SplitHostPort(hostPort)
	if err != nil {
		return 0, fmt.Errorf("reading the port out of the endpoint address %q: %w", address, err)
	}
	n, err := strconv.Atoi(port)
	if err != nil {
		return 0, fmt.Errorf("the endpoint address %q names port %q: %w", address, port, err)
	}
	return int32(n), nil
}

// addressPath is the path an endpoint address is published under, empty for the
// bare address shape.
func addressPath(address string) (string, error) {
	if !strings.Contains(address, "://") {
		return "", nil
	}
	u, err := url.Parse(address)
	if err != nil {
		return "", fmt.Errorf("parsing the endpoint address %q: %w", address, err)
	}
	return u.Path, nil
}

// hostPortOf is the host:port part of an endpoint address, in any of its
// shapes.
func hostPortOf(address string) (string, error) {
	if !strings.Contains(address, "://") {
		return address, nil
	}
	u, err := url.Parse(address)
	if err != nil {
		return "", fmt.Errorf("parsing the endpoint address %q: %w", address, err)
	}
	if u.Host == "" {
		return "", fmt.Errorf("the endpoint address %q names no host", address)
	}
	return u.Host, nil
}
