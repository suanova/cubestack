//go:build e2e
// +build e2e

package e2e

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/test/e2e/devenv"
)

// Family E: the Accepted condition contract (§4.E), the one P0 family that is
// not about an endpoint.
//
// The condition answers *"did you apply my spec as written, or something else?"*
// and it is two-sided, which is why these cases come in pairs. Refusing a spec
// the controller could have run makes the platform look broken for no reason; a
// silent override is worse, because the environment runs and the user is never
// told that half of what they wrote is not in effect. So every case here asserts
// both halves: what the condition says, and what the cluster did with it.
//
// Every case but E8 shapes its own spec. The catalogue's manifests are the ones
// the matrix runs and they are all accepted as written, so the subject — a spec
// the controller resolves itself — is a spec the catalogue would never build.
// That is what Draft is for: the catalogue's manifest for an (image, identity),
// which the case changes before anything is created.
//
// E8 is the other side of the same contract and rides on the matrix: every one
// of those twelve environments is a spec applied as written, which is the claim
// Accepted=True/reason Accepted makes.
//
// Two cases deviate from how §4.E words them, both because the wording names a
// mechanism the CRD does not have. E2's row says NOTEBOOK_ARGS "carrying a
// --ServerApp.base_url= the route cannot honour", but a plain value is never
// refused — the controller reads it, drops the flag and reports the drop, which
// is E7. The refusal is for an entry the controller cannot read at all, i.e. a
// valueFrom source. E9's row says "a StorageClass nothing provisions", but
// spec.storage carries no class: the controller hardcodes cephfs-ephemeral and
// no spec field names another, so the state that row is after — the spec
// honoured, the cluster unable to serve it — is reached through resources
// instead. Both keep the contract's shape, which is what the row is for.

// reasonNotScheduled is the reason the controller records when the environment's
// pod exists and no node has taken it. It is not the scheduler's own reason —
// that one is on the pod, and E9 asserts both.
const reasonNotScheduled = "NotScheduled"

