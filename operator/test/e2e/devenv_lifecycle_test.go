//go:build e2e
// +build e2e

package e2e

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/test/e2e/devenv"
)

// Family G: the lifecycle state machine (§4.G).
//
// Every other family reads an environment standing still. These drive one
// through the states a user drives it through — stopped, started, deleted — and
// assert what the platform does on the way, because that is where an environment
// can be left in a state nobody asked for: a pod still running behind a Stopped
// phase, a port still reserved for something that is gone, a workspace quietly
// thrown away with the claim that held it.
//
// The cases here do not ride the matrix. A matrix environment is shared by five
// families declared around it, and one that is stopped, restarted and deleted
// underneath them would make every other case's result depend on this family's
// running order. So each group here brings up its own environment — on the
// cheapest image, which for these questions is representative: stopping is the
// platform's, and a bare `ssh-ubuntu22.04` is the environment with the least in
// it to confuse the answer. G8 is the one exception, and brings up a notebook
// because the type is the whole of what it asks about.

// holdFinalizer is a finalizer this suite adds to an environment it is about to
// delete.
//
// The controller already holds an environment with its own finalizer while it
// withdraws what the environment published — that is what makes the withdrawal
// observable at all — but nothing widens that window to the length of a poll,
// and a Terminating phase that lasted a few hundred milliseconds would make the
// case that reads it a race against the controller rather than an assertion
// about it. This holds the object open for as long as the case needs, and the
// case removes it again; Ginkgo's DeferCleanup covers the path where the case
// dies in between, so a failed assertion cannot leave an object behind.
const holdFinalizer = "e2e.cubestack.io/hold"

func describeLifecycle() {
	describeStopStart()
	describeHttpStop()
	describeDeletion()
	describeRetention()
}

