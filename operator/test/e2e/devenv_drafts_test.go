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

	// Available reports why the cluster cannot serve this case, and "" when it
	// can: a GPU, an RDMA fabric, or nothing at all to ask about, which is the
	// common case and what nil means.
	//
	// When it reports a reason nothing is created and every case that calls
	// open() is skipped with it. That is the whole point: the alternative is an
	// environment whose pod can never be scheduled, sitting Pending in a cluster
	// somebody else owns and reporting the cluster's hardware rather than the
	// platform's behaviour.
	//
	// The reason comes back with the decision rather than sitting in a field
	// beside it, because what a skip has to say — which device is missing, and
	// whether it is missing or merely unreadable — is known here and nowhere
	// else.
	Available func(ctx context.Context) string

	// Cases declares the assertions, each handed a getter for the environment.
	Cases func(open func() *devenv.Environment)
}

// declare builds the container: the environment is created once in BeforeAll and
// removed once in AfterAll, so the cases above it share one.
func (d draftCase) declare() {
	Describe(d.Name, Ordered, func() {
		var env *devenv.Environment

		// gateOut is Available's reason, when it gave one. Held here so that the
		// skip happens in a case's own body — where Ginkgo expects a Skip — rather
		// than in BeforeAll, and the environment is never created at all.
		var gateOut string

		// The case groups are declared now and run later, and env is nil until
		// BeforeAll has filled it in, so they are handed this rather than the
		// pointer — a group that took the pointer itself would take nil.
		open := func() *devenv.Environment {
			GinkgoHelper()
			if gateOut != "" {
				Skip(gateOut)
			}
			Expect(env).NotTo(BeNil(),
				"the environment is nil: BeforeAll has not run, which means this case ran without one")
			return env
		}

		BeforeAll(func(ctx SpecContext) {
			if d.Available != nil {
				if why := d.Available(ctx); why != "" {
					gateOut = why
					return
				}
			}
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

// assertPodAllocated asserts the container was rendered both asking for and
// limiting the device's extended resource — the thing that makes the scheduler
// choose a node that has one, and the device plugin hand one over.
//
// Both halves, because the controller writes both and each does a different job:
// the request is what the scheduler reads when it picks a node, the limit is
// what the device plugin allocates against. A case checking one half would pass
// on a pod the other half leaves broken.
//
// The count is asserted as well as the name. A pod that asks for one device on a
// cluster whose node advertises four is not the case that was written, and a
// silent 1-vs-4 would hide a request the spec never made.
func assertPodAllocated(pod *corev1.Pod, device corev1.ResourceName, want int64) {
	GinkgoHelper()
	Expect(pod.Spec.Containers).NotTo(BeEmpty(),
		"the pod renders no container that could take a device")
	container := pod.Spec.Containers[0]

	for _, half := range []struct {
		what string
		list corev1.ResourceList
	}{
		{"requests", container.Resources.Requests},
		{"limits", container.Resources.Limits},
	} {
		q, ok := half.list[device]
		Expect(ok).To(BeTrue(),
			"the container's %s do not name %s, so the device was never asked for: %v",
			half.what, device, half.list)
		Expect(q.Value()).To(Equal(want),
			"the container's %s ask for %d of %s, not %d",
			half.what, q.Value(), device, want)
	}
}

// assertPodNotAllocated asserts the container was rendered asking for none of
// the device's extended resource.
//
// The premise of a case about a device's absence, and checked on the rendered pod
// rather than on the spec it came from: what such a case has to rule out is the
// platform handing over something the spec never asked for, and the pod is where
// that would show.
//
// Both halves, for the reason assertPodAllocated checks both: a request and a
// limit are written separately, and either one on its own is a device the
// environment did not ask for.
func assertPodNotAllocated(pod *corev1.Pod, device corev1.ResourceName) {
	GinkgoHelper()
	Expect(pod.Spec.Containers).NotTo(BeEmpty(),
		"the pod renders no container, so nothing was asked for anything either way")
	container := pod.Spec.Containers[0]

	for _, half := range []struct {
		what string
		list corev1.ResourceList
	}{
		{"requests", container.Resources.Requests},
		{"limits", container.Resources.Limits},
	} {
		_, ok := half.list[device]
		Expect(ok).To(BeFalse(),
			"the container's %s name %s, in an environment whose spec asks for no GPU: %v",
			half.what, device, half.list)
	}
}

// deviceCapacity is what the cluster advertises, and the answer to the only
// question a device case can ask before it creates anything. Filled in by
// probeDevices from each device family's BeforeAll.
var deviceCapacity map[corev1.ResourceName]int64

// probeDevices reads what the cluster advertises.
//
// The query behind it is memoized on the suite, so a run that enters two device
// families still asks the cluster once, and a run that enters none pays nothing:
// nothing here is in BeforeSuite, so the first device family to run is what makes
// the query happen at all.
//
// A cluster that cannot be asked fails the run rather than skipping it. "There is
// no GPU here" and "I cannot tell whether there is a GPU here" are different
// answers, and only the first one means a case should stand down — the second is
// a suite that cannot see the cluster it was pointed at.
func probeDevices(ctx SpecContext) {
	GinkgoHelper()
	capacity, err := conformance.DeviceCapacity(ctx)
	Expect(err).NotTo(HaveOccurred(),
		"reading what the cluster advertises, which is how a device case knows whether it can run at all")
	deviceCapacity = capacity
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