// describeAccepted declares family E. It is called from the conformance
// container so it inherits that container's guard against running without
// DEVENV_E2E.
func describeAccepted() {
	// The tier and family labels sit on the container and are inherited: every
	// case here is P0 and family E, which is not true of the matrix, where the
	// case is what carries them.
	Describe("the Accepted condition contract",
		Label(devenv.TierP0, devenv.LabelFamily("E")), func() {

			// --- refusals ---
			//
			// Both assert the same shape: Accepted=False with the reason that
			// names the cause, the environment Failed rather than left waiting,
			// and nothing provisioned. Neither pulls an image, because a blocking
			// finding is answered before the workload is rendered — which is why
			// E1 can name a multi-gigabyte CUDA image and cost seconds.

			draftCase{
				Name:     "accepted-refused-brand",
				Image:    devenv.MustImage("jupyter-cuda-pytorch"),
				Identity: devenv.NonRoot,
				Shape: func(d *aiv1alpha1.DevEnvironment) {
					// The CUDA image asked for as a Metax one. The controller
					// matches a vendor against a naming rule rather than against
					// what the image says, so this is the disagreement it can see.
					d.Spec.Resources.GPU = &aiv1alpha1.GPUSpec{Vendor: aiv1alpha1.AcceleratorVendorMetax}
				},
				Cases: func(open func() *devenv.Environment) {
					It("E1 refuses an image whose brand contradicts the vendor the spec asks for",
						func(ctx SpecContext) {
							env := open()
							c := acceptedSettled(ctx, env)

							Expect(c.Status).To(Equal(metav1.ConditionFalse),
								"the controller ran a spec it should have refused: %s", c.Message)
							Expect(c.Reason).To(Equal(devenv.ReasonBrandMismatch))
							// Naming the field is the point of the message: the
							// only fix is an edit, so a message that did not say
							// which edit would leave the user guessing.
							Expect(c.Message).To(ContainSubstring("resources.gpu.vendor"),
								"a refusal has to name the field the user changes; got %q", c.Message)

							// Failed and not Pending: an environment waiting to be
							// reconciled is one the user is invited to wait for.
							Expect(env.Object().Status.Phase.Name).To(Equal(aiv1alpha1.PhaseFailed))
							ready := env.Condition(aiv1alpha1.ConditionReady)
							Expect(ready).NotTo(BeNil())
							Expect(ready.Reason).To(Equal(devenv.ReasonBrandMismatch),
								"Ready and Accepted have to agree about why")

							// Nothing is provisioned, so nothing is pulled. This
							// is the assertion that makes "refused" mean the
							// environment does not exist rather than that it
							// exists in a bad state.
							pods, err := env.Pods(ctx)
							Expect(err).NotTo(HaveOccurred())
							Expect(pods).To(BeEmpty(),
								"a refused environment left a pod behind: %s", podNames(pods))
						})
				},
			}.declare()

			draftCase{
				Name:     "accepted-refused-notebook-args",
				Image:    devenv.MustImage("jupyter-minimal"),
				Identity: devenv.NonRoot,
				Shape: func(d *aiv1alpha1.DevEnvironment) {
					// A NOTEBOOK_ARGS the controller cannot read. It has to
					// merge its own base_url into that entry so the notebook
					// serves the prefix the route publishes, and an unreadable
					// entry is one it cannot tell a conflicting flag from.
					d.Spec.Runtime.Env = append(d.Spec.Runtime.Env, corev1.EnvVar{
						Name: devenv.EnvNotebookArgs,
						ValueFrom: &corev1.EnvVarSource{
							FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.name"},
						},
					})
				},
				Cases: func(open func() *devenv.Environment) {
					It("E2 refuses a NOTEBOOK_ARGS the controller cannot read",
						func(ctx SpecContext) {
							env := open()
							c := acceptedSettled(ctx, env)

							Expect(c.Status).To(Equal(metav1.ConditionFalse),
								"the controller ran a spec it should have refused: %s", c.Message)
							Expect(c.Reason).To(Equal(devenv.ReasonNotebookArgsUnusable))
							Expect(c.Message).To(ContainSubstring("runtime.env["+devenv.EnvNotebookArgs+"]"),
								"a refusal has to name the field the user changes; got %q", c.Message)
							Expect(env.Object().Status.Phase.Name).To(Equal(aiv1alpha1.PhaseFailed))

							pods, err := env.Pods(ctx)
							Expect(err).NotTo(HaveOccurred())
							Expect(pods).To(BeEmpty(),
								"a refused environment left a pod behind: %s", podNames(pods))
						})
				},
			}.declare()

			// --- overrides ---
			//
			// The environment runs and the condition says Overridden. Each case
			// asserts the clause that names its field *and* the consequence —
			// the message alone would only prove the controller noticed, not
			// that it did anything about it.

			draftCase{
				Name:     "accepted-token-override",
				Image:    devenv.MustImage("jupyter-minimal"),
				Identity: devenv.NonRoot,
				Shape: func(d *aiv1alpha1.DevEnvironment) {
					d.Spec.Runtime.Env = append(d.Spec.Runtime.Env,
						corev1.EnvVar{Name: devenv.EnvJupyterToken, Value: specChosenToken})
				},
				Cases: func(open func() *devenv.Environment) {
					It("E3 ignores a JUPYTER_TOKEN the spec declares and serves the one it minted",
						func(ctx SpecContext) {
							env := open()
							assertOverridden(ctx, env, "runtime.env["+devenv.EnvJupyterToken+"]")

							// The notebook is what makes this an assertion about
							// the environment rather than about a string.
							Eventually(func() error { return env.Ready(ctx) }).
								WithTimeout(devenv.UpTimeout()).WithPolling(10*time.Second).
								Should(Succeed(), "the environment running on the overridden token")

							platformToken, err := env.JupyterToken(ctx)
							Expect(err).NotTo(HaveOccurred())
							Expect(platformToken).NotTo(Equal(specChosenToken),
								"the spec's token and the platform's are the same string, so this case would pass "+
									"whatever the controller did with it")

							ep, ok := env.WebEndpoint()
							Expect(ok).To(BeTrue(), "status published no web endpoint (has %v)", env.EndpointNames())
							base, err := withTrailingSlash(ep.Address)
							Expect(err).NotTo(HaveOccurred())
							client := conformance.Dialer.HTTPClient()

							// The platform's token, asked for at the endpoint the
							// platform published.
							Eventually(func() int {
								code, _, _ := get(ctx, client, base+"api/status?token="+platformToken)
								return code
							}).WithTimeout(3*time.Minute).WithPolling(5*time.Second).
								Should(Equal(http.StatusOK), "api/status with the token from %s",
									env.Object().Status.JupyterTokenSecret.Name)

							// And the spec's, which the notebook must not know.
							code, body, err := get(ctx, client, base+"api/status?token="+specChosenToken)
							Expect(err).NotTo(HaveOccurred())
							Expect(code).NotTo(Equal(http.StatusOK),
								"the notebook served the token the spec declared: %s", truncate(body))
						})
				},
			}.declare()

			draftCase{
				Name:     "accepted-user-override",
				Image:    devenv.MustImage("ssh-ubuntu22.04"),
				Identity: devenv.Root,
				Shape: func(d *aiv1alpha1.DevEnvironment) {
					// A user field on a root environment. It is not refused —
					// root is a legitimate request and the platform serves it —
					// but the account the spec names is not the one that runs.
					d.Spec.Runtime.User = "ubuntu"
				},
				Cases: func(open func() *devenv.Environment) {
					It("E4 ignores spec.runtime.user on a root environment and publishes root",
						func(ctx SpecContext) {
							env := open()
							assertOverridden(ctx, env, "runtime.user")

							// The consequence, read where a user would read it:
							// the address the platform published. The account
							// named there is the one a login has to be for, so
							// the spec's name not appearing in it is the claim.
							Eventually(func() error { return env.Ready(ctx) }).
								WithTimeout(devenv.UpTimeout()).WithPolling(10*time.Second).
								Should(Succeed(), "the environment running with an ignored runtime.user")

							ep, ok := env.SSHEndpoint()
							Expect(ok).To(BeTrue(), "status published no ssh endpoint (has %v)", env.EndpointNames())
							target, err := devenv.ParseSSHAddress(ep.Address)
							Expect(err).NotTo(HaveOccurred())
							Expect(target.User).To(Equal("root"),
								"%s advertises %q for an environment that runs as root", ep.Address, target.User)
						})
				},
			}.declare()

			draftCase{
				Name:     "accepted-launcher-env-override",
				Image:    devenv.MustImage("jupyter-minimal"),
				Identity: devenv.Root,
				Shape: func(d *aiv1alpha1.DevEnvironment) {
					// The launcher settings the controller owns on a root
					// environment. They have to name root's own account in the
					// image's passwd database, and a launcher told otherwise
					// rewrites the account it serves — which cannot complete
					// while the container is running as root, and takes the
					// container with it.
					d.Spec.Runtime.Env = append(d.Spec.Runtime.Env,
						corev1.EnvVar{Name: devenv.EnvNBUser, Value: "jovyan"},
						corev1.EnvVar{Name: devenv.EnvNBUID, Value: "1000"},
						corev1.EnvVar{Name: devenv.EnvNBGID, Value: "100"},
					)
				},
				Cases: func(open func() *devenv.Environment) {
					It("E5 ignores NB_USER, NB_UID and NB_GID on a root environment",
						func(ctx SpecContext) {
							env := open()
							// One clause per declared entry, so a controller that
							// dropped only some of them is not reported as
							// dropping all three.
							c := acceptedSettled(ctx, env)
							assertOverriddenCondition(c,
								"runtime.env["+devenv.EnvNBUser+"]",
								"runtime.env["+devenv.EnvNBUID+"]",
								"runtime.env["+devenv.EnvNBGID+"]")

							// The consequence: the container runs with the
							// controller's three, not the spec's. Read from the
							// pod rather than from the session, because a
							// launcher that read the spec's would have failed to
							// start at all.
							Eventually(func() error { return env.PodRunning(ctx) }).
								WithTimeout(devenv.UpTimeout()).WithPolling(10*time.Second).
								Should(Succeed(), "the environment running on the controller's launcher settings")

							pod, err := env.Pod(ctx)
							Expect(err).NotTo(HaveOccurred())
							got := containerEnv(pod)
							Expect(got).To(HaveKeyWithValue(devenv.EnvNBUser, "root"))
							Expect(got).To(HaveKeyWithValue(devenv.EnvNBUID, "0"))
							Expect(got).To(HaveKeyWithValue(devenv.EnvNBGID, "0"))
						})
				},
			}.declare()

			draftCase{
				Name:     "accepted-home-override",
				Image:    devenv.MustImage("ssh-ubuntu22.04"),
				Identity: devenv.NonRoot,
				Shape: func(d *aiv1alpha1.DevEnvironment) {
					// A HOME that disagrees with where the workspace is mounted.
					// The declared value is the image's own baked home, which is
					// exactly the one a user would write and exactly the one
					// that would send their work to the container's filesystem.
					d.Spec.Storage.MountPath = "/workspace"
					d.Spec.Runtime.Env = append(d.Spec.Runtime.Env,
						corev1.EnvVar{Name: devenv.EnvHome, Value: "/home/ubuntu"})
				},
				Cases: func(open func() *devenv.Environment) {
					It("E6 ignores a HOME that is not where the workspace is mounted",
						func(ctx SpecContext) {
							env := open()
							assertOverridden(ctx, env, "runtime.env["+devenv.EnvHome+"]")

							Eventually(func() error { return env.Ready(ctx) }).
								WithTimeout(devenv.UpTimeout()).WithPolling(10*time.Second).
								Should(Succeed(), "the environment running with an ignored HOME")

							// The consequence, in the two places the platform
							// states it: the mount it made, and the home it
							// told the container to serve. A HOME the claim is
							// not mounted at is a workload writing to the
							// container while the claim sits unused.
							workspace, err := env.WorkspaceMountPath(ctx)
							Expect(err).NotTo(HaveOccurred())
							Expect(workspace).To(Equal("/workspace"),
								"the claim is mounted where the spec pinned it")

							pod, err := env.Pod(ctx)
							Expect(err).NotTo(HaveOccurred())
							Expect(containerEnv(pod)).To(HaveKeyWithValue(devenv.EnvHome, workspace),
								"the container's HOME is the mount path, not the one the spec declared")

							// A session's HOME is deliberately not asserted: it
							// belongs to the account and not to the mount. The
							// two answer different questions — mountPath says
							// where the claim is mounted, and a login account's
							// home is a property of the image's passwd entry,
							// which sshd reads for each session. No environment
							// variable moves it, so the HOME above is the
							// container's and not the session's: measured on
							// cs3, this environment gives `$HOME` as
							// /home/ubuntu in a session while the claim is at
							// /workspace.
							//
							// They agree by default rather than by construction
							// — the console's default mount path is the
							// account's own home (::resolveMountPath) — so this
							// case is the only shape in which the two are
							// visible as two. Asserting the session's HOME here
							// would be asserting the image's choice of account
							// home under this spec's name.
						})
				},
			}.declare()

			draftCase{
				Name:     "accepted-notebook-args-override",
				Image:    devenv.MustImage("jupyter-minimal"),
				Identity: devenv.NonRoot,
				Shape: func(d *aiv1alpha1.DevEnvironment) {
					// The base_url the controller owns, declared by the spec,
					// alongside a flag it does not own. Both halves are the
					// assertion: the first is replaced because the route
					// publishes the notebook under the platform's prefix, and
					// the second survives because it is not the controller's.
					d.Spec.Runtime.Env = append(d.Spec.Runtime.Env, corev1.EnvVar{
						Name: devenv.EnvNotebookArgs,
						Value: devenv.NotebookBaseURLFlag + "/chosen-by-the-spec " +
							notebookKeptArg,
					})
				},
				Cases: func(open func() *devenv.Environment) {
					It("E7 replaces the base_url a NOTEBOOK_ARGS declares and keeps every other flag",
						func(ctx SpecContext) {
							env := open()
							assertOverridden(ctx, env, "runtime.env["+devenv.EnvNotebookArgs+"]")

							Eventually(func() error { return env.PodRunning(ctx) }).
								WithTimeout(devenv.UpTimeout()).WithPolling(10*time.Second).
								Should(Succeed(), "the environment running on the rewritten NOTEBOOK_ARGS")

							// Read from the container, which is where the
							// rewrite lands: the endpoint half of this case is
							// J3, and asserting it here as well would be two
							// cases failing on one cause.
							pod, err := env.Pod(ctx)
							Expect(err).NotTo(HaveOccurred())
							args := containerEnv(pod)[devenv.EnvNotebookArgs]
							Expect(args).To(ContainSubstring(notebookKeptArg),
								"a flag the controller does not own was dropped: %q", args)
							Expect(args).NotTo(ContainSubstring("/chosen-by-the-spec"),
								"the spec's base_url survived, so the notebook serves a prefix its route "+
									"does not forward: %q", args)

							// The controller's own prefix, which is the one the
							// route forwards — so this is the flag, and not the
							// fact that some flag is present.
							path := "/dev/" + conformance.Namespace + "/" + env.Name + "/"
							Expect(args).To(ContainSubstring(devenv.NotebookBaseURLFlag+path),
								"NOTEBOOK_ARGS does not declare the prefix the route publishes: %q", args)
						})
				},
			}.declare()

			// --- the contract's shape ---

			draftCase{
				Name:     "accepted-unschedulable",
				Image:    devenv.MustImage("ssh-ubuntu22.04"),
				Identity: devenv.NonRoot,
				Shape: func(d *aiv1alpha1.DevEnvironment) {
					// More than any node in a test cluster has, so the pod is
					// created and never scheduled. Deliberately not a spec error:
					// sizes are a request the platform honours and the cluster
					// cannot serve.
					d.Spec.Resources = aiv1alpha1.ResourcesSpec{CPU: "2000", Memory: "2000Gi"}
				},
				Cases: func(open func() *devenv.Environment) {
					It("E9 keeps a cluster-state failure out of Accepted",
						func(ctx SpecContext) {
							env := open()
							// The first reconcile records Accepted before the pod
							// exists at all, so this is settled early and the
							// case then waits for the state that makes it mean
							// something.
							c := acceptedSettled(ctx, env)
							Expect(c.Status).To(Equal(metav1.ConditionTrue),
								"a cluster the spec does not fit was reported as a spec the controller "+
									"refused: %s", c.Message)
							Expect(c.Reason).To(Equal(devenv.ReasonAccepted),
								"the spec is applied as written; what is wrong is the cluster: %s", c.Message)

							// Where the failure is reported instead. The pod has
							// to exist first, and a pod the scheduler keeps
							// refusing never stops existing, so this waits for
							// the observation rather than for a transition.
							var last error
							Eventually(func() error {
								last = env.Refresh(ctx)
								if last != nil {
									return last
								}
								pods, err := env.Pods(ctx)
								if err != nil {
									return err
								}
								if len(pods) == 0 {
									return fmt.Errorf("the pod has not been created yet")
								}
								return nil
							}).WithTimeout(5*time.Minute).WithPolling(5*time.Second).
								Should(Succeed(), "the environment's pod being created")

							Expect(env.Object().Status.Phase.Name).To(Equal(aiv1alpha1.PhasePending),
								"an unschedulable environment is waiting, not failed")
							scheduled := env.Condition(aiv1alpha1.ConditionPodScheduled)
							Expect(scheduled).NotTo(BeNil())
							Expect(scheduled.Status).To(Equal(metav1.ConditionFalse))
							Expect(scheduled.Reason).To(Equal(reasonNotScheduled))

							// And the failure is observable, not merely true: the
							// scheduler's own reason names what it could not find
							// room for, which is the difference between a user
							// knowing to lower the request and being told to try
							// again.
							pod, err := env.Pod(ctx)
							Expect(err).NotTo(HaveOccurred())
							cond := podCondition(pod, corev1.PodScheduled)
							Expect(cond).NotTo(BeNil(),
								"the pod records no PodScheduled condition, so nothing anywhere says why it is stuck")
							Expect(cond.Reason).To(Equal(corev1.PodReasonUnschedulable),
								"the scheduler's reason for refusing the pod: %s", cond.Message)
							Expect(cond.Message).To(ContainSubstring("Insufficient"),
								"the scheduler's message has to name what it could not find: %q", cond.Message)
						})
				},
			}.declare()
		})
}