// describeStopStart is G1–G4, on one environment and three stop/start cycles.
//
// The chain is deliberate: G1 watches a start, G2 a stop, G3 what a stop takes
// back and what it keeps, and G4 the start that lands back on the port G3 left
// reserved. Each case re-establishes the state it needs rather than trusting the
// one before it — G2 leaves the environment stopped and G3 starts it again —
// and a failure in one shows up as the rest of the container being skipped,
// Ginkgo's Ordered, rather than as three cases reporting the same fault.
func describeStopStart() {
	draftCase{
		Name:     "lifecycle-stop-start",
		Image:    devenv.MustImage("ssh-ubuntu22.04"),
		Identity: devenv.NonRoot,
		Cases: func(open func() *devenv.Environment) {
			It("G1 keeps the phase and the conditions in agreement while the environment starts",
				Label(devenv.TierP1, devenv.LabelFamily("G")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					// The pod the environment is on now, which is what a start has to
					// change — the phase cannot say it. A stop moves the replicas the
					// platform wants and nothing else, and the pod it is deleting goes on
					// satisfying Running and Ready for as long as its grace period lasts
					// (measured on cs3: StatefulSet replicas 0, the pod carrying a
					// deletionTimestamp 30s out, status still phase Running with every
					// condition true and its endpoint still published). A sample read in
					// that window is indistinguishable from a healthy environment, so a
					// case that keyed on the phase alone would be reading the state the
					// stop left behind. A StatefulSet recreates the pod under the same
					// name, so the uid is the one thing a restart moves.
					before, err := env.PodUID(ctx)
					Expect(err).NotTo(HaveOccurred())

					// The transition this case watches is one it caused. BeforeAll
					// created the environment and it is Running by the time any case
					// here runs, and a transition nobody watched is not an assertion —
					// so the case stops it, waits for the stop, and samples the start.
					Expect(env.SetRunning(ctx, false)).To(Succeed())
					stopped(ctx, env)
					Expect(env.SetRunning(ctx, true)).To(Succeed())

					// A poll of its own rather than an Eventually: the subject is an
					// invariant that has to hold at *every* sample, and a matcher
					// inside an Eventually's function is retried instead of reported.
					//
					// It ends on the environment Running again on a pod other than the
					// one it stopped on, so the samples span the whole restart: the
					// phase reads Stopped, then whatever the pod on its way out makes it
					// read, then Pending while the replacement comes up. That is what
					// keeps this from being an assertion about an environment that was
					// simply left running, and it is a stronger guard than counting the
					// samples that were not Running — which an environment whose pod is
					// still terminating never produces at all.
					deadline := time.Now().Add(devenv.UpTimeout())
					var samples int
					var last string
					for {
						Expect(env.Refresh(ctx)).To(Succeed())
						st := env.Object().Status
						samples++
						if st.Phase != nil {
							last = fmt.Sprintf("%s (%s)", st.Phase.Name, st.Phase.Reason)
						}
						Expect(phaseAgreement(st)).To(Succeed(),
							"sample %d of the start, with the environment at %s", samples, last)
						back, err := onAnotherPod(ctx, env, before)
						Expect(err).NotTo(HaveOccurred())
						if st.Phase != nil && st.Phase.Name == aiv1alpha1.PhaseRunning && back {
							break
						}
						if time.Now().After(deadline) {
							Fail(fmt.Sprintf("%s never came back on another pod within %s; "+
								"the last sample found it at %s", env.Name, devenv.UpTimeout(), last))
						}
						select {
						case <-ctx.Done():
							Fail("the spec's deadline passed before the environment came back up")
						case <-time.After(time.Second):
						}
					}

					// And the end of it is a usable environment, not merely a phase.
					running(ctx, env)

					// A marker in the workspace, which G4 reads back. It has to be
					// written before the stop and the stop is G2's, so it is left here.
					sshOutput(ctx, env, `printf '%s' `+workspaceMarker+` > "$HOME/`+workspaceMarkerFile+`"`)
				})

			It("G2 stops to a gone workload and a Stopped phase",
				Label(devenv.TierP1, devenv.LabelFamily("G")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					Expect(env.SetRunning(ctx, false)).To(Succeed())
					stopped(ctx, env)

					// The reason, not only the phase: a stop the platform performed and
					// a failure that happened to leave the same phase name are
					// different findings, and this is what tells them apart on the
					// condition a user reads.
					ready := env.Condition(aiv1alpha1.ConditionReady)
					Expect(ready).NotTo(BeNil(), "Ready is not recorded")
					Expect(ready.Status).To(Equal(metav1.ConditionFalse))
					Expect(ready.Reason).To(Equal(devenv.ReasonStopped),
						"the environment reports Ready=False as %q, and a stop is meant to read %q",
						ready.Reason, devenv.ReasonStopped)

					// The workload, and not the phase. A Stopped phase over a pod
					// that is still running is a workspace the platform says it has
					// released and has not.
					Eventually(func() ([]corev1.Pod, error) { return env.Pods(ctx) }).
						WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(BeEmpty(), "pods still running behind a Stopped phase")
				})

			It("G3 withdraws the stopped environment's address and keeps its port reserved",
				Label(devenv.TierP1, devenv.LabelFamily("G")), func(ctx SpecContext) {
					env := open()

					// G2 left it stopped, and a case about what a stop takes back
					// starts from what the stop had to take: the address it published,
					// and a session open on it. Both are read here, while it is up —
					// read after the stop there would be no address to have seen
					// published and no session left to ask.
					Expect(env.SetRunning(ctx, true)).To(Succeed())
					running(ctx, env)

					ep, ok := env.SSHEndpoint()
					Expect(ok).To(BeTrue(), "status published no ssh endpoint (has %v)", env.EndpointNames())
					sess, err := env.Open(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(sess.Ping(ctx)).To(Succeed(),
						"the environment does not answer on its own published address before the stop")

					Expect(env.SetRunning(ctx, false)).To(Succeed())
					stopped(ctx, env)

					// The address goes. status.endpoints is what the platform tells a
					// user to connect to, and a stopped environment serves nothing, so
					// publishing it anyway would hand out an address that answers
					// nowhere.
					//
					// The withdrawal is the platform's and belongs to the phase, not
					// to this exposure's route — but for this exposure the two are
					// still visible together, and it is worth saying which is which: a
					// stopped environment's L4 route has no ready endpoints behind it,
					// so the gateway refuses it and RouteReady reads false here as
					// well. An HTTP environment has no such route to be refused and
					// keeps its RouteReady; G8 is this same contract on that type,
					// where nothing but the platform can take the address away.
					//
					// This is the withdrawal a *stop* performs, and it is narrower
					// than the one a spec change performs: turning an exposure off
					// (I4) also deletes the ListenerSet and lets the port go, where a
					// stop keeps both, below.
					Eventually(func() []string {
						_ = env.Refresh(ctx)
						return env.EndpointNames()
					}).WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(BeEmpty(), "a stopped environment still publishes an address")

					// The port does not go. The ListenerSet is the durable record of
					// which pool port the environment holds — the object K3 asserts
					// the other half of the reservation on — so the number is still
					// declared and still drawn from the pool, and G4 starts onto it
					// rather than onto one allocated afresh.
					entry, _, err := env.L4Listener(ctx, devenv.SSHEndpointName)
					Expect(err).NotTo(HaveOccurred())
					Expect(entry.Port).To(Equal(ep.ListenerPort),
						"the stopped environment's port moved from %d to %d", ep.ListenerPort, entry.Port)
					held, err := conformance.L4PortsHeld(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(held).To(HaveKey(ep.ListenerPort),
						"port %d left the pool when the environment stopped, so anything starting next "+
							"draws another number", ep.ListenerPort)

					// And what the stop changes for a user: nothing is behind the
					// address any more. A reservation is only defensible while what
					// it leads to refuses.
					Expect(sess.Ping(ctx)).To(HaveOccurred(),
						"a stopped environment answered ssh on %s", sess.Addr())
				})

			It("G4 starts again on the port it held, with the workspace intact",
				Label(devenv.TierP1, devenv.LabelFamily("G")), func(ctx SpecContext) {
					env := open()
					stopped(ctx, env)

					// The port the stop left reserved, read from the ListenerSet
					// rather than carried over from the case before: the claim is
					// about this environment, and the object the allocation lives in
					// is where the answer has to come from.
					reserved, _, err := env.L4Listener(ctx, devenv.SSHEndpointName)
					Expect(err).NotTo(HaveOccurred())

					// The pods the stop left behind, which the start has to replace.
					// Read here rather than carried over from the case before, because
					// it is the one moment this case can see them: the pod a stop is
					// deleting goes on reading as a healthy environment until its grace
					// period runs out, so a wait for "Running" that did not exclude it
					// would be satisfied by the environment the stop just took away —
					// and the ssh below would be aimed at a container on its way out.
					was, err := env.PodUIDs(ctx)
					Expect(err).NotTo(HaveOccurred())

					Expect(env.SetRunning(ctx, true)).To(Succeed())
					runningOn(ctx, env, was...)

					// And it came back onto that number. A restart that drew a fresh
					// port would make every stop an address to read out again, which
					// is the whole of what the reservation is for.
					ep, ok := env.SSHEndpoint()
					Expect(ok).To(BeTrue(), "status published no ssh endpoint (has %v)", env.EndpointNames())
					Expect(ep.ListenerPort).To(Equal(reserved.Port),
						"the environment came back on port %d, having held %d while it was stopped",
						ep.ListenerPort, reserved.Port)

					// Same workspace, proven by content and not by path: the mount
					// path would be the same even if the platform had provisioned a
					// fresh, empty claim behind it.
					Expect(strings.TrimSpace(sshOutput(ctx, env, `cat "$HOME/`+workspaceMarkerFile+`"`))).
						To(Equal(workspaceMarker),
							"the file the environment wrote before it was stopped is gone, so the "+
								"workspace did not survive the stop")
				})
		},
	}.declare()
}

// describeHttpStop is G8: the address of a stopped environment whose exposure is
// the HTTP route.
//
// G3 states this contract on an ssh environment, where a second thing happens
// with it: the workload is gone, so the L4 route has no ready endpoints behind
// it, the gateway refuses it, and the platform withdraws the address. An HTTP
// environment has no L4 route to be refused, so the same stop would leave its
// address published and routing to a 503 — the platform handing a user an
// address that answers nowhere, which is the whole of what the contract is for.
//
// Which is why the environment here has no ssh exposure, even though the
// catalogue would give a notebook one: with it, the refusal G3 is about would
// take this environment's address away too, and the case would pass on an
// implementation that withdraws nothing.
func describeHttpStop() {
	draftCase{
		Name:     "lifecycle-stop-http",
		Image:    devenv.MustImage("jupyter-minimal"),
		Identity: devenv.NonRoot,
		Shape: func(env *aiv1alpha1.DevEnvironment) {
			// The HTTP route alone, so that the address can only go because the
			// platform withheld it.
			env.Spec.SSH = nil
		},
		Cases: func(open func() *devenv.Environment) {
			It("G8 withdraws the address of a stopped environment whose only route is HTTP",
				Label(devenv.TierP1, devenv.LabelFamily("G")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					// What the stop has to take: the address it published and a
					// notebook answering on it. Both are read while it is up — read
					// after the stop there is no address to have seen published.
					ep, ok := env.WebEndpoint()
					Expect(ok).To(BeTrue(), "status published no %q endpoint (has %v)",
						env.Image.Type, env.EndpointNames())
					base, err := withTrailingSlash(ep.Address)
					Expect(err).NotTo(HaveOccurred())
					token, err := env.JupyterToken(ctx)
					Expect(err).NotTo(HaveOccurred())
					client := conformance.Dialer.HTTPClient()
					Eventually(func() int {
						code, _, _ := get(ctx, client, base+"api/status?token="+token)
						return code
					}).WithTimeout(3*time.Minute).WithPolling(5*time.Second).
						Should(Equal(http.StatusOK),
							"api/status on the environment's own published address %s before the stop", base)

					Expect(env.SetRunning(ctx, false)).To(Succeed())
					stopped(ctx, env)

					// The address goes. Same contract as G3's, and reached by a
					// different route to it: nothing but the platform is here to take
					// it away.
					Eventually(func() []string {
						_ = env.Refresh(ctx)
						return env.EndpointNames()
					}).WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(BeEmpty(), "a stopped environment still publishes an address")

					// And what is withheld is the address and not the exposure: the
					// HTTP route is still published and still accepted, so RouteReady
					// stays true. A false here would report a publication that failed,
					// which is a different finding from an address withheld — and the
					// difference in this condition is the whole of why the SSH case's
					// address going away proves nothing about this one.
					routeReady := env.Condition(aiv1alpha1.ConditionRouteReady)
					Expect(routeReady).NotTo(BeNil(), "RouteReady is not recorded")
					Expect(routeReady.Status).To(Equal(metav1.ConditionTrue),
						"the stopped environment's route reads %s (%s)",
						routeReady.Status, routeReady.Reason)

					// The start gives the address back, answering. Withheld is a
					// statement about the phase, and not a withdrawal the next start
					// has to earn back from something the stop took away: the route
					// and the ListenerSet were kept, and the address is recomputed
					// from them.
					Expect(env.SetRunning(ctx, true)).To(Succeed())
					running(ctx, env)
					back, ok := env.WebEndpoint()
					Expect(ok).To(BeTrue(), "status published no %q endpoint after the restart (has %v)",
						env.Image.Type, env.EndpointNames())
					Expect(back.Address).To(Equal(ep.Address),
						"the environment came back at %s, having published %s before it stopped",
						back.Address, ep.Address)
					Eventually(func() int {
						code, _, _ := get(ctx, client, base+"api/status?token="+token)
						return code
					}).WithTimeout(3*time.Minute).WithPolling(5*time.Second).
						Should(Equal(http.StatusOK),
							"api/status on %s with the token it published before the stop", base)
				})
		},
	}.declare()
}

// describeDeletion is G5 and the delete half of G6: what a deleted environment
// takes with it, and what it leaves.
func describeDeletion() {
	var claim string

	draftCase{
		Name:     "lifecycle-deleted",
		Image:    devenv.MustImage("ssh-ubuntu22.04"),
		Identity: devenv.NonRoot,
		Cases: func(open func() *devenv.Environment) {
			It("G5 withdraws its routes, its port and its workload before it lets go",
				Label(devenv.TierP1, devenv.LabelFamily("G")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					ep, ok := env.SSHEndpoint()
					Expect(ok).To(BeTrue(), "status published no ssh endpoint (has %v)", env.EndpointNames())
					port := ep.ListenerPort

					var err error
					claim, err = env.WorkspaceClaim(ctx)
					Expect(err).NotTo(HaveOccurred())

					hold(ctx, env)
					// Removed again whether or not the case gets that far: an
					// environment held open by a finalizer nothing removes is one
					// the namespace teardown cannot clean up.
					DeferCleanup(func() {
						held, cancel := dumpContext()
						defer cancel()
						release(held, env)
					})

					Expect(env.Delete(ctx)).To(Succeed())

					// The phase the platform reports while it works, which is only
					// readable because the object is held: the controller sets it
					// first and then does the withdrawal, so it is a real state and
					// a short one.
					Eventually(func() string {
						if err := env.Refresh(ctx); err != nil {
							return err.Error()
						}
						st := env.Object().Status
						if st.Phase == nil {
							return "no phase"
						}
						return fmt.Sprintf("%s (%s)", st.Phase.Name, st.Phase.Reason)
					}).WithTimeout(2*time.Minute).WithPolling(time.Second).
						Should(Equal(fmt.Sprintf("%s (%s)", aiv1alpha1.PhaseTerminating, devenv.ReasonDeleting)),
							"the phase a deleted environment goes through")

					// The withdrawal, asserted while the environment still exists —
					// which is the contract the finalizer is there for: nothing the
					// environment published may outlive it, and the platform has to
					// have finished before it lets the object go.
					Eventually(func() error {
						_, err := env.ListenerSet(ctx)
						if err == nil {
							return errors.New("the ListenerSet is still there")
						}
						if !apierrors.IsNotFound(err) {
							return err
						}
						return nil
					}).WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(Succeed(), "the environment's ListenerSet after its deletion")

					Eventually(func() (bool, error) {
						_, found, err := conformance.DataplanePort(ctx, port)
						return found, err
					}).WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(BeFalse(), "the dataplane still publishes port %d", port)

					Eventually(func() error {
						var sts appsv1.StatefulSet
						err := conformance.Client.Get(ctx,
							client.ObjectKey{Namespace: env.Object().Namespace, Name: env.Name}, &sts)
						if apierrors.IsNotFound(err) {
							return nil
						}
						if err != nil {
							return err
						}
						return errors.New("the StatefulSet is still there")
					}).WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(Succeed(), "the environment's workload after its deletion")

					// Released, and only now does the object go: the finalizer this
					// case holds is the last thing between the environment and its
					// absence, so the absence following the release is the proof that
					// the withdrawal above is what the controller was waiting on.
					release(ctx, env)
					Eventually(func() error { return env.Gone(ctx) }).
						WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(Succeed(), "the environment after its finalizers were removed")
				})

			It("G6 reclaims the workspace claim when the policy says delete",
				Label(devenv.TierP1, devenv.LabelFamily("G")), func(ctx SpecContext) {
					env := open()
					Expect(env.Gone(ctx)).To(Succeed())
					Expect(claim).NotTo(BeEmpty(), "G5 did not record the claim")

					// The default policy, and the one this environment carries: the
					// claim is provisioned for the environment from the platform's
					// volumeClaimTemplate, so it goes with the StatefulSet that owns
					// it.
					Eventually(func() (bool, error) { return env.ClaimExists(ctx, claim) }).
						WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(BeFalse(), "the workspace claim %s outlived an environment that asked "+
							"for its workspace to be reclaimed", claim)
				})
		},
	}.declare()
}

// describeRetention is the retain half of G6 and G7: a claim the platform is
// told to keep, and the environment that comes back to it.
func describeRetention() {
	var retained *corev1.PersistentVolumeClaim

	draftCase{
		Name:     "lifecycle-retained",
		Image:    devenv.MustImage("ssh-ubuntu22.04"),
		Identity: devenv.NonRoot,
		Shape: func(want *aiv1alpha1.DevEnvironment) {
			want.Spec.Storage.PVCRetention = aiv1alpha1.PVCRetentionRetain
		},
		Cases: func(open func() *devenv.Environment) {
			It("G6 leaves a retained workspace claim behind",
				Label(devenv.TierP1, devenv.LabelFamily("G")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					pvc, err := env.WorkspaceClaimObject(ctx)
					Expect(err).NotTo(HaveOccurred())
					retained = pvc.DeepCopy()
					// Written before the environment is deleted, because what makes the
					// claim worth keeping is the work in it and not the object.
					sshOutput(ctx, env, `printf '%s' `+workspaceMarker+` > "$HOME/`+workspaceMarkerFile+`"`)

					Expect(env.Delete(ctx)).To(Succeed())
					Eventually(func() error { return env.Gone(ctx) }).
						WithTimeout(5*time.Minute).WithPolling(3*time.Second).
						Should(Succeed(), "the environment being deleted")

					// The claim survived, as the same object: a new claim with the same
					// name would be indistinguishable from this one by name alone.
					got, err := env.ClaimObject(ctx, retained.Name)
					Expect(err).NotTo(HaveOccurred(),
						"the workspace claim %s was reclaimed by an environment that asked for it to "+
							"be kept", retained.Name)
					Expect(got.UID).To(Equal(retained.UID),
						"the claim at %s is a different object from the one that was retained",
						retained.Name)
				})

			It("G7 reuses a retained claim when the environment is recreated",
				Label(devenv.TierP1, devenv.LabelFamily("G")), func(ctx SpecContext) {
					env := open()
					Expect(retained).NotTo(BeNil(), "G6 did not record the retained claim")
					Expect(env.Gone(ctx)).To(Succeed())

					// The same manifest, created again: what the field is for is that
					// a user can get their workspace back, and a user recreating an
					// environment does not restate its spec differently.
					Expect(env.Apply(ctx, nil)).To(Succeed())
					running(ctx, env)

					pvc, err := env.WorkspaceClaimObject(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(pvc.Name).To(Equal(retained.Name))
					Expect(pvc.UID).To(Equal(retained.UID),
						"the recreated environment provisioned a claim of its own instead of adopting "+
							"the retained %s, so the workspace it was told to keep is not the one it "+
							"is running on", retained.Name)

					// And the work is still there. The claim being the same object is
					// what the platform promised; the file is what the user cares
					// about, and it is the assertion that would fail if the claim had
					// been recreated with the same name.
					Expect(strings.TrimSpace(sshOutput(ctx, env, `cat "$HOME/`+workspaceMarkerFile+`"`))).
						To(Equal(workspaceMarker),
							"the file written before the environment was deleted is not in the "+
								"workspace it came back on")
				})
		},
	}.declare()
}

// --- the workspace marker -----------------------------------------------------

// The file the lifecycle cases leave in the workspace and read back after a stop
// and after a delete.
//
// A fixed name and content, because what it proves is that the *same* file is
// still readable — an environment that came back on a fresh, empty claim answers
// with nothing, which is the whole finding.
const (
	workspaceMarker     = "e2e-lifecycle-marker"
	workspaceMarkerFile = ".e2e-lifecycle"
)

// phaseAgreement is the contract the phase and the conditions share.
//
// They are written in one status patch, so a case sampling both is sampling one
// reconcile's answer — which is what makes "they never disagree" a claim a poll
// can check rather than a race. What it checks is the part of their relationship
// that holds in every state:
//
//   - a Ready that is true says the environment is Running, its pod is scheduled
//     and it published somewhere to connect to, so any of those saying otherwise
//     is the platform describing one environment two ways;
//   - a Ready that is false implies nothing about the phase, and deliberately:
//     a pod that is Running but not yet ready is phase Running with Ready false
//     — the platform reporting the workload as up and the connection as not yet
//     usable, which is a real state rather than a disagreement.
func phaseAgreement(st aiv1alpha1.DevEnvironmentStatus) error {
	if st.Phase == nil {
		return errors.New("no phase recorded")
	}
	ready := meta.FindStatusCondition(st.Conditions, aiv1alpha1.ConditionReady)
	if ready == nil {
		return errors.New("Ready is not recorded")
	}
	if ready.Status != metav1.ConditionTrue {
		return nil
	}
	if st.Phase.Name != aiv1alpha1.PhaseRunning {
		return fmt.Errorf("Ready is true while the phase is %s (%s)", st.Phase.Name, st.Phase.Reason)
	}
	scheduled := meta.FindStatusCondition(st.Conditions, aiv1alpha1.ConditionPodScheduled)
	if scheduled == nil {
		return errors.New("Ready is true while PodScheduled is not recorded")
	}
	if scheduled.Status != metav1.ConditionTrue {
		return fmt.Errorf("Ready is true while PodScheduled is %s (%s)",
			scheduled.Status, scheduled.Reason)
	}
	if len(st.Endpoints) == 0 {
		return errors.New("Ready is true with no endpoint published, so nothing connects")
	}
	return nil
}

// --- lifecycle helpers --------------------------------------------------------

// running waits for an environment to be up and usable.
func running(ctx SpecContext, env *devenv.Environment) {
	GinkgoHelper()
	Eventually(func() error { return env.Ready(ctx) }).
		WithTimeout(devenv.UpTimeout()).WithPolling(5*time.Second).
		Should(Succeed(), "%s never became running", env.Name)
}

// runningOn is running, on a pod other than the ones named.
//
// The wait a case that restarted an environment needs, and the reason it exists
// is in onAnotherPod: an environment whose pod is being deleted reads as a
// running one, so "it is Running again" is satisfied by the environment that
// was stopped until the platform has actually replaced the workload.
func runningOn(ctx SpecContext, env *devenv.Environment, was ...types.UID) {
	GinkgoHelper()
	Eventually(func() error {
		if err := env.Ready(ctx); err != nil {
			return err
		}
		back, err := onAnotherPod(ctx, env, was...)
		if err != nil {
			return err
		}
		if !back {
			return errors.New("the environment is still the pod the stop was deleting")
		}
		return nil
	}).WithTimeout(devenv.UpTimeout()).WithPolling(5*time.Second).
		Should(Succeed(), "%s never came back on another pod", env.Name)
}

// onAnotherPod reports whether the environment has a pod that is not one of
// was — with no names, whether it has a pod at all.
//
// An empty list is the honest answer to "which pod was it on?" for an
// environment that had no pod when the question was asked: whatever it is on
// now, it is not one it was on before.
func onAnotherPod(ctx context.Context, env *devenv.Environment, was ...types.UID) (bool, error) {
	now, err := env.PodUIDs(ctx)
	if err != nil {
		return false, err
	}
	for _, uid := range now {
		if !slices.Contains(was, uid) {
			return true, nil
		}
	}
	return false, nil
}

// stopped waits for the platform to report an environment as stopped.
func stopped(ctx SpecContext, env *devenv.Environment) {
	GinkgoHelper()
	Eventually(func() error { return env.Stopped(ctx) }).
		WithTimeout(3*time.Minute).WithPolling(3*time.Second).
		Should(Succeed(), "%s never reported the stop it was asked for", env.Name)
}

// hold adds this suite's finalizer, so the environment cannot be deleted out
// from under a case that is reading its deletion.
func hold(ctx context.Context, env *devenv.Environment) {
	GinkgoHelper()
	Expect(env.Patch(ctx, func(want *aiv1alpha1.DevEnvironment) {
		if !slices.Contains(want.Finalizers, holdFinalizer) {
			want.Finalizers = append(want.Finalizers, holdFinalizer)
		}
	})).To(Succeed(), "adding %s to %s", holdFinalizer, env.Name)
}

// release removes it again, tolerating an environment that has already gone.
//
// A plain context rather than the spec's, because it is also called from a
// DeferCleanup, by which time the SpecContext has been cancelled.
//
// The toleration is load-bearing rather than defensive. The case that deletes an
// environment releases the hold before waiting for it to go — the hold is what
// the deletion has to get past — so by the time the DeferCleanup runs the object
// is gone, and a release that failed on that would report a successful deletion
// as a failure of the case that performed it.
func release(ctx context.Context, env *devenv.Environment) {
	GinkgoHelper()
	err := env.Patch(ctx, func(want *aiv1alpha1.DevEnvironment) {
		want.Finalizers = slices.DeleteFunc(want.Finalizers, func(f string) bool { return f == holdFinalizer })
	})
	if apierrors.IsNotFound(err) {
		return
	}
	Expect(err).To(Succeed(), "removing %s from %s", holdFinalizer, env.Name)
}
