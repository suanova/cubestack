//go:build e2e
// +build e2e

package e2e

import (
	"fmt"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/test/e2e/devenv"
)

// Family L: what an edit does to a running workload (§4.L).
//
// Both directions are asserted here rather than one being left to the absence
// of the other, because they are the two ways a platform gets this wrong and
// only one of them is loud: a workload that never rolls serves the spec it was
// created with while every object in front of it describes the new one, and a
// workload that rolls on everything turns a route edit into an outage. The
// first is a bug nobody reports until they hit it, and the second is a bug
// everybody reports.
//
// L3 (rotating an authorized key does not roll) and L4 (a host key sshd cannot
// read does roll) are not repeated here: they are I2 and I3, asserted on an
// environment whose keys are delegated, which is the only shape in which
// "rotate" is a thing a user does. What is left for this family is the pair of
// spec fields that drive the template directly.

// rollProbePortName is the exposure L5 adds to a running environment. Named for
// what it is rather than "probe-tcp": the endpoint name is published to the user
// as the port's identity, so it is also what the case looks the port up by.
const rollProbePortName = "roll-probe-tcp"

func describeRoll() {
	draftCase{
		Name:     "roll-edits",
		Image:    devenv.MustImage("jupyter-minimal"),
		Identity: devenv.NonRoot,
		Cases: func(open func() *devenv.Environment) {
			It("L1 rolls the workload onto the image a spec edit names",
				Label(devenv.TierP1, devenv.LabelFamily("L")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					before, err := env.PodUID(ctx)
					Expect(err).NotTo(HaveOccurred())

					// The instrument: the same artifact, named the other way. The
					// manifest asks for a tag and the node ran that tag resolved to a
					// digest, so pinning the spec to the digest changes nothing about
					// what the pod runs — no layer, no binary, no entrypoint. The one
					// thing that moves is the string the controller hashes, which is
					// what makes a roll here a finding about the platform rather than
					// about the image.
					pulled, err := env.PulledImageID(ctx)
					Expect(err).NotTo(HaveOccurred())
					pinned, err := pinnedRef(env.Image.Ref(), pulled)
					Expect(err).NotTo(HaveOccurred(),
						"the digest the kubelet recorded cannot stand in for the reference the spec asks for")

					Expect(env.Patch(ctx, func(want *aiv1alpha1.DevEnvironment) {
						want.Spec.Image = pinned
					})).To(Succeed())

					rolled(ctx, env, before)

					// And the workload is on the image the edit named, which is the
					// claim the roll exists to make true. The uid alone would be
					// satisfied by a replacement that came back on the old template.
					//
					// Compared by digest rather than as the whole reference: how a
					// runtime writes an image id is its own convention — containerd
					// drops the tag a digest-pinned pull does not need — and a case
					// that pinned the spelling would report a runtime's formatting as
					// a platform finding.
					ran, err := env.PulledImageID(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(imageDigest(ran)).To(Equal(imageDigest(pinned)),
						"the spec names %s and the pod is running %s", pinned, ran)
				})

			It("L2 rolls the workload when the runtime environment changes, and the new variable reaches it",
				Label(devenv.TierP1, devenv.LabelFamily("L")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					before, err := env.PodUID(ctx)
					Expect(err).NotTo(HaveOccurred())

					// A container's environment is fixed at creation — there is no
					// way to add one to a running container — so the only way this
					// edit can take effect is a new pod. That is what makes it a
					// case about the template rather than about the API: the value
					// is not something the controller could apply any other way.
					Expect(env.Patch(ctx, func(want *aiv1alpha1.DevEnvironment) {
						want.Spec.Runtime.Env = append(want.Spec.Runtime.Env,
							corev1.EnvVar{Name: rollEnvName, Value: rollEnvValue})
					})).To(Succeed())

					rolled(ctx, env, before)

					pod, err := env.Pod(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(containerEnv(pod)).To(HaveKeyWithValue(rollEnvName, rollEnvValue),
						"the pod the edit brought up does not carry the variable it added")
				})

			It("L5 adds an exposure to a running environment without restarting it, and it serves",
				Label(devenv.TierP1, devenv.LabelFamily("L")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					before, err := env.PodUID(ctx)
					Expect(err).NotTo(HaveOccurred())

					// A tcp exposure of the environment's own sshd, so the added
					// port has something behind it that already answers and the case
					// can be asserted end to end rather than structurally. It draws
					// from the L4 pool, which is the kind of edit most likely to be
					// mistaken for a workload change.
					//
					// The other direction of the same rule is RDMA: a host-network
					// pod takes its ports from the node, so spec.ports is in the
					// template there and an edit has to roll — an InfiniBand
					// environment is not this case and would fail it.
					Expect(env.Patch(ctx, func(want *aiv1alpha1.DevEnvironment) {
						want.Spec.Ports = append(want.Spec.Ports, aiv1alpha1.PortSpec{
							Name:          rollProbePortName,
							Type:          aiv1alpha1.PortTypeTCP,
							ContainerPort: devenv.ContainerSSHPort,
						})
					})).To(Succeed())

					// The transition first, because it is what only a reconcile
					// after the edit writes — and because the absence of a roll is
					// only meaningful once the controller has acted. A Consistently
					// started before the edit was reconciled would sample an
					// environment the controller had not yet looked at, which is
					// the state the assertion is not about.
					var ep aiv1alpha1.Endpoint
					Eventually(func() (bool, error) {
						if err := env.Refresh(ctx); err != nil {
							return false, err
						}
						var ok bool
						ep, ok = env.Endpoint(rollProbePortName)
						return ok, nil
					}).WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(BeTrue(), "the exposure the edit added is not published")

					Expect(ep.ListenerPort).To(BeNumerically(">=", cluster.L4Start),
						"the added exposure was published outside the pool %d-%d",
						cluster.L4Start, cluster.L4End)

					// Nothing about a route is in the pod template, so nothing about
					// this edit is: the workload that was running when the exposure
					// was added is the workload serving it now.
					//
					// A string rather than the error-returning form, because
					// Consistently fails on the first sample that errs where
					// Eventually retries: a pod that went away mid-window would be
					// reported as a read failure rather than as the roll it is, and
					// it is the roll this case is about.
					Consistently(func() string {
						uid, err := env.PodUID(ctx)
						if err != nil {
							return "no pod: " + err.Error()
						}
						return string(uid)
					}).WithTimeout(30*time.Second).WithPolling(3*time.Second).
						Should(Equal(string(before)),
							"adding an exposure restarted the environment")

					// And it serves. The handshake is against the host key the
					// platform minted for this environment, which is the strong form
					// of "the added port leads here": the pool port, the listener,
					// the route, the Service entry and the container are all on the
					// path between the address a user was handed and that key.
					want, err := env.SSHHostKey(ctx)
					Expect(err).NotTo(HaveOccurred())
					presented, err := conformance.Dialer.SSHPresentedHostKey(ctx, ep.Address)
					Expect(err).NotTo(HaveOccurred(),
						"nothing answered an ssh handshake on the exposed address %s", ep.Address)
					Expect(presented.Marshal()).To(Equal(want.Marshal()),
						"the exposure added to a running environment reaches another server")
				})
		},
	}.declare()
}

// The variable L2 adds, named once because both the edit and the assertion
// name it and a mismatch between them would assert the wrong thing.
const (
	rollEnvName  = "E2E_ROLL_PROBE"
	rollEnvValue = "added-while-running"
)

// rolled waits for the environment to come back on a pod other than the one it
// was running, which is what a template change is as a user sees it.
//
// Two claims, waited on in that order and not the other way round. The roll is
// the transition — the uid is a value only a replacement writes — so waiting on
// it is waiting for the thing under test. Waiting on Ready first would pass on
// the state that already held: the environment is Ready right up until the
// controller acts, which is exactly why a roll is worth asserting separately
// from health.
//
// The pod is then required to be running behind the conditions, because a
// condition outlives the pod it describes: a new pod still pulling its image is
// Ready by a status written for the pod that has just gone, and a replacement
// that never comes up is a worse outcome than no replacement at all.
func rolled(ctx SpecContext, env *devenv.Environment, before types.UID) {
	GinkgoHelper()

	Eventually(func() (types.UID, error) { return env.PodUID(ctx) }).
		WithTimeout(devenv.UpTimeout()).WithPolling(5*time.Second).
		ShouldNot(Equal(before), "the edit did not replace the workload")

	Eventually(func() error {
		if err := env.PodRunning(ctx); err != nil {
			return err
		}
		return env.Ready(ctx)
	}).WithTimeout(devenv.UpTimeout()).WithPolling(5*time.Second).
		Should(Succeed(), "the environment did not come back after the edit")

	after, err := env.PodUID(ctx)
	Expect(err).NotTo(HaveOccurred())
	Expect(after).NotTo(Equal(before),
		"the workload running now is the one the edit was supposed to replace")
}

// pinnedRef turns the image id the kubelet recorded into a reference a spec can
// name.
//
// Both are the same artifact: the manifest asks for a tag and the node ran that
// tag resolved to a digest. It is checked rather than assumed, because the
// rewrite is only an instrument while the two agree — a repository that resolved
// to somewhere else would make L1 a case about a second image, and it would fail
// as a pull error rather than as the mismatch it is. The reference is taken as
// the kubelet wrote it, tag and all if it carries one: that is a valid
// reference, and reconstructing a tidier one would be this case asserting its own
// arithmetic about the runtime's naming.
func pinnedRef(asked, pulled string) (string, error) {
	repo, digest, ok := strings.Cut(pulled, "@")
	if !ok || !strings.HasPrefix(digest, "sha256:") {
		return "", fmt.Errorf("the kubelet recorded %q, which is not a digest-pinned reference", pulled)
	}
	if withoutTag(repo) != withoutTag(asked) {
		return "", fmt.Errorf("the spec asks for %s and the node pulled %s", asked, repo)
	}
	return pulled, nil
}

// imageDigest is the digest part of an image reference, empty when it has none.
func imageDigest(ref string) string {
	_, digest, _ := strings.Cut(ref, "@")
	return digest
}

// withoutTag drops a reference's tag, leaving a host:port and the repository
// intact. The tag is what follows the last colon that is not part of a
// host:port, which is the last colon after the last slash.
func withoutTag(ref string) string {
	if i := strings.LastIndex(ref, ":"); i > strings.LastIndex(ref, "/") {
		return ref[:i]
	}
	return ref
}