// specChosenToken is the token E3's spec declares. Its only virtue is that no
// generator will produce it, so the two tokens can be told apart.
const specChosenToken = "declared-by-the-spec-and-not-by-the-platform"

// notebookKeptArg is an argument E7's spec adds beside the base_url the
// controller owns. It is arbitrary because nothing depends on the value — the
// claim is that a flag the controller does not own comes through untouched.
const notebookKeptArg = "--ServerApp.allow_origin=*"

// --- readers ------------------------------------------------------------------

// acceptedSettled waits for the controller to record the Accepted condition and
// returns it.
//
// A wait rather than a read: Apply creates the object and reads it back in the
// same breath, which is before the controller has looked at it — and the first
// reconcile records no Accepted at all, because it is the one that adds the
// finalizer. So the condition is a transition the case has to observe rather
// than a state it can assert on arrival.
func acceptedSettled(ctx SpecContext, env *devenv.Environment) *metav1.Condition {
	GinkgoHelper()
	var c *metav1.Condition
	Eventually(func() string {
		if err := env.Refresh(ctx); err != nil {
			return err.Error()
		}
		c = env.Condition(aiv1alpha1.ConditionAccepted)
		if c == nil {
			return "no Accepted condition recorded yet"
		}
		return ""
	}).WithTimeout(2*time.Minute).WithPolling(2*time.Second).
		Should(BeEmpty(), "the controller's verdict on %s", env.Name)
	return c
}

