//go:build e2e
// +build e2e

package e2e

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"golang.org/x/crypto/ssh"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/test/e2e/devenv"
)

// The DevEnvironment conformance suite: every published image, as the image's
// own account and as root, asserted through the platform's own Gateway on a
// cluster somebody else owns.
//
// It is opt-in twice over — the make target sets DEVENV_E2E, and TestE2E filters
// LabelConformance out unless a filter is given — because it pulls images
// measured in tens of gigabytes and creates real environments in a real
// namespace. Neither default can be reached by forgetting something.
//
// Every address a case dials is read from status.endpoints and never assembled.
// What is under test is precisely that what the platform tells a user to connect
// to is what answers, so a case that built the address itself would be asserting
// its own arithmetic.

// envDevEnvConformance switches the suite from "build a cluster and test the
// manager on it" to "test the platform on a cluster that already exists".
const envDevEnvConformance = "DEVENV_E2E"

// peakPorts is how many L4 ports this suite holds at once.
//
// Each entry of the matrix brings its environment up in BeforeAll and takes it
// down in AfterAll, so no two of them are ever live together and one port — the
// ssh listener — is the whole of what a matrix environment holds. The families
// are where the number comes from: family K's first environment declares three
// L4 exposures, and its last one brings up a second environment beside it in
// another namespace, so four listeners are declared at the moment that case
// runs. A case that adds a spec.ports entry, or a change that overlaps
// environments, has to raise this; it is a constant here rather than a number
// in the preflight so that raising it is a decision somebody makes.
const peakPorts = 4

var (
	// conformance is nil until the conformance branch of BeforeSuite runs. The
	// specs below fail loudly rather than nil-panicking when it is, which is what
	// happens if someone passes a conformance label filter without DEVENV_E2E.
	conformance *devenv.Suite
	cluster     devenv.Cluster
)

// setupDevEnvConformance is the whole of the conformance-side setup: a client, a
// report on the cluster, and a namespace.
//
// The preconditions are checked here rather than as specs because several of them
// make a run silently vacuous rather than failing it — an installed Agent Router
// leaves every ssh listener unprogrammed while all twelve environments read
// healthy — and the point is to refuse before an environment exists, not to
// produce twelve identical transport failures that name the wrong component.
func setupDevEnvConformance() {
	By("building the conformance client")
	var err error
	conformance, err = devenv.NewSuite()
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "building the client for the cluster in KUBECONFIG")

	By("checking the cluster preconditions")
	pf := devenv.Preflight{
		Client:              conformance.Client,
		Dialer:              conformance.Dialer,
		PullSecretNamespace: conformance.PlatformNamespace,
		PullSecretName:      conformance.PullSecret,
		NeededPorts:         peakPorts,
	}
	var results []devenv.Result
	cluster, results = pf.Run(context.Background())

	// Every result, not just the failures: a report that only lists what is wrong
	// makes the reader go and check the rest themselves.
	var failed []devenv.Result
	for _, r := range results {
		_, _ = fmt.Fprintln(GinkgoWriter, r.String())
		if !r.Ok() {
			failed = append(failed, r)
		}
	}
	if len(failed) > 0 {
		var b strings.Builder
		fmt.Fprintf(&b, "%d of %d preconditions failed:", len(failed), len(results))
		for _, r := range failed {
			fmt.Fprintf(&b, "\n  - %s: %v", r.Name, r.Err)
		}
		b.WriteString("\n\nThese are not optional. Fix them, or set DEVENV_E2E_SKIP_PREFLIGHT=1 to " +
			"run anyway — results will be inconclusive.")
		if os.Getenv("DEVENV_E2E_SKIP_PREFLIGHT") != "1" {
			Fail(b.String())
		}
		_, _ = fmt.Fprintln(GinkgoWriter, b.String())
	}

	By("preparing the run namespace")
	ExpectWithOffset(1, conformance.Setup(context.Background())).
		To(Succeed(), "creating %s and giving it the pull credential", conformance.Namespace)

	// The cases that ask about the cluster rather than about an environment read
	// it from here, so the Gateway and the pool they assert against are the ones
	// the manager is configured with rather than a second opinion.
	conformance.Cluster = cluster
}

// teardownDevEnvConformance removes the run's namespace.
//
// The environments go first, and not just the namespace with them: deleting the
// namespace takes the DevEnvironment with it, so the controller's withdrawal
// path — the ListenerSet removal and the L4 port release — never runs. That path
// is what several cases assert on, so a run that stopped halfway should still
// exercise it.
func teardownDevEnvConformance() {
	if conformance == nil {
		return
	}
	By("removing " + conformance.Namespace)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	conformance.TearDown(ctx)
}

