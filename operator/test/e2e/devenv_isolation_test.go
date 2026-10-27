//go:build e2e
// +build e2e

package e2e

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/test/e2e/devenv"
)

// Family P: what the platform's default-deny NetworkPolicy actually denies
// (§9.1).
//
// Every other family reads what the platform says; this one asks the cluster's
// network whether it is true. The object is the controller's to render and the
// unit specs already hold it to its shape — what no unit spec can say is whether
// a CNI on this cluster enforces it, and that is the whole of the security
// promise: a policy that nothing enforces renders exactly like one that does.
//
// So the case is built to separate the two questions. It reads the rendered
// policy first — a controller that stopped rendering it fails here, in kind
// where a human can see it — and only then dials. And the dial includes a
// control: a pod in the same run namespace that the policy does not select. A
// probe that cannot reach the control is reporting its own harness, not the
// platform, and the case says so instead of calling it isolation.

// The probe's exit codes. They are the whole interface between the pod the case
// runs and the case that reads it: the script decides nothing about what the
// numbers mean.
const (
	probeIsolated           = 0 // the environment refused it, the control answered
	probeControlUnreachable = 1 // nothing to compare against
	probeNothingReachable   = 2 // the peer namespace could reach neither
	probeNotEnforced        = 3 // both answered, so the policy is not being enforced
)