// assertOverridden waits for the verdict and asserts it is an override that names
// one field.
func assertOverridden(ctx SpecContext, env *devenv.Environment, field string) {
	GinkgoHelper()
	assertOverriddenCondition(acceptedSettled(ctx, env), field)
}

// assertOverriddenCondition asserts an already-read condition is an override
// naming every one of fields.
//
// True and not False: an override is a spec the controller ran, on its own value
// for part of it. An environment that did not run at all would be a refusal, and
// a case asserting only "the message mentions my field" cannot tell the two
// apart.
func assertOverriddenCondition(c *metav1.Condition, fields ...string) {
	GinkgoHelper()
	Expect(c.Status).To(Equal(metav1.ConditionTrue),
		"an override is not a refusal, so the environment has to run: %s", c.Message)
	Expect(c.Reason).To(Equal(devenv.ReasonOverridden),
		"the controller reported a spec applied as written, so this case has nothing to assert: %s", c.Message)
	for _, field := range fields {
		Expect(c.Message).To(ContainSubstring(field),
			"the override has to name every field it resolved, and this one is missing: %s", c.Message)
	}
	// A clause per field, in the controller's own wording. Asserted because a
	// message that named the fields without saying what became of them would
	// read as a description of the spec rather than as a report on it.
	Expect(strings.Count(c.Message, "ignored")).To(BeNumerically(">=", len(fields)),
		"every overridden field is reported as ignored: %s", c.Message)
}