// The run's images, reported once at the end.
//
// `:latest` under `imagePullPolicy: Always` is a moving target, and nothing this
// suite can read knows what it ought to resolve to — so the claim worth making is
// the weaker one that is still checkable: that one image key meant one artifact
// for the whole run. Without it a `:latest` republished midway leaves the first
// and last environments of a key running different software under one name, and
// the run reports twelve green environments when it was two different things.
//
// The report is by key and not by environment because that is the axis the
// catalogue is asserted on: "ssh-cuda-pytorch was tested" is true of the key.
//
// A plain function called from the suite's one AfterSuite rather than an
// AfterSuite of its own, which Ginkgo allows only one of.
func reportDevEnvImageDigests() {
	if conformance == nil {
		return
	}
	digests := conformance.ImageDigests()
	if len(digests) == 0 {
		return
	}

	// ImageDigests is sorted by key and then digest, so each key's list is
	// already in order and Compact leaves the distinct ones.
	byKey := map[string][]string{}
	for _, d := range digests {
		byKey[d.Key] = append(byKey[d.Key], d.Digest)
	}
	keys := make([]string, 0, len(byKey))
	for k := range byKey {
		keys = append(keys, k)
	}
	slices.Sort(keys)

	var b strings.Builder
	b.WriteString("\nimages this run ran:\n")
	var conflicts []string
	for _, k := range keys {
		distinct := slices.Compact(byKey[k])
		for i, d := range distinct {
			label := ""
			if i == 0 {
				label = k
			}
			fmt.Fprintf(&b, "  %-22s %s\n", label, d)
		}
		if len(distinct) > 1 {
			conflicts = append(conflicts, k)
		}
	}
	// stdout and not GinkgoWriter, which is buffered and emitted only for a failed
	// spec or under --ginkgo.v — neither of which the devenv-e2e target asks for.
	// A table that a green run never prints is the same as no table, and this is
	// the one place a reader learns which `:latest` was actually tested.
	_, _ = fmt.Fprintln(os.Stdout, b.String())

	Expect(conflicts).To(BeEmpty(),
		"these images resolved to more than one digest during the run, so the cases on them "+
			"tested more than one artifact under one name: %v", conflicts)
}

// environments is the selection this run brings up: one row per (image,
// identity), twelve in all.
//
// The keys are written once and looked up. A row that named its image by
// position in the catalogue would go on passing after the catalogue was
// reordered, quietly running a different environment than it says it does.
//
// This is §3's matrix. Its two halves are not the same thing: §3.1 is the six
// Jupyter rows, §3.2 the twelve SSH ones, and the pair for one image and
// identity is a single environment asserted on both its endpoints. Twelve
// environments carry all eighteen assertions, which is what a run brings up.
//
// Order is cheapest-first so a broken cluster is diagnosed before the first
// multi-gigabyte pull rather than after it.
var environments = []struct {
	image    devenv.Image
	identity devenv.Identity
}{
	{devenv.MustImage("ssh-ubuntu22.04"), devenv.NonRoot}, // S1
	{devenv.MustImage("ssh-ubuntu22.04"), devenv.Root},    // S2
	{devenv.MustImage("jupyter-minimal"), devenv.NonRoot}, // J1, S3
	{devenv.MustImage("jupyter-minimal"), devenv.Root},    // J2, S4
	{devenv.MustImage("ssh-maca-pytorch"), devenv.NonRoot},
	{devenv.MustImage("ssh-maca-pytorch"), devenv.Root},
	{devenv.MustImage("jupyter-maca-pytorch"), devenv.NonRoot},
	{devenv.MustImage("jupyter-maca-pytorch"), devenv.Root},
	{devenv.MustImage("ssh-cuda-pytorch"), devenv.NonRoot},
	{devenv.MustImage("ssh-cuda-pytorch"), devenv.Root},
	{devenv.MustImage("jupyter-cuda-pytorch"), devenv.NonRoot},
	{devenv.MustImage("jupyter-cuda-pytorch"), devenv.Root},
}

var _ = Describe("DevEnvironment conformance", Label(devenv.LabelConformance), Ordered, func() {
	// The guard for entering the conformance specs without entering the
	// conformance setup, which is what a bare --ginkgo.label-filter does when
	// DEVENV_E2E is unset. Left to itself that is a nil pointer rather than a
	// sentence.
	BeforeAll(func() {
		if conformance == nil {
			Fail(fmt.Sprintf(
				"the DevEnvironment conformance suite runs against an existing cluster and needs %s=1.\n"+
					"The kind path builds the cluster its specs run on; this one does not.",
				envDevEnvConformance))
		}
	})

	for _, e := range environments {
		DescribeEnvironment(e.image, e.identity)
	}
	// Family E's other eight cases, which shape their own environments: the
	// catalogue's manifests are all accepted as written, so the subject — a spec
	// the controller resolves itself — is one the catalogue would never build.
	describeAccepted()
	// Families G, H, I, J, K, L and M, whose subjects are states and objects no
	// catalogue environment is in: a stopped one, one being deleted, one with a
	// spec the matrix does not carry.
	describeLifecycle()
	describeStorageCases()
	describeSSHContract()
	describePorts()
	describeRoll()
	describeJupyter()
})

