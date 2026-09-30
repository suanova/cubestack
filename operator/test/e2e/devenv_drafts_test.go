//go:build e2e
// +build e2e

package e2e

import (
	"context"
	"fmt"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/test/e2e/devenv"
)

// One case's own environment, which is the shape every family that is not the
// §3 matrix takes.
//
// The matrix's environments are the catalogue's: one per (image, identity),
// brought up once by DescribeEnvironment and shared by every case on them. A
// case about a spec the catalogue would never build — refused, resolved, or
// shaped to exercise one field — cannot ride those, because its environment is
// the thing under test rather than the setting for it.
//
// So it declares one: the (image, identity) to start from, anything the case
// needs in the cluster before the environment exists, the change to the manifest,
// and the assertions. BeforeAll creates it, AfterAll removes it, and the cases in
// between share it. Ginkgo's Ordered is what makes "share it" true — the cases
// run in declaration order, and when one fails the rest of that container is
// skipped rather than run against an environment in a state the case did not
// expect.
type draftCase struct {
	// Name is the environment's name and the Describe's text.
	Name     string
	Image    devenv.Image
	Identity devenv.Identity

	// Namespace is where it lives, defaulting to the run's. Set only when the
	// namespace is part of what the case is about.
	Namespace string

	// Prepare runs before the environment is created, for the cases whose subject
	// is something in the cluster beside the environment: a Secret to delegate to,
	// a claim to mount, a namespace to be distinct from. It is a separate step
	// because a spec is a description, and what a test has to make is an object.
	Prepare func(ctx context.Context) error

	// Shape is applied to the catalogue's manifest before the environment is
	// created — the spec the case is about.
	Shape func(*aiv1alpha1.DevEnvironment)

	// Cases declares the assertions, each handed a getter for the environment.
	Cases func(open func() *devenv.Environment)
}

// declare builds the container: the environment is created once in BeforeAll and
// removed once in AfterAll, so the cases above it share one.
func (d draftCase) declare() {
	Describe(d.Name, Ordered, func() {
		var env *devenv.Environment

		// The case groups are declared now and run later, and env is nil until
		// BeforeAll has filled it in, so they are handed this rather than the
		// pointer — a group that took the pointer itself would take nil.
		open := func() *devenv.Environment {
			GinkgoHelper()
			Expect(env).NotTo(BeNil(),
				"the environment is nil: BeforeAll has not run, which means this case ran without one")
			return env
		}

		BeforeAll(func(ctx SpecContext) {
			env = conformance.DraftIn(d.Namespace, d.Name, d.Image, d.Identity)
			if d.Prepare != nil {
				if err := d.Prepare(ctx); err != nil {
					Expect(err).NotTo(HaveOccurred(), "preparing the cluster for %s", d.Name)
				}
			}
			if err := env.Apply(ctx, d.Shape); err != nil {
				dump, cancel := dumpContext()
				defer cancel()
				Expect(err).NotTo(HaveOccurred(), "\n%s", env.Dump(dump))
			}
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
			if env == nil || !CurrentSpecReport().Failed() {
				return
			}
			ctx, cancel := dumpContext()
			defer cancel()
			_, _ = fmt.Fprintln(GinkgoWriter, env.Dump(ctx))
		})

		d.Cases(open)
	})
}

// --- readers shared by the families -------------------------------------------

// containerEnv is the main container's declared environment, by name.
//
// The pod spec and not the running container's /proc: what is under test is what
// the controller rendered, and a container that never started has no /proc to
// read.
func containerEnv(pod *corev1.Pod) map[string]string {
	out := map[string]string{}
	for _, c := range pod.Spec.Containers {
		for _, v := range c.Env {
			out[v.Name] = v.Value
		}
	}
	return out
}

// podCondition is one of the pod's conditions, or nil when the kubelet has not
// recorded it.
func podCondition(pod *corev1.Pod, t corev1.PodConditionType) *corev1.PodCondition {
	for i := range pod.Status.Conditions {
		if pod.Status.Conditions[i].Type == t {
			return &pod.Status.Conditions[i]
		}
	}
	return nil
}

// podNames renders the pods an absence assertion found, so the failure says what
// was there instead of only that something was.
func podNames(pods []corev1.Pod) string {
	if len(pods) == 0 {
		return "(none)"
	}
	names := make([]string, 0, len(pods))
	for _, p := range pods {
		names = append(names, p.Name)
	}
	return strings.Join(names, ", ")
}