func describeIsolation() {
	// A function and not a constant, because conformance.Namespace is not known
	// until BeforeSuite has run and the spec tree is built before it.
	peerNamespace := func() string { return conformance.Namespace + "-peer" }

	draftCase{
		Name:     "network-isolation",
		Image:    devenv.MustImage("cpu-pytorch-jupyter"),
		Identity: devenv.NonRoot,
		Shape: func(want *aiv1alpha1.DevEnvironment) {
			// The published web endpoint is the only ingress this case needs, and
			// ssh would only add an L4 port the case never dials.
			want.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: false}
		},
		Cases: func(open func() *devenv.Environment) {
			It("P1 refuses a connection from another namespace, and admits the Gateway",
				Label(devenv.TierP1, devenv.LabelShard(devenv.ShardP2), devenv.LabelFamily("P")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					pod, err := env.Pod(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(pod.Status.PodIP).NotTo(BeEmpty(), "%s has no pod IP", pod.Name)

					// What the platform rendered, before asking the CNI what it
					// does with it. This is what makes the skip below honest: a
					// cluster whose network does not enforce policies and a
					// controller that no longer writes one would otherwise produce
					// the same observation, and only one of them is a platform
					// finding.
					var policy networkingv1.NetworkPolicy
					Expect(conformance.Client.Get(ctx,
						client.ObjectKey{Namespace: env.Namespace, Name: env.Name}, &policy)).To(Succeed(),
						"%s carries no NetworkPolicy, so its isolation is nonexistent and not merely unenforced",
						env.Name)
					Expect(policy.Spec.PolicyTypes).To(ConsistOf(
						networkingv1.PolicyTypeIngress, networkingv1.PolicyTypeEgress),
						"the policy types on %s", env.Name)

					// Ingress admits exactly one peer: the Gateway's dataplane, in
					// the namespace the manager was configured with. The pod
					// selector inside it is asserted non-empty rather than read
					// label by label — which pods serve the Gateway is Envoy
					// Gateway's to name, and an empty selector would admit the
					// whole dataplane namespace instead of one Gateway's proxies.
					Expect(policy.Spec.Ingress).To(HaveLen(1),
						"%s admits %d ingress rules; the default is no ingress widened by one",
						env.Name, len(policy.Spec.Ingress))
					Expect(policy.Spec.Ingress[0].From).To(HaveLen(1),
						"%s admits %d ingress peers", env.Name, len(policy.Spec.Ingress[0].From))
					peer := policy.Spec.Ingress[0].From[0]
					Expect(peer.NamespaceSelector).NotTo(BeNil())
					Expect(peer.PodSelector).NotTo(BeNil())
					nsSelector, err := metav1.LabelSelectorAsSelector(peer.NamespaceSelector)
					Expect(err).NotTo(HaveOccurred())
					Expect(nsSelector.Matches(labels.Set{
						corev1.LabelMetadataName: cluster.DataplaneNamespace,
					})).To(BeTrue(),
						"the admitted peer is not in the dataplane namespace %s the manager was configured with",
						cluster.DataplaneNamespace)
					podSelector, err := metav1.LabelSelectorAsSelector(peer.PodSelector)
					Expect(err).NotTo(HaveOccurred())
					Expect(podSelector.Empty()).To(BeFalse(),
						"the admitted peer selects every pod in %s, not the Gateway's",
						cluster.DataplaneNamespace)

					// And the policy is about this environment rather than about
					// the namespace: its own pod has to match the selector, or
					// nothing above applies to anything.
					selected, err := metav1.LabelSelectorAsSelector(&policy.Spec.PodSelector)
					Expect(err).NotTo(HaveOccurred())
					Expect(selected.Matches(labels.Set(pod.Labels))).To(BeTrue(),
						"the policy does not select the environment's own pod (%v)", pod.Labels)
					Expect(policy.Spec.Egress).NotTo(BeEmpty(),
						"egress is default-deny with a DNS allowance, and an empty rule list refuses the "+
							"lookups an environment needs to start")

					// The peer namespace, made here because the case is the only
					// thing that wants it. Its default ServiceAccount carries the
					// pull credential, so the probe pod can run the environment's
					// own image without a second pull the node has to serve.
					peerNS := peerNamespace()
					Expect(conformance.PrepareNamespace(ctx, peerNS)).To(Succeed())
					DeferCleanup(func() {
						cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
						defer cancel()
						// The namespace takes the probe pod with it.
						if err := conformance.RemoveNamespace(cleanup, peerNS); err != nil {
							_, _ = fmt.Fprintf(GinkgoWriter, "removing %s: %v\n", peerNS, err)
						}
					})

					// The control: a server in the run namespace that the
					// environment's policy does not select. Reaching it from the
					// peer namespace proves the peer can make the trip at all, so
					// a refusal of the environment is the policy and not the route.
					const controlPort = 8000
					control, err := conformance.RunServer(ctx, conformance.Namespace,
						env.Object().Spec.Image,
						[]string{"python3", "-m", "http.server", strconv.Itoa(controlPort), "--bind", "0.0.0.0"},
						controlPort, 3*time.Minute)
					Expect(err).NotTo(HaveOccurred(), "the control server in %s", conformance.Namespace)
					DeferCleanup(func() {
						cleanup, cancel := context.WithTimeout(context.Background(), time.Minute)
						defer cancel()
						_ = conformance.Client.Delete(cleanup, control, client.GracePeriodSeconds(0))
					})
					Expect(control.Status.PodIP).NotTo(BeEmpty(), "%s has no pod IP", control.Name)
					controlLabels := labels.Set(control.Labels)
					Expect(selected.Matches(controlLabels)).To(BeFalse(),
						"the environment's policy selects the control pod too (%v), so it is not a control",
						control.Labels)

					// The probe, from the other namespace, dialing both on the
					// port each one serves.
					code, message, err := conformance.RunToCompletion(ctx, peerNS, env.Object().Spec.Image,
						[]string{"python3", "-c", fmt.Sprintf(isolationProbe,
							control.Status.PodIP, controlPort,
							pod.Status.PodIP, devenv.ContainerJupyterPort,
							probeIsolated, probeControlUnreachable, probeNotEnforced, probeNothingReachable)},
						4*time.Minute)
					Expect(err).NotTo(HaveOccurred(), "the probe pod in %s", peerNS)
					// The pod the probe dialed has to be the one that is still
					// there: a replacement between reading its address and using
					// it leaves the probe knocking on an address nothing holds,
					// which reads exactly like a policy that refused it.
					nowUID, err := env.PodUID(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(nowUID).To(Equal(pod.UID),
						"the environment's pod was replaced while the probe was running")
					detail := ""
					if message != "" {
						detail = " (" + message + ")"
					}

					switch code {
					case probeIsolated:
						// The promise. Nothing left to say about it here; the
						// positive control below is what keeps it from being a
						// policy that refuses everything.
					case probeNotEnforced:
						Skip(fmt.Sprintf("the environment's NetworkPolicy is rendered correctly but this "+
							"cluster's CNI does not enforce it: a pod in %s reached both the environment "+
							"and the unselected control%s", peerNS, detail))
					case probeControlUnreachable:
						Fail(fmt.Sprintf("the probe could not reach the control pod in %s, so it says "+
							"nothing about the environment%s; the peer namespace has no connectivity "+
							"to prove isolation with", conformance.Namespace, detail))
					case probeNothingReachable:
						Fail(fmt.Sprintf("the peer namespace reached neither the environment nor the "+
							"control%s, so the environment's refusal cannot be attributed to its "+
							"policy", detail))
					default:
						Fail(fmt.Sprintf("the probe exited %d, which no branch of it produces%s", code, detail))
					}

					// The other half of default-deny: the one ingress the policy
					// does admit still works. Without it an environment reachable
					// by nobody would pass every assertion above.
					ep, ok := env.WebEndpoint()
					Expect(ok).To(BeTrue(), "status published no web endpoint (has %v)", env.EndpointNames())
					token, err := env.JupyterToken(ctx)
					Expect(err).NotTo(HaveOccurred())
					base, err := withTrailingSlash(ep.Address)
					Expect(err).NotTo(HaveOccurred())
					status, body, err := get(ctx, conformance.Dialer.HTTPClient(), base+"api/status?token="+token)
					Expect(err).NotTo(HaveOccurred())
					Expect(status).To(Equal(http.StatusOK),
						"the Gateway could not reach the environment it is the one admitted peer of: %d %s",
						status, truncate(body))
				})
		},
	}.declare()
}

// isolationProbe is the probe pod's whole command.
//
// The control is dialed first, so that a peer namespace which can reach nothing
// at all costs one timeout rather than two and produces the code that says the
// probe is unusable. Three attempts, because the environment may still be
// settling its Service but the control is ready before the pod is created — and
// because a refusal by policy is a timeout rather than an immediate error, which
// is why the attempts are bounded by time rather than by success.
//
// The placeholders are, in order: the control's IP and port, the environment
// pod's IP and container port, then the four exit codes above.
const isolationProbe = `
import socket, sys, time

def reach(host, port):
    for _ in range(3):
        try:
            socket.create_connection((host, port), timeout=2).close()
            return True
        except OSError:
            pass
        time.sleep(2)
    return False

control = reach("%s", %d)
environment = reach("%s", %d)
if control and not environment:
    code = %d
elif not control and environment:
    code = %d
elif control:
    code = %d
else:
    code = %d
message = "environment reachable=" + str(environment) + ", control reachable=" + str(control)
with open("/dev/termination-log", "w") as f:
    f.write(message)
sys.exit(code)
`