// DescribeEnvironment declares the container for one (image, identity): the
// cases below it share one environment, brought up once and taken down once.
//
// A Describe in a loop rather than a DescribeTable, because Ginkgo builds the
// whole spec tree before any spec runs and a table entry's body is a leaf — a
// BeforeAll cannot be declared there. Without a container of its own the
// environment would have to be rebuilt for every case, and every case is a
// question about that one environment.
func DescribeEnvironment(img devenv.Image, identity devenv.Identity) {
	Describe(fmt.Sprintf("%s as %s", img.Key, identity),
		Label(devenv.LabelImage(img.Key), devenv.LabelIdentity(identity)), Ordered,
		func() {
			var env *devenv.Environment

			// The case groups below are declared *now* and run later, and env is nil
			// until BeforeAll has filled it in. So they are handed this instead of the
			// pointer: a group that took the pointer itself would take nil, and every
			// case in it would dereference nothing. The closure reads the variable at
			// the moment the case runs, which is the moment it has a value.
			open := func() *devenv.Environment {
				GinkgoHelper()
				Expect(env).NotTo(BeNil(),
					"the environment is nil: BeforeAll has not run, which means this case ran without one")
				return env
			}

			BeforeAll(func(ctx SpecContext) {
				var err error
				env, err = conformance.BringUp(ctx, img, identity)
				if err != nil {
					// The dump rides on the failure because this is the one report a
					// broken environment gets: every case below is skipped with this
					// failure, so a reader who is not told here is not told at all.
					dump, cancel := dumpContext()
					defer cancel()
					Expect(err).NotTo(HaveOccurred(), "\n%s", env.Dump(dump))
				}
				// Recorded and not asserted here: nothing this suite can see knows
				// what `:latest` ought to resolve to, so the checkable claim is the
				// run-wide one the report makes. The read itself is asserted, though
				// — the pod demonstrably exists at this point, so an error is a
				// finding and not a "nothing to report".
				digest, err := env.PulledImageID(ctx)
				Expect(err).NotTo(HaveOccurred(), "reading the image %s actually ran", env.Name)
				conformance.RecordImage(img.Key, img.Ref(), digest)
			})

			AfterAll(func() {
				if env == nil {
					return
				}
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
				defer cancel()
				if err := env.TearDown(ctx); err != nil {
					_, _ = fmt.Fprintf(GinkgoWriter, "deleting %s: %v\n", env.Name, err)
				}
			})

			AfterEach(func() {
				// GinkgoWriter is printed for a failed spec, so this reaches the
				// report exactly when it is wanted and costs nothing when it is not.
				if env == nil || !CurrentSpecReport().Failed() {
					return
				}
				ctx, cancel := dumpContext()
				defer cancel()
				_, _ = fmt.Fprintln(GinkgoWriter, env.Dump(ctx))
			})

			describePublication(open, img)
			describeRefusals(open, img, identity)
			describeIdentity(open, img, identity)
			describeSessionEnvironment(open, img)
			describeAcceptedAsWritten(open)
			describeStack(open, img, identity)
			describeNotebookContract(open, img)
			describeStorage(open, img)
			describeGatewayPlumbing(open, img)
			describeEndpoints(open, img)
		})
}

// --- A. Bring-up and publication ----------------------------------------------

