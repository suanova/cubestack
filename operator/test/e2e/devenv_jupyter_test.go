//go:build e2e
// +build e2e

package e2e

import (
	"net/http"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/test/e2e/devenv"
)

// Family J: the Jupyter contract (§4.J).
//
// These are the notebook's own promises, as opposed to the platform's: that the
// directory a user's files are in is the directory the notebook serves, that the
// credential the platform publishes is the one the server demands, and that the
// flags a user put in NOTEBOOK_ARGS are still there after the controller has
// merged its own into the same variable.
//
// The first rides the matrix, because the question is about every environment
// that serves a notebook and the matrix already brings them all up. The other
// two need an environment whose state changes under the case, or one carrying a
// spec the catalogue would never write, so each drafts its own.

// describeNotebookContract declares J1 for one environment.
func describeNotebookContract(open func() *devenv.Environment, img devenv.Image) {
	It("J1 serves the workspace as the notebook's root directory",
		Label(devenv.TierP1, devenv.LabelFamily("J")), func(ctx SpecContext) {
			env := open()
			if !img.ServesJupyter() {
				Skip("the image serves no notebook, so it has no root directory to assert")
			}

			// Written over ssh and read back through the notebook, which is the
			// whole finding: a user's work has to be visible in both, and a notebook
			// rooted somewhere other than the home the platform mounted answers 404
			// for a file that is plainly in $HOME. Nothing about the server's own
			// flags can distinguish "serves the workspace" from "serves a directory
			// that happens to be empty".
			const name = "e2e-notebook-root"
			sshOutput(ctx, env, `printf '%s' `+notebookRootMarker+` > "$HOME/`+name+`"`)

			ep, ok := env.WebEndpoint()
			Expect(ok).To(BeTrue(), "status published no %q endpoint (has %v)", img.Type, env.EndpointNames())
			token, err := env.JupyterToken(ctx)
			Expect(err).NotTo(HaveOccurred())
			base, err := withTrailingSlash(ep.Address)
			Expect(err).NotTo(HaveOccurred())

			code, body, err := get(ctx, conformance.Dialer.HTTPClient(),
				base+"api/contents/"+name+"?token="+token)
			Expect(err).NotTo(HaveOccurred())
			Expect(code).To(Equal(http.StatusOK),
				"the notebook on %s answered %d for a file written to $HOME, so the directory it "+
					"serves is not the workspace: %s", base, code, truncate(body))
			Expect(body).To(ContainSubstring(notebookRootMarker),
				"the notebook answered with a file whose contents are not what was written")
		})
}

const notebookRootMarker = "e2e-notebook-root-marker"

// describeJupyter declares J2 and J3, each on its own environment.
func describeJupyter() {
	describeTokenRefill()
	describeNotebookArgs()
}

