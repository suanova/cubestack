//go:build e2e
// +build e2e

package e2e

import (
	"context"
	"fmt"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/test/e2e/devenv"
)

// Family O: RDMA.
//
// `spec.network` is the one field of the API with no e2e case at all, and the
// contract it carries is small enough to state: an environment that asks for a
// fabric runs when a node advertises it, and waits when none does. That is what
// these cases check — one per fabric, gated on the fabric being present, and one
// more per fabric gated on it being absent.
//
// What they deliberately do not check is how the fabric is attached. The type's
// own godoc reserves the mechanism — "how that device is attached to the
// environment, and what else it takes, is the platform's to arrange" — and the
// chart's README names the replacement it has in mind. So `hostNetwork`,
// `dnsPolicy`, the container's host ports and the `IPC_LOCK` capability are all
// absent from every assertion below, even though today's delivery sets them:
// they are the delivery, and the unit tier already pins them
// (`devenvironment_controller_test.go`, the rdmaResource cases). An e2e case that
// asserted them would fail the day the platform changed how it delivers what it
// promised, which is the opposite of what a conformance case is for.
//
// Reading the manager's flags to find out which resource this cluster's fabric
// advertises is not the same thing: that is asking the cluster about itself, not
// claiming the environment looks a particular way.
//
// One precondition beyond the device is worth naming, because it holds by default
// rather than by anything these cases do. RDMA needs IPC_LOCK, which the Baseline
// Pod Security Standard does not allow, so the namespace has to admit the
// privileged standard — the type's own godoc says as much, for either fabric. The
// suite's namespace (devenv.Suite.PrepareNamespace) carries no enforce label, so
// nothing is rejected today. Were that ever to change, both environments would be
// refused at admission and the failure would read as a device that was never
// asked for, which is a confusing way to learn it.
//
// Not written yet: a case that the fabric is *usable* — that a port is up and a
// queue pair can be brought up — as opposed to merely allocated. What it would
// read is a probe on the stock Ubuntu image, and the two candidates (the sysfs
// port state, the verbs tools) need a sample from a node that has a fabric to fix
// the parse against, which this repository does not carry. Writing it from a
// guess would be a case that fails for reasons of its own making; it is worth
// writing once someone has run the probe on real hardware.

// rdmaFabric is one fabric: the label value, and the API's name for it.
type rdmaFabric struct {
	device string
	fabric aiv1alpha1.RDMAType
}

var rdmaFabrics = []rdmaFabric{
	{device: "infiniband", fabric: aiv1alpha1.RDMATypeInfiniBand},
	{device: "roce", fabric: aiv1alpha1.RDMATypeRoCE},
}

// rdmaResourceFor is the extended resource this cluster's manager asks for on the
// given fabric.
//
// A flag and not a constant. The cluster's own device plugin has to advertise
// the same name the manager requests, so the name to look for is whatever this
// manager was told, and the preflight read it off the manager's args for exactly
// this. Read at run time rather than while the tree is built, because the tree is
// built before the suite's preflight has run.
//
// Which flag answers for which fabric mirrors the controller's own branch rather
// than restating a table: the two fabrics are the API's enum, and the mapping
// from a fabric to its resource is not what these cases are checking.
func rdmaResourceFor(t aiv1alpha1.RDMAType) corev1.ResourceName {
	if t == aiv1alpha1.RDMATypeInfiniBand {
		return corev1.ResourceName(conformance.Cluster.RDMAIBResource)
	}
	return corev1.ResourceName(conformance.Cluster.RDMARoCEResource)
}

func describeRDMA() {
	Describe("RDMA-dependent validation",
		Label(devenv.TierP1, devenv.LabelFamily("O")), Ordered,
		func() {
			// On the family, so that one Node list serves both fabrics and both
			// polarities: Ginkgo runs an outer container's BeforeAll before the
			// BeforeAll of everything below it, which is what makes the gate
			// closures read a filled-in map rather than a nil one.
			BeforeAll(func(ctx SpecContext) {
				if conformance == nil {
					return
				}
				probeDevices(ctx)
			})

			for _, f := range rdmaFabrics {
				describeRDMAFabric(f)
			}
		})
}