// describePublication is the gate every other case depends on: with A3 false, an
// "endpoint unreachable" result elsewhere is a publication failure rather than
// an image one. Every claim here is asserted and not waited for — the waiting is
// BringUp's, in BeforeAll, and it has already returned.
func describePublication(open func() *devenv.Environment, img devenv.Image) {
	It("A1 is Running with every condition true",
		Label(devenv.TierP0, devenv.LabelFamily("A")), func(ctx SpecContext) {
			env := open()
			Expect(env.Ready(ctx)).To(Succeed(), "the environment is no longer ready")
			Expect(env.Object().Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
			// Ready() reads the environment's own conditions; this reads the thing
			// they are about. A condition can only be as true as the process behind
			// it, and a pod that has just gone away has not yet been reconciled.
			Expect(env.PodRunning(ctx)).To(Succeed(), "the environment's pod")
		})

	It("A2 publishes exactly the endpoints its type implies",
		Label(devenv.TierP0, devenv.LabelFamily("A")), func(ctx SpecContext) {
			env := open()
			// A "ssh" environment gets no web endpoint at all, so this set is
			// decided by the type and not by whether the image could serve a
			// notebook: "does this environment serve HTTP" is a question about the
			// spec.
			expected := []string{devenv.SSHEndpointName}
			if img.ServesJupyter() {
				// The manifest enables ssh alongside the notebook, so a jupyter
				// environment publishes both.
				expected = append(expected, string(img.Type))
			}
			slices.Sort(expected)
			Expect(env.EndpointNames()).To(Equal(expected),
				"endpoints are how a user is told where to connect; a missing one is an unusable environment "+
					"and an extra one is an address that leads nowhere")
		})

	It("A3 has its ListenerSet accepted with its listener programmed",
		Label(devenv.TierP0, devenv.LabelFamily("A")), func(ctx SpecContext) {
			env := open()
			// A wait, not a re-read: both conditions are Envoy Gateway's, written
			// after the controller has already published the endpoint. A Gateway
			// that does not admit tenant ListenerSets leaves the environment
			// perfectly healthy with no listener programmed, which is why this is
			// the case that explains a whole run of transport failures.
			Eventually(func() error {
				ls, err := env.ListenerSet(ctx)
				if err != nil {
					return err
				}
				c := devenv.ListenerSetAccepted(ls)
				if c == nil || c.Status != "True" {
					return fmt.Errorf("ListenerSet %s is %s", ls.Name, devenv.ConditionSummary(c))
				}
				_, st, err := env.L4Listener(ctx, devenv.SSHEndpointName)
				if err != nil {
					return err
				}
				if c := devenv.ListenerProgrammed(st); c == nil || c.Status != "True" {
					return fmt.Errorf("listener %s is %s", st.Name, devenv.ConditionSummary(c))
				}
				return nil
			}).WithTimeout(2*time.Minute).WithPolling(5*time.Second).
				Should(Succeed(), "the environment's L4 listener")
		})

	It("A4 holds its ssh port inside the pool and keeps it across a reconcile",
		Label(devenv.TierP0, devenv.LabelFamily("A")), func(ctx SpecContext) {
			env := open()
			ep, ok := env.SSHEndpoint()
			Expect(ok).To(BeTrue(), "status published no ssh endpoint (has %v)", env.EndpointNames())
			port := ep.ListenerPort

			// The pool is the one the manager was started with, read from its own
			// flags by the preflight: a port inside a range nobody is allocating
			// from would be a coincidence, not a contract.
			Expect(port).To(BeNumerically(">=", cluster.L4Start),
				"the ssh port is below the pool %d-%d", cluster.L4Start, cluster.L4End)
			Expect(port).To(BeNumerically("<=", cluster.L4End),
				"the ssh port is above the pool %d-%d", cluster.L4Start, cluster.L4End)

			entry, _, err := env.L4Listener(ctx, devenv.SSHEndpointName)
			Expect(err).NotTo(HaveOccurred())
			Expect(entry.Port).To(Equal(port),
				"the published address names a port the environment's own ListenerSet does not declare")

			// A write to the object, which is what a user's edit is as far as the
			// controller's watch is concerned, and the only one that triggers a
			// reconcile without changing anything the reconcile would act on.
			const probe = "e2e.cubestack.io/reconcile-probe"
			Expect(env.Annotate(ctx, probe, time.Now().Format(time.RFC3339Nano))).To(Succeed())
			Eventually(func() string {
				if err := env.Refresh(ctx); err != nil {
					return ""
				}
				return env.Object().Annotations[probe]
			}).WithTimeout(time.Minute).WithPolling(2*time.Second).
				ShouldNot(BeEmpty(), "the annotation the reconcile was to be triggered by")

			// Bounded, because what is asserted is an absence: no reconcile may
			// move the port. The controller reads its allocation back from the
			// ListenerSet rather than drawing a new one, and a regression that drew
			// afresh would take the endpoint a user is already connected to down.
			Consistently(func() int32 {
				if err := env.Refresh(ctx); err != nil {
					return -1
				}
				if ep, ok := env.SSHEndpoint(); ok {
					return ep.ListenerPort
				}
				return -1
			}).WithTimeout(20*time.Second).WithPolling(2*time.Second).
				Should(Equal(port), "the ssh port moved while the environment was reconciled")
		})

	It("A5 has the Gateway's dataplane Service carrying the port",
		Label(devenv.TierP0, devenv.LabelFamily("A")), func(ctx SpecContext) {
			env := open()
			ep, ok := env.SSHEndpoint()
			Expect(ok).To(BeTrue(), "status published no ssh endpoint (has %v)", env.EndpointNames())

			// The step between the platform publishing an address and the address
			// answering: the ListenerSet declares the port, Envoy Gateway has to add
			// it to the Service the Gateway's address points at.
			Eventually(func() error {
				_, found, err := conformance.DataplanePort(ctx, ep.ListenerPort)
				if err != nil {
					return err
				}
				if !found {
					return fmt.Errorf("the dataplane Service publishes no port %d", ep.ListenerPort)
				}
				return nil
			}).WithTimeout(2*time.Minute).WithPolling(5*time.Second).Should(Succeed(),
				"the port the ssh endpoint names reaches the dataplane Service")
		})
}

// --- B. Negative / security ---------------------------------------------------

// describeRefusals asserts what each endpoint turns away. Every one of them is
// preceded by its own positive control, because "the server refused" and "the
// network dropped" are otherwise the same result.
func describeRefusals(open func() *devenv.Environment, img devenv.Image, identity devenv.Identity) {
	It("B1 refuses a Jupyter request with no token or a wrong one",
		Label(devenv.TierP0, devenv.LabelFamily("B")), func(ctx SpecContext) {
			env := open()
			if !img.ServesJupyter() {
				Skip("the image serves no notebook, so it has no token to withhold")
			}
			ep, ok := env.WebEndpoint()
			Expect(ok).To(BeTrue(), "status published no %q endpoint (has %v)", img.Type, env.EndpointNames())
			base, err := withTrailingSlash(ep.Address)
			Expect(err).NotTo(HaveOccurred())
			client := conformance.Dialer.HTTPClient()

			// The platform's own token is accepted first, so a refusal below is the
			// server refusing a credential and not the route being broken.
			token, err := env.JupyterToken(ctx)
			Expect(err).NotTo(HaveOccurred())
			Eventually(func() int {
				code, _, _ := get(ctx, client, base+"api/status?token="+token)
				return code
			}).WithTimeout(3*time.Minute).WithPolling(5*time.Second).
				Should(Equal(http.StatusOK), "api/status with the platform's token on %s", base)

			code, body, err := get(ctx, client, base+"api/status")
			Expect(err).NotTo(HaveOccurred())
			Expect(code).NotTo(Equal(http.StatusOK),
				"a notebook request with no token was served: %s", truncate(body))

			code, body, err = get(ctx, client, base+"api/status?token=not-the-platforms-token")
			Expect(err).NotTo(HaveOccurred())
			Expect(code).NotTo(Equal(http.StatusOK),
				"a notebook request with a wrong token was served: %s", truncate(body))
		})

	It("B2 serves nothing at the path without the environment's prefix",
		Label(devenv.TierP0, devenv.LabelFamily("B")), func(ctx SpecContext) {
			env := open()
			if !img.ServesJupyter() {
				Skip("the image serves no notebook, so it has no base_url to be rewritten")
			}
			ep, ok := env.WebEndpoint()
			Expect(ok).To(BeTrue(), "status published no %q endpoint (has %v)", img.Type, env.EndpointNames())
			token, err := env.JupyterToken(ctx)
			Expect(err).NotTo(HaveOccurred())
			root, err := endpointRoot(ep.Address)
			Expect(err).NotTo(HaveOccurred())

			// The same request the Jupyter case makes, with the platform's
			// /dev/<ns>/<env>/ prefix removed: it proves the notebook was told to
			// serve under that base_url, which reachability alone does not.
			client := conformance.Dialer.HTTPClient()
			code, body, err := get(ctx, client, root+"/api/status?token="+token)
			Expect(err).NotTo(HaveOccurred())
			Expect(code).To(Equal(http.StatusNotFound),
				"%s/api/status answered %d (%s); the notebook is served under %s, not at the listener's root",
				root, code, truncate(body), ep.Address)
		})

	It("B3 refuses a key the platform never minted",
		Label(devenv.TierP0, devenv.LabelFamily("B")), func(ctx SpecContext) {
			env := open()
			// The control first: the platform's own key logs in. Without it, an
			// sshd that was not listening yet would pass this case.
			sess := sshReady(ctx, env)
			foreign, err := devenv.NewClientKey()
			Expect(err).NotTo(HaveOccurred())

			_, err = conformance.Dialer.SSH(ctx, sess.Addr(), sess.User(), foreign, sess.HostKey(), "true")
			Expect(err).To(HaveOccurred(),
				"the server admitted a key it never minted, as %s on %s", sess.User(), sess.Addr())
		})

	It("B4 refuses the image's own account on a root environment",
		Label(devenv.TierP0, devenv.LabelFamily("B")), func(ctx SpecContext) {
			env := open()
			if identity != devenv.Root {
				Skip("this environment serves the image's own account, so there is no second account to refuse")
			}
			// Measured before it was asserted, on both families: with a container
			// running as root, sshd resolves to *two* AllowUsers lines — the image's
			// own account and root — and the platform's key sits at an absolute path
			// outside every home, so the account is not what refuses the login. The
			// shadow entry is: `useradd` without -p leaves a leading '!', and OpenSSH
			// refuses a locked account, but only once it can read /etc/shadow at all —
			// which only a root sshd can. A non-root sshd asks and gets nothing back
			// (getspnam returns nothing to uid 1000), so the check is one more thing
			// root mode turns on. The refusal is therefore the *account lock's* and not
			// the platform's, and it holds for both the self-authored `ubuntu` and
			// docker-stacks' `jovyan` because both are created by useradd. An image
			// that unlocked its account would be served here, into a home the workspace
			// claim does not cover in root mode; this case is what would say so.
			sess := sshReady(ctx, env)
			_, err := sess.RunAs(ctx, img.Account, "true")
			Expect(err).To(HaveOccurred(),
				"a root environment admitted %q (its own key, the image's account) on %s; the account it "+
					"serves is the one its address names", img.Account, sess.Addr())
		})

	It("B5 serves the host key the platform minted",
		Label(devenv.TierP0, devenv.LabelFamily("B")), func(ctx SpecContext) {
			env := open()
			sess := sshReady(ctx, env)
			presented, err := conformance.Dialer.SSHPresentedHostKey(ctx, sess.Addr())
			Expect(err).NotTo(HaveOccurred())
			// Asked without pinning, which is the point: every other case pins this
			// key, and a pin only means identity if the key it pins is the one the
			// server would present anyway. The image ships no host key of its own
			// (its Dockerfile removes the generated ones), so what answers with
			// this key is a server the platform configured.
			Expect(presented.Marshal()).To(Equal(sess.HostKey().Marshal()),
				"the key presented on %s is not the public half of %s",
				sess.Addr(), env.SSHHostKeySecretName())
		})
}

// --- C. Identity and workspace ------------------------------------------------

// describeIdentity asserts who the session is and where it can write. The
// identity axis is not a variant of the same code path: root changes which uid
// the container runs as, where the workspace mounts, and what the account's home
// is, so an assertion that holds for one says nothing about the other.
func describeIdentity(open func() *devenv.Environment, img devenv.Image, identity devenv.Identity) {
	It("C1 runs as the identity's uid and gid",
		Label(devenv.TierP0, devenv.LabelFamily("C")), func(ctx SpecContext) {
			env := open()
			wantUID, wantGID := strconv.FormatInt(img.UID, 10), strconv.FormatInt(img.GID, 10)
			if identity == devenv.Root {
				// The platform's own account, not the image's: a root environment
				// says only runAsUser 0 and the controller supplies the rest.
				wantUID, wantGID = "0", "0"
			}
			out := sshOutput(ctx, env, `printf '%s %s\n' "$(id -u)" "$(id -g)"`)
			Expect(strings.Fields(out)).To(Equal([]string{wantUID, wantGID}),
				"the session's uid:gid; %s is %s's own layout", img.Key, img.Account)
		})

	It("C2 gives the session the workspace as its home",
		Label(devenv.TierP0, devenv.LabelFamily("C")), func(ctx SpecContext) {
			env := open()
			workspace, err := env.WorkspaceMountPath(ctx)
			Expect(err).NotTo(HaveOccurred())
			// The mount is a claim and not an emptyDir: the same path backed by the
			// pod's own filesystem is writable and lost with the pod, so the path
			// alone does not make it a workspace.
			claim, err := env.WorkspaceClaim(ctx)
			Expect(err).NotTo(HaveOccurred())

			out := sshOutput(ctx, env, `printf '%s\n' "$HOME"`)
			Expect(strings.TrimSpace(out)).To(Equal(workspace),
				"the session's HOME is where %s mounts the claim %q", env.Name, claim)
		})

	It("C3 can write to the workspace",
		Label(devenv.TierP0, devenv.LabelFamily("C")), func(ctx SpecContext) {
			env := open()
			// The failure this catches is a home the process cannot write: a claim
			// owned by a uid the identity is not, which reads as a working
			// environment until the first thing anybody saves.
			const file = ".e2e-writable"
			out := sshOutput(ctx, env, `printf 'written\n' > "$HOME/`+file+`" && cat "$HOME/`+file+`"`)
			Expect(strings.TrimSpace(out)).To(Equal("written"))
		})

	It("C4 keeps the workspace across a restart and a stop/start",
		Label(devenv.TierP0, devenv.LabelFamily("C")), func(ctx SpecContext) {
			env := open()
			const file = ".e2e-durable"
			write := `printf 'kept\n' > "$HOME/` + file + `" && cat "$HOME/` + file + `"`
			read := `cat "$HOME/` + file + `"`
			Expect(strings.TrimSpace(sshOutput(ctx, env, write))).To(Equal("kept"))

			before, err := env.PodUID(ctx)
			Expect(err).NotTo(HaveOccurred())
			Expect(env.RestartPod(ctx)).To(Succeed())

			// The uid and not the name: a StatefulSet replaces the pod under the
			// same name, so "there is a pod" is true throughout the restart and
			// only the identity changes.
			Eventually(func() string {
				uid, err := env.PodUID(ctx)
				if err != nil {
					return ""
				}
				return string(uid)
			}).WithTimeout(5*time.Minute).WithPolling(5*time.Second).
				Should(And(Not(BeEmpty()), Not(Equal(string(before)))), "the pod was replaced")
			Eventually(func() error { return env.Ready(ctx) }).
				WithTimeout(devenv.UpTimeout()).WithPolling(10*time.Second).
				Should(Succeed(), "the environment came back after the restart")
			Expect(strings.TrimSpace(sshOutput(ctx, env, read))).To(Equal("kept"),
				"the file written before the restart")

			// And again across the user-facing stop/start, which is the other way
			// the workload goes away and comes back.
			Expect(env.SetRunning(ctx, false)).To(Succeed())
			Eventually(func() error { return env.Stopped(ctx) }).
				WithTimeout(5*time.Minute).WithPolling(5*time.Second).
				Should(Succeed(), "the environment stopped")
			Expect(env.SetRunning(ctx, true)).To(Succeed())
			Eventually(func() error { return env.Ready(ctx) }).
				WithTimeout(devenv.UpTimeout()).WithPolling(10*time.Second).
				Should(Succeed(), "the environment restarted")
			Expect(strings.TrimSpace(sshOutput(ctx, env, read))).To(Equal("kept"),
				"the file written before the stop/start")
		})

	It("C5 mounts the workspace at the root account's home",
		Label(devenv.TierP0, devenv.LabelFamily("C")), func(ctx SpecContext) {
			env := open()
			if identity != devenv.Root {
				Skip("a non-root environment mounts at the image's own home, which C2 asserts")
			}
			workspace, err := env.WorkspaceMountPath(ctx)
			Expect(err).NotTo(HaveOccurred())
			Expect(workspace).To(Equal("/root"),
				"a root environment's workspace is the root account's home; %s bakes %s for %s",
				img.Key, img.Home, img.Account)
			out := sshOutput(ctx, env, `printf '%s\n' "$HOME"`)
			Expect(strings.TrimSpace(out)).To(Equal("/root"))
		})
}

// --- D. Mode separation -------------------------------------------------------

// describeSessionEnvironment asserts that the two modes stay apart and that a
// session sees the image rather than a shell beside it. The type decides which
// server runs, and the sshd drop-in decides what a session inherits — both are
// places where one image's answer is wrong for another's.
func describeSessionEnvironment(open func() *devenv.Environment, img devenv.Image) {
	It("D1 runs no notebook server",
		Label(devenv.TierP0, devenv.LabelFamily("D")), func(ctx SpecContext) {
			env := open()
			if img.ServesJupyter() {
				Skip("this image serves a notebook")
			}
			Expect(strings.TrimSpace(sshOutput(ctx, env, listenProbe(devenv.ContainerJupyterPort)))).
				To(Equal("closed"), "a %s environment runs sshd alone", img.Type)
		})

	It("D2 serves both the notebook and sshd",
		Label(devenv.TierP0, devenv.LabelFamily("D")), func(ctx SpecContext) {
			env := open()
			if !img.ServesJupyter() {
				Skip("this image serves no notebook")
			}
			Expect(strings.TrimSpace(sshOutput(ctx, env, listenProbe(devenv.ContainerJupyterPort)))).
				To(Equal("open"), "the notebook server")
			Expect(strings.TrimSpace(sshOutput(ctx, env, listenProbe(devenv.ContainerSSHPort)))).
				To(Equal("open"), "the sshd the session is already running on")
		})

	It("D3 carries the image's own environment into the session",
		Label(devenv.TierP0, devenv.LabelFamily("D")), func(ctx SpecContext) {
			env := open()
			sess := sshReady(ctx, env)
			// The names come from the image's own drop-in rather than from a list
			// here: which variables an image needs is its own answer, and a copy of
			// that list in this repository goes stale the first time one changes.
			names, err := sess.SetEnvNames(ctx)
			Expect(err).NotTo(HaveOccurred())
			Expect(names).To(ContainElement("PATH"),
				"the drop-in must name PATH: sshd replaces the session environment with a PATH compiled "+
					"into sshd itself, and a session that gets that one cannot reach the image's stack")

			container, err := sess.ContainerEnv(ctx)
			Expect(err).NotTo(HaveOccurred())
			session, err := sess.SessionEnv(ctx)
			Expect(err).NotTo(HaveOccurred())

			// Variable by variable, and against the container's own environment
			// rather than the pod spec's: what is under test is that the drop-in
			// carries the value the image runs with, and SetEnv *replaces* rather
			// than extends, so one name too few strips that variable from every
			// session silently.
			for _, name := range names {
				want, ok := container[name]
				Expect(ok).To(BeTrue(), "the drop-in names %s, which the container does not set", name)
				Expect(session).To(HaveKeyWithValue(name, want),
					"%s reaches the session with the value the container runs with", name)
			}
		})

	It("D4 resolves the image's own stack on the session PATH",
		Label(devenv.TierP0, devenv.LabelFamily("D")), func(ctx SpecContext) {
			env := open()
			if img.Stack.Name == "" {
				Skip("the image is a base system with no stack to resolve")
			}
			// Run and not merely found: a stack that is on the PATH by path but
			// broken — the wrong interpreter, a torch built for another vendor —
			// only shows up when the session tries to use it.
			res, err := sshReady(ctx, env).Run(ctx, img.Stack.Command)
			Expect(err).NotTo(HaveOccurred())
			Expect(res.ExitCode).To(Equal(0),
				"%s does not work in a session: %s", img.Stack.Name, strings.TrimSpace(res.Stderr))
			Expect(strings.TrimSpace(res.Stdout)).NotTo(BeEmpty(),
				"%s answered with nothing", img.Stack.Name)
		})
}

// --- E. The Accepted condition, from the accepted side ------------------------

// describeAcceptedAsWritten is E8: every environment the matrix brings up is a
// spec the controller applied as written, which is the claim Accepted=True with
// reason Accepted makes.
//
// It rides on the matrix rather than sitting with the rest of family E, because
// "a spec the catalogue builds" is exactly what the matrix is, and one instance
// per environment is worth more than one instance somewhere else: a finding the
// controller grew for a field the catalogue sets would otherwise pass family E
// while failing every real environment.
//
// The reason is the assertion and the message is not. The reason is the
// contract's vocabulary — Overridden is the other answer, and telling the two
// apart is the whole of it — while the message is the controller's prose, and a
// suite that pinned the wording would report a copy change as a conformance
// failure.
func describeAcceptedAsWritten(open func() *devenv.Environment) {
	It("E8 reports every spec field applied as written",
		Label(devenv.TierP0, devenv.LabelFamily("E")), func(ctx SpecContext) {
			env := open()
			c := env.Condition(aiv1alpha1.ConditionAccepted)
			Expect(c).NotTo(BeNil(), "the controller recorded no Accepted condition on a running environment")
			Expect(c.Status).To(Equal(metav1.ConditionTrue),
				"the catalogue's own manifest was refused: %s", c.Message)
			Expect(c.Reason).To(Equal(devenv.ReasonAccepted),
				"the controller resolved part of a spec the catalogue wrote to be applied as it stands: %s",
				c.Message)
			Expect(c.Message).NotTo(BeEmpty(), "an Accepted condition with nothing to say")
		})
}

// --- §3. The endpoint matrix --------------------------------------------------

// describeEndpoints is §3: the ask these cases exist for, one environment per
// (image, identity) asserted on each endpoint its type publishes.
//
// The family label is "matrix" and not the §3 row's own letter, because §4 uses
// J and S for other families: the ids M-J* and M-S* are §3's rows, and the
// document reuses J1 and S1 for §4's families J and S.
func describeEndpoints(open func() *devenv.Environment, img devenv.Image) {
	It("M-J1 serves Jupyter over the Gateway with the platform's own token",
		Label(devenv.TierP0, devenv.LabelFamily("matrix")), func(ctx SpecContext) {
			env := open()
			if !img.ServesJupyter() {
				Skip("the image serves no notebook, so it has no web endpoint to assert")
			}
			ep, ok := env.WebEndpoint()
			Expect(ok).To(BeTrue(), "status published no %q endpoint (has %v)", img.Type, env.EndpointNames())

			// The token is the platform's, not one the case chose: the point is
			// that the credential a user is handed is the credential that works.
			token, err := env.JupyterToken(ctx)
			Expect(err).NotTo(HaveOccurred())

			client := conformance.Dialer.HTTPClient()
			base, err := withTrailingSlash(ep.Address)
			Expect(err).NotTo(HaveOccurred())

			code, body, err := get(ctx, client, base+"api/status?token="+token)
			Expect(err).NotTo(HaveOccurred())
			Expect(code).To(Equal(http.StatusOK),
				"/api/status with the platform's token on %s said %d", base, code)
			Expect(body).To(ContainSubstring(`"started"`),
				"/api/status answered %d but not with a server status: %s", code, truncate(body))

			// The Lab itself, which is what the address is advertised for. A
			// launched-but-unsynchronised notebook answers the API before it
			// serves the page, so this is given room to arrive.
			Eventually(func() string {
				_, body, err := get(ctx, client, base+"?token="+token)
				if err != nil {
					return err.Error()
				}
				return body
			}).WithTimeout(3*time.Minute).WithPolling(5*time.Second).
				Should(ContainSubstring("jupyter-config-data"), "the Lab page served through the Gateway")
		})

	It("M-S1 admits the platform's key as the account its address names",
		Label(devenv.TierP0, devenv.LabelFamily("matrix")), func(ctx SpecContext) {
			env := open()
			// Where the platform put the workspace, read from the pod it made.
			// HOME is the controller's statement that this is where the claim is;
			// a session whose HOME is somewhere else is a session that cannot
			// write, which is the failure the identity axis exists to catch.
			workspace, err := env.WorkspaceMountPath(ctx)
			Expect(err).NotTo(HaveOccurred())

			sess := sshReady(ctx, env)
			// shellcheck-style quoting is the far side's problem, not this one's:
			// $(id -un) and $HOME are meant for the remote shell.
			const probe = `printf 'account=%s home=%s\n' "$(id -un)" "$HOME"`

			var last devenv.SSHResult
			Eventually(func() string {
				res, err := sess.Run(ctx, probe)
				last = res
				if err != nil {
					return err.Error()
				}
				return res.Stdout
			}).WithTimeout(3*time.Minute).WithPolling(5*time.Second).
				Should(ContainSubstring("account="+sess.User()+" "),
					"a key-auth login as the account the address names (stderr: %s)", last.Stderr)

			Expect(last.ExitCode).To(Equal(0), "the probe exited %d (stderr: %s)", last.ExitCode, last.Stderr)
			Expect(last.Stdout).To(ContainSubstring("home="+workspace+"\n"),
				"the session's HOME is the workspace the platform mounted at %s", workspace)
		})
}

// --- session helpers ----------------------------------------------------------

// sshReady returns a session once one can be established.
//
// Later than the environment being Ready, and not by a defect: the platform
// publishes the endpoint as soon as Envoy Gateway programs the listener, and the
// sshd behind it is the image's to start. So a session that cannot be
// established is retried rather than reported — and establishing one is all this
// waits for, because what the command prints is the case's own business.
func sshReady(ctx SpecContext, env *devenv.Environment) *devenv.Session {
	GinkgoHelper()
	sess, err := env.Open(ctx)
	Expect(err).NotTo(HaveOccurred(), "the platform's own ssh material is not readable")
	Eventually(func() error { return sess.Ping(ctx) }).
		WithTimeout(3*time.Minute).WithPolling(5*time.Second).
		Should(Succeed(), "an ssh session on %s", env.Name)
	return sess
}

// sshReadyWithKey is sshReady for an environment the platform minted no login
// key for, where the session is the caller's own key against the platform's
// address and host key.
//
// No ping: what the case checks is which keys log in, and pinging first would
// answer that question with the wrong key.
func sshReadyWithKey(ctx SpecContext, env *devenv.Environment, key ssh.Signer) *devenv.Session {
	GinkgoHelper()
	sess, err := env.OpenWithKey(ctx, key)
	Expect(err).NotTo(HaveOccurred(), "%s publishes no address to log in to", env.Name)
	return sess
}

// sshRun runs one command in a session that has been established.
func sshRun(ctx SpecContext, env *devenv.Environment, command string) devenv.SSHResult {
	GinkgoHelper()
	res, err := sshReady(ctx, env).Run(ctx, command)
	Expect(err).NotTo(HaveOccurred())
	return res
}

// sshOutput runs a command and fails unless it exited 0.
func sshOutput(ctx SpecContext, env *devenv.Environment, command string) string {
	GinkgoHelper()
	res := sshRun(ctx, env, command)
	Expect(res.ExitCode).To(Equal(0),
		"%q exited %d (stderr: %s)", command, res.ExitCode, strings.TrimSpace(res.Stderr))
	return res.Stdout
}

// listenProbe reports whether something inside the container is accepting
// connections on a port.
//
// bash's /dev/tcp rather than ss or nc: these images are Ubuntu with a bash
// login shell, and neither iproute2 nor netcat is in a base image for certain.
// The subshell is what keeps a refused connection from taking the session with
// it.
func listenProbe(port int) string {
	return fmt.Sprintf(
		`if (exec 3<>/dev/tcp/127.0.0.1/%d) 2>/dev/null; then echo open; else echo closed; fi`, port)
}

// --- small helpers ------------------------------------------------------------

// dumpContext bounds a dump taken outside a spec, where there is no SpecContext
// to carry a deadline.
func dumpContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 30*time.Second)
}

// withTrailingSlash normalises an endpoint address so a path can be appended
// without assuming whether the platform wrote the separator.
func withTrailingSlash(address string) (string, error) {
	if address == "" {
		return "", fmt.Errorf("empty endpoint address")
	}
	if strings.HasSuffix(address, "/") {
		return address, nil
	}
	return address + "/", nil
}

// endpointRoot is an endpoint's origin, with the platform's path prefix removed:
// http://host:port out of http://host:port/dev/<ns>/<env>/.
func endpointRoot(address string) (string, error) {
	u, err := url.Parse(address)
	if err != nil {
		return "", fmt.Errorf("parsing %q: %w", address, err)
	}
	if u.Host == "" {
		return "", fmt.Errorf("address %q names no host", address)
	}
	return u.Scheme + "://" + u.Host, nil
}

// get performs one request and returns its status and body. A non-2xx is a
// result, not an error: the status is what most of these assertions are about.
func get(ctx context.Context, client *http.Client, url string) (int, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, "", err
	}
	return resp.StatusCode, string(body), nil
}

// truncate keeps a failure message readable when the far side answered with a
// whole page.
func truncate(s string) string {
	const max = 400
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