// describeTokenRefill is J2: losing the token and asking for another.
func describeTokenRefill() {
	draftCase{
		Name:     "jupyter-token-refill",
		Image:    devenv.MustImage("jupyter-minimal"),
		Identity: devenv.NonRoot,
		Cases: func(open func() *devenv.Environment) {
			It("J2 rolls the workload onto the refilled token, and the new token is the one served",
				Label(devenv.TierP1, devenv.LabelFamily("J")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					ep, ok := env.WebEndpoint()
					Expect(ok).To(BeTrue(), "status published no web endpoint (has %v)", env.EndpointNames())
					base, err := withTrailingSlash(ep.Address)
					Expect(err).NotTo(HaveOccurred())
					client := conformance.Dialer.HTTPClient()

					before, err := env.JupyterToken(ctx)
					Expect(err).NotTo(HaveOccurred())
					uidBefore, err := env.PodUID(ctx)
					Expect(err).NotTo(HaveOccurred())
					// The positive control: the token the platform published is the
					// one this server demands, so a refusal below is about the
					// credential and not about the server.
					code, _, err := get(ctx, client, base+"api/status?token="+before)
					Expect(err).NotTo(HaveOccurred())
					Expect(code).To(Equal(http.StatusOK),
						"the published token does not open the notebook before the refill")

					Expect(env.EmptyJupyterToken(ctx)).To(Succeed())

					// The workload rolls. A token the running server has not read is
					// not a token it serves, so the platform cannot leave the pod
					// alone — which is the claim, and it is made against the pod's own
					// identity rather than against a restart count or an annotation. A
					// pod that is briefly absent polls as an error and is retried
					// rather than read as a new pod.
					Eventually(func() (string, error) {
						uid, err := env.PodUID(ctx)
						return string(uid), err
					}).WithTimeout(5*time.Minute).WithPolling(3*time.Second).
						ShouldNot(Equal(string(uidBefore)),
							"the environment was not rolled onto the token it minted to replace the one "+
								"that was emptied, so the server is still demanding the old one")

					running(ctx, env)

					after, err := env.JupyterToken(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(after).NotTo(Equal(before), "the refilled token is the one that was emptied")

					// Served at the endpoint, not merely written into the Secret.
					code, _, err = get(ctx, client, base+"api/status?token="+after)
					Expect(err).NotTo(HaveOccurred())
					Expect(code).To(Equal(http.StatusOK), "the refilled token does not open the notebook")

					code, body, err := get(ctx, client, base+"api/status?token="+before)
					Expect(err).NotTo(HaveOccurred())
					Expect(code).NotTo(Equal(http.StatusOK),
						"the token the platform replaced still opens the notebook: %s", truncate(body))
				})
		},
	}.declare()
}

// describeNotebookArgs is J3: the positive half of E7.
//
// E7 asserts on the Accepted condition that the controller kept every flag but
// its own. This asserts the same environment at the endpoint, which is the half
// a user experiences: a flag that survives into the variable but not into the
// server is a flag that was not applied, and the condition cannot tell the
// difference.
func describeNotebookArgs() {
	// A flag whose effect is readable through the notebook's own API. Terminals
	// are on by default, so `api/terminals` answers 200 on an untouched
	// environment — the matrix's jupyter entries, which this suite also runs —
	// and stops answering at all when the trait is off. It is deliberately a trait
	// rather than a log level or a limit: what is asserted has to be something the
	// server did, not something it recorded about itself.
	const flag = "--ServerApp.terminals_enabled=False"

	draftCase{
		Name:     "jupyter-notebook-args",
		Image:    devenv.MustImage("jupyter-minimal"),
		Identity: devenv.NonRoot,
		Shape: func(want *aiv1alpha1.DevEnvironment) {
			want.Spec.Runtime.Env = append(want.Spec.Runtime.Env, corev1.EnvVar{
				Name:  devenv.EnvNotebookArgs,
				Value: flag,
			})
		},
		Cases: func(open func() *devenv.Environment) {
			It("J3 applies the user's NOTEBOOK_ARGS alongside the base_url it owns",
				Label(devenv.TierP1, devenv.LabelFamily("J")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					// The two halves of one variable, asserted separately because
					// they fail separately: the controller merges its base_url into
					// NOTEBOOK_ARGS, and a merge that replaced the entry rather than
					// extending it would leave the endpoint working and the user's
					// flag gone.
					pod, err := env.Pod(ctx)
					Expect(err).NotTo(HaveOccurred())
					args := containerEnv(pod)[devenv.EnvNotebookArgs]
					Expect(args).To(ContainSubstring(flag),
						"the container's %s is %q, and the flag the spec declared is not in it",
						devenv.EnvNotebookArgs, args)

					ep, ok := env.WebEndpoint()
					Expect(ok).To(BeTrue(), "status published no web endpoint (has %v)", env.EndpointNames())
					token, err := env.JupyterToken(ctx)
					Expect(err).NotTo(HaveOccurred())
					base, err := withTrailingSlash(ep.Address)
					Expect(err).NotTo(HaveOccurred())
					client := conformance.Dialer.HTTPClient()

					// The control for the refusal below: the server is up and serving
					// the prefix the route publishes, so the difference is the flag and
					// not a notebook that never started. This is also the platform's
					// half of the merge — its base_url is in effect at the address a
					// user was given.
					code, body, err := get(ctx, client, base+"api/status?token="+token)
					Expect(err).NotTo(HaveOccurred())
					Expect(code).To(Equal(http.StatusOK),
						"the notebook does not answer under the base_url the platform published: %s",
						truncate(body))

					// The user's half, at the server rather than in the variable.
					code, body, err = get(ctx, client, base+"api/terminals?token="+token)
					Expect(err).NotTo(HaveOccurred())
					Expect(code).NotTo(Equal(http.StatusOK),
						"the notebook still serves terminals, so %s did not reach the server: %s",
						strings.TrimSpace(flag), truncate(body))
				})
		},
	}.declare()
}