func describeRDMAFabric(f rdmaFabric) {
	Describe(f.device, Label(devenv.LabelDevice(f.device)), Ordered, func() {
		// O1 — the fabric is there, so the environment should be too.
		//
		// The image is the stock Ubuntu one because nothing here is about the
		// image: the fabric is the platform's to attach, and a case that needed a
		// vendor image to observe it would be testing the image's packaging
		// instead.
		draftCase{
			Name:     "rdma-" + f.device,
			Image:    devenv.MustImage("cpu-pytorch-ssh"),
			Identity: devenv.NonRoot,
			Shape: func(d *aiv1alpha1.DevEnvironment) {
				d.Spec.Network = &aiv1alpha1.NetworkSpec{
					RDMAEnabled: true,
					RDMAType:    f.fabric,
				}
			},
			Available: func(context.Context) string {
				resource := rdmaResourceFor(f.fabric)
				if deviceCapacity[resource] >= 1 {
					return ""
				}
				return fmt.Sprintf("no schedulable node advertises %s; this case needs 1", resource)
			},
			Cases: func(open func() *devenv.Environment) {
				It("O1 runs with the fabric's device allocated to it", func(ctx SpecContext) {
					env := open()

					// The phase the platform reports once the environment is
					// usable, with its conditions true and an endpoint published,
					// rather than the pod being up: an environment that started
					// but was reachable nowhere would pass a pod-level check and
					// fail the thing a user cares about.
					running(ctx, env)

					pod, err := env.Pod(ctx)
					Expect(err).NotTo(HaveOccurred(),
						"reading the pod %s is running as", env.Name)
					// One device, which is what the controller requests — a
					// device-plugin share limit, not a per-pod count.
					assertPodAllocated(pod, rdmaResourceFor(f.fabric), 1)
					Expect(pod.Spec.NodeName).NotTo(BeEmpty(),
						"the pod is placed on no node, so the fabric did not choose one")
				})
			},
		}.declare()

		// O2 — the fabric is not there, so the environment should wait.
		//
		// The polarity is inverted rather than imitated: the case does not invent
		// an unsatisfiable request, it asks for the fabric no node advertises, so
		// what it observes is the platform's own handling of a request the
		// cluster cannot serve. That makes it runnable on a cluster with no
		// fabric, which is what keeps this family from being an empty run there.
		//
		// The spec is still valid, which is the whole claim: nothing about it is
		// refused, and where it cannot go is the cluster's answer rather than the
		// platform's. The same shape as E9 and N4, on a third resource.
		draftCase{
			Name:     "rdma-" + f.device + "-absent",
			Image:    devenv.MustImage("cpu-pytorch-ssh"),
			Identity: devenv.NonRoot,
			Shape: func(d *aiv1alpha1.DevEnvironment) {
				d.Spec.Network = &aiv1alpha1.NetworkSpec{
					RDMAEnabled: true,
					RDMAType:    f.fabric,
				}
			},
			Available: func(context.Context) string {
				resource := rdmaResourceFor(f.fabric)
				if deviceCapacity[resource] == 0 {
					return ""
				}
				return fmt.Sprintf(
					"a schedulable node advertises %s, so there is no shortfall to observe here", resource)
			},
			Cases: func(open func() *devenv.Environment) {
				It("O2 waits, rather than failing, where no node advertises the fabric",
					func(ctx SpecContext) {
						env := open()
						resource := rdmaResourceFor(f.fabric)

						// Accepted settles before the pod exists at all, so this
						// is a real assertion about a spec the platform did not
						// refuse, and what the case then waits for is the state
						// that gives it something to be true about.
						c := acceptedSettled(ctx, env)
						Expect(c.Status).To(Equal(metav1.ConditionTrue),
							"a cluster that cannot serve the spec was reported as a spec the controller refused: %s",
							c.Message)
						Expect(c.Reason).To(Equal(devenv.ReasonAccepted),
							"the spec is applied as written; what cannot serve it is the cluster: %s", c.Message)

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
							"an environment waiting for a device it cannot get is waiting, not failed")

						cond := schedulerRefusal(ctx, env)
						Expect(cond.Message).To(ContainSubstring(string(resource)),
							"the scheduler reports the resource it could not find, and that name is the contract: %q",
							cond.Message)
					})
			},
		}.declare()
	})
}
