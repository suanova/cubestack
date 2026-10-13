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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/test/e2e/devenv"
)

// Family N: the GPU.
//
// Four things about a GPU environment are worth a cluster-level case, and only
// one of them can be asked anywhere. The first is that a spec naming a vendor's
// GPU gets one: scheduled onto a node that advertises the device, with the
// resource accounted to it, and visible to the tools and the framework the image
// is built around. That needs a node with the device, so those cases stand down
// where there is none.
//
// The second is that naming a model of that vendor confines it to the nodes
// offering that model. It is the only case here whose subject is a node label the
// vendor's own device plugin wrote, so it is the only case that can check the
// label's name and value against anything outside this repository — and it needs
// more than a device: a cluster that advertises the device without advertising
// any model has nothing for the case to ask for.
//
// The third is that those observations are the device's rather than the image's
// — that the same tool, asked in the same image with nothing allocated to it,
// does not answer the same way. Without it the first is an assertion no cluster
// could fail, which is the same as no assertion at all. It needs the device too,
// for the reason given at describeGPUVendorAbsent, and the pair is the only
// place in this repository where a vendor tool is run without a device.
//
// The fourth is what happens when the request cannot be met at all — the platform
// applies the spec as written, and the cluster says why it cannot serve it. That
// case needs no hardware, and it is here so that family N is never an empty run
// on a cluster without a GPU.

// gpuCount is what each positive case asks for.
//
// The CRD defaults `count` to 1, and every case below sets it explicitly rather
// than leaning on that default, so what is asserted is what the spec asked for
// and not what the API server filled in.
var gpuCount = int32(1)

// The extended resources the two vendors map to, and the node labels their device
// plugins write the model to, named once so that the cases which ask what a
// vendor's request renders to, which over-ask, and which pin a model cannot come
// to disagree about them.
//
// Written out here rather than read from the controller's own table: this mapping
// is part of what the family checks, and a test that read the mapping out of the
// implementation would agree with it by construction.
const (
	nvidiaGPU = corev1.ResourceName("nvidia.com/gpu")
	metaxGPU  = corev1.ResourceName("metax-tech.com/gpu")

	nvidiaProduct = "nvidia.com/gpu.product"
	metaxProduct  = "metax-tech.com/gpu.product"
)

// gpuVendor is one vendor: what the cluster must advertise for the cases to run,
// which published image carries the vendor's own device tool, and the tool.
type gpuVendor struct {
	// device is the label value and the environment's name suffix.
	device string

	vendor aiv1alpha1.AcceleratorVendor

	// resource is the extended resource this vendor's request becomes.
	resource corev1.ResourceName

	// productLabel is the node label the vendor's device plugin writes the model
	// to, which is what a spec naming a model is confined by.
	productLabel string

	image string

	// tool is the vendor's own device tool, run inside the environment.
	tool string
}

var gpuVendors = []gpuVendor{
	{
		device:       "nvidia",
		vendor:       aiv1alpha1.AcceleratorVendorNvidia,
		resource:     nvidiaGPU,
		productLabel: nvidiaProduct,
		image:        "ssh-cuda-pytorch",
		tool:         "nvidia-smi -L",
	},
	{
		device:       "metax",
		vendor:       aiv1alpha1.AcceleratorVendorMetax,
		resource:     metaxGPU,
		productLabel: metaxProduct,
		image:        "ssh-maca-pytorch",
		tool:         "mx-smi",
	},
}

// deviceCountCommand is the device count as the image's own torch sees it.
//
// `torch.cuda` rather than the vendor tool, because what this case is about is
// the framework a user's code runs against, not the driver's own view of itself.
// The MACA build is a port of the CUDA one, and whether that port mirrors
// `torch.cuda` is the part of this case a real MACA node has to confirm: the
// catalogue's own MACA stack check imports torch and prints `torch.__version__`
// and never touches a device API, so nothing in this repository settles it. If
// the port does not mirror it, this fails with the interpreter's own error and
// the finding is about the port rather than about the device.
const deviceCountCommand = `python3 -c 'import torch; print(torch.cuda.device_count())'`

// int32Ptr is a pointer to n, for the optional spec fields that are pointers.
func int32Ptr(n int64) *int32 {
	v := int32(n)
	return &v
}

func describeGPU() {
	Describe("GPU-dependent validation",
		Label(devenv.TierP1, devenv.LabelFamily("N")), Ordered,
		func() {
			// The probe is on the family rather than on each case because Ginkgo
			// runs an outer container's BeforeAll before the BeforeAll of every
			// case below it, which is what makes each gate closure read a map that
			// has been filled in rather than a nil one.
			BeforeAll(func(ctx SpecContext) {
				if conformance == nil {
					return
				}
				probeDevices(ctx)
				probeGPUModels(ctx)
			})

			for _, v := range gpuVendors {
				describeGPUVendor(v)
				describeGPUModel(v)
				describeGPUVendorAbsent(v)
			}
			// Deliberately no device label: this case is about the resource's name
			// in the scheduler's own message, not about the resource being present.
			describeGPUShortfall()
		})
}

// gpuAvailable reports whether this cluster can serve the one device every case
// in the vendor's pair asks for.
//
// One predicate behind both gates rather than the expression written twice,
// because the control is only meaningful where the case it controls runs: two
// copies could drift into a cluster where the positive case runs and its control
// skips, which would leave the positive case exactly as unfalsifiable as it was
// before the control existed. The two gates do say different things when they
// fail, and that is the reason they are still separate closures.
func gpuAvailable(v gpuVendor) bool {
	return deviceCapacity[v.resource] >= int64(gpuCount)
}

// gpuModelNames is what each vendor's device plugin advertises as its models,
// filled in by probeGPUModels from family N's BeforeAll. Keyed by the vendor's
// extended resource, because every reader here knows which device it is asking
// about and nothing else identifies the vendor's plugin.
var gpuModelNames map[corev1.ResourceName][]string

// gpuModel is the model family N pins an environment to: the first of what the
// cluster offers for the vendor, or "" where it offers none.
//
// One name rather than a choice per assertion, because the case asks the platform
// for a model and then checks the platform delivered that one; a case that picked
// again at assertion time would compare the answer with something else.
// DeviceModels sorts, so the first is the same on every run and the two readings
// cannot diverge.
func gpuModel(v gpuVendor) string {
	models := gpuModelNames[v.resource]
	if len(models) == 0 {
		return ""
	}
	return models[0]
}

// probeGPUModels reads which models each vendor's device plugin advertises.
//
// A cluster that cannot be asked fails the run rather than skipping it, for the
// reason probeDevices gives: "this cluster offers no model" and "I cannot tell
// what this cluster offers" are different answers, and only the first one means a
// case should stand down.
func probeGPUModels(ctx SpecContext) {
	GinkgoHelper()
	models := make(map[corev1.ResourceName][]string, len(gpuVendors))
	for _, v := range gpuVendors {
		offered, err := conformance.DeviceModels(ctx, v.resource, v.productLabel)
		Expect(err).NotTo(HaveOccurred(),
			"reading which models of %s the cluster offers, which is how a case that pins one "+
				"knows whether there is one to pin", v.resource)
		models[v.resource] = offered
	}
	gpuModelNames = models
}

func describeGPUVendor(v gpuVendor) {
	Describe(v.device, Label(devenv.LabelDevice(v.device)), Ordered, func() {
		draftCase{
			Name:     "gpu-" + v.device,
			Image:    devenv.MustImage(v.image),
			Identity: devenv.NonRoot,
			Shape: func(d *aiv1alpha1.DevEnvironment) {
				d.Spec.Resources.GPU = &aiv1alpha1.GPUSpec{Vendor: v.vendor, Count: &gpuCount}
			},
			Available: func(context.Context) string {
				if gpuAvailable(v) {
					return ""
				}
				return fmt.Sprintf("no schedulable node advertises %s; this case needs %d",
					v.resource, gpuCount)
			},
			Cases: func(open func() *devenv.Environment) {
				It("N1 places it on a node with the device allocated to it",
					func(ctx SpecContext) {
						env := open()
						running(ctx, env)

						// The allocation is checked on the rendered pod because it
						// is what made the scheduler choose a node with a device:
						// without it the pod could be running on a node that has
						// none, and N2 would then fail for the wrong reason.
						pod, err := env.Pod(ctx)
						Expect(err).NotTo(HaveOccurred(),
							"reading the pod %s is running as", env.Name)
						assertPodAllocated(pod, v.resource, int64(gpuCount))
						Expect(pod.Spec.NodeName).NotTo(BeEmpty(),
							"the pod is placed on no node, so no node was asked for a device")
					})

				It("N2 runs the vendor's own device tool", func(ctx SpecContext) {
					env := open()

					// Exit 0 and something printed, rather than a parsed line,
					// because the two vendors mean different things by it and both
					// mean something: nvidia-smi is injected by the container
					// toolkit at start, so its running at all is the proof, while
					// mx-smi is baked into the image and so is proved by answering
					// rather than by existing. Parsing a device line would need a
					// sample of each tool's output, and the MACA one is not in this
					// repository to take.
					out := sshOutput(ctx, env, v.tool)
					Expect(strings.TrimSpace(out)).NotTo(BeEmpty(),
						"%s exited 0 and reported nothing, which is not a device being present", v.tool)
				})

				It("N3 lets the image's torch count the device", func(ctx SpecContext) {
					env := open()
					out := sshOutput(ctx, env, deviceCountCommand)
					Expect(strings.TrimSpace(out)).To(Equal(fmt.Sprintf("%d", gpuCount)),
						"the torch in %s counts a different number of devices from the spec", v.image)
				})
			},
		}.declare()
	})
}

// describeGPUModel pins an environment to one model the cluster offers.
//
// N1 asks only that a spec naming a vendor's device lands on a node with one, and
// that is the whole of what naming a vendor can mean — so a controller that
// dropped spec.resources.gpu.model entirely would pass N1 unchanged. Nothing else
// in this family would notice either: N2 and N3 read the device, N5 asks for
// none, and N4 over-asks for a count. This is the only case in the repository
// whose subject is the model constraint, and the only one that can check the
// label the constraint is written in against the vendor's own device plugin —
// which is why it is worth a third environment on a cluster that has a GPU.
//
// The model is discovered rather than written down, for the reason DeviceModels
// gives: any literal here is a name this cluster may not offer, and the case would
// then be asserting the cluster's inventory. It stands down where the cluster
// advertises the device but no model for it — there is nothing to ask for then,
// which is a different answer from the platform being wrong, and an environment
// naming a model no node has would sit Pending and report the cluster's hardware
// while looking like a platform defect.
func describeGPUModel(v gpuVendor) {
	Describe(v.device+"-model", Label(devenv.LabelDevice(v.device)), Ordered, func() {
		draftCase{
			Name:     "gpu-" + v.device + "-model",
			Image:    devenv.MustImage(v.image),
			Identity: devenv.NonRoot,
			Shape: func(d *aiv1alpha1.DevEnvironment) {
				d.Spec.Resources.GPU = &aiv1alpha1.GPUSpec{
					Vendor: v.vendor, Model: gpuModel(v), Count: &gpuCount,
				}
			},
			Available: func(context.Context) string {
				if !gpuAvailable(v) {
					return fmt.Sprintf("no schedulable node advertises %s; this case needs %d",
						v.resource, gpuCount)
				}
				if gpuModel(v) == "" {
					return fmt.Sprintf(
						"no schedulable node advertising %s writes %s, so this cluster offers no "+
							"model for the case to pin an environment to", v.resource, v.productLabel)
				}
				return ""
			},
			Cases: func(open func() *devenv.Environment) {
				It("N6 pins it to a node advertising the model it named",
					func(ctx SpecContext) {
						env := open()
						running(ctx, env)

						// The pin as the platform rendered it. The whole map, not
						// the one entry: the model is the pod's only node
						// selection, so an extra one would be a constraint the
						// spec never asked for and this is where it would show.
						pod, err := env.Pod(ctx)
						Expect(err).NotTo(HaveOccurred(),
							"reading the pod %s is running as", env.Name)
						Expect(pod.Spec.NodeSelector).To(Equal(
							map[string]string{v.productLabel: gpuModel(v)}),
							"the pod is not pinned to the model the spec named, or is pinned to more than it")

						// And the pin as the cluster enforced it: the node the
						// scheduler chose says the same of itself. This is the half
						// N1 could never reach — the label's name and its value are
						// the vendor device plugin's, so only a node carrying one
						// can confirm that the platform is asking the right
						// question. The pod is placed at all only because the label
						// was written the way that plugin writes it.
						Expect(pod.Spec.NodeName).NotTo(BeEmpty(),
							"the pod is placed on no node, so nothing was pinned against anything")
						var node corev1.Node
						Expect(conformance.Client.Get(ctx,
							client.ObjectKey{Name: pod.Spec.NodeName}, &node)).To(Succeed(),
							"reading the node %s was placed on", pod.Spec.NodeName)
						Expect(node.Labels[v.productLabel]).To(Equal(gpuModel(v)),
							"the environment named a model and landed on a node advertising another")
					})
			},
		}.declare()
	})
}

// describeGPUVendorAbsent is the control for N2.
//
// N2 accepts a tool that exited 0 having printed something as a device being
// there. That is only a statement about the device if the same tool, asked in
// the same image with nothing allocated, does not answer the same way — and
// nothing measured that. The tool is run inside the gated case, so the only two
// outcomes a cluster could produce were "the device is present" and "the tool
// was never asked", and an environment requesting no GPU was not a spec any case
// wrote. A positive case whose assertion the image alone could satisfy is a case
// that cannot fail, and no run before this one could have told the difference.
//
// The environment is the positive case's with one thing missing: no
// `resources.gpu` block. That is a spec the platform accepts — the brand check
// exempts an environment that asks for no GPU — so it schedules on a node with
// no device, which is what makes the comparison possible at all. The pod is then
// asserted to name no device, so the case cannot pass by being handed one the
// spec did not ask for.
//
// Gated on the device being present, like the case it controls. Where no node
// advertises the resource N2 does not run either, and a control with nothing to
// compare against is a second copy of the negative case rather than a control.
func describeGPUVendorAbsent(v gpuVendor) {
	Describe(v.device+"-absent", Label(devenv.LabelDevice(v.device)), Ordered, func() {
		draftCase{
			Name:     "gpu-" + v.device + "-absent",
			Image:    devenv.MustImage(v.image),
			Identity: devenv.NonRoot,
			// No Shape: the catalogue's manifest is already an environment that
			// asks for no GPU, and that absence is the whole of the case.
			Available: func(context.Context) string {
				if gpuAvailable(v) {
					return ""
				}
				return fmt.Sprintf(
					"no schedulable node advertises %s, so N2 does not run here either and this "+
						"control would have nothing to compare against", v.resource)
			},
			Cases: func(open func() *devenv.Environment) {
				It("N5 asks the same tool where no device was allocated",
					func(ctx SpecContext) {
						env := open()
						running(ctx, env)

						pod, err := env.Pod(ctx)
						Expect(err).NotTo(HaveOccurred(),
							"reading the pod %s is running as", env.Name)
						assertPodNotAllocated(pod, v.resource)

						// N2's predicate, negated — the coupling is the point
						// rather than an accident. The claim under test is that
						// the device is what decides N2's answer, so what has to
						// hold is that N2's answer does not hold here; and an N2
						// later tightened to a parsed output line has to tighten
						// this with it, which one negation in one place makes hard
						// to forget.
						res := sshRun(ctx, env, v.tool)
						Expect(res.ExitCode != 0 || strings.TrimSpace(res.Stdout) == "").To(BeTrue(),
							"%s exited 0 and printed %d bytes in an environment that was allocated no device.\n"+
								"That is what N2 accepts as a device being present, so N2 cannot tell the "+
								"device from its absence and has to be tightened to a parsed line. "+
								"What the tool printed to stdout:\n%s",
							v.tool, len(res.Stdout), res.Stdout)
					})
			},
		}.declare()
	})
}

// describeGPUShortfall is the case that runs on every cluster, GPU or not.
//
// It is the same shape as E9 — an environment the cluster cannot serve, reported
// as the cluster's problem rather than the spec's — and is here rather than in
// family E because of the one thing E9 does not check: the resource's own name.
// E9's subject is a claim about storage, so it asserts the scheduler's reason and
// that the message says what it could not find. The resource string a GPU request
// produces is family N's subject, and it is the string a user reads when their
// environment will not start.
func describeGPUShortfall() {
	draftCase{
		Name:     "gpu-shortfall",
		Image:    devenv.MustImage("ssh-cuda-pytorch"),
		Identity: devenv.NonRoot,
		Shape: func(d *aiv1alpha1.DevEnvironment) {
			// One more than the largest single node holds, which makes the request
			// unservable on any cluster rather than only on a small one. The
			// vendor is fixed rather than picked to suit the cluster: where no
			// node advertises it at all, the arithmetic asks for a single device
			// and the cluster refuses it for the same reason, so the case is never
			// vacuous — it is the one case in this family that always has
			// something to say.
			d.Spec.Resources.GPU = &aiv1alpha1.GPUSpec{
				Vendor: aiv1alpha1.AcceleratorVendorNvidia,
				Count:  int32Ptr(deviceCapacity[nvidiaGPU] + 1),
			}
		},
		Cases: func(open func() *devenv.Environment) {
			It("N4 reports an unservable request as the cluster's refusal, not the spec's",
				func(ctx SpecContext) {
					env := open()

					// The first reconcile records Accepted before the pod exists at
					// all, so this settles early and what the case then waits for is
					// the state that makes it mean something.
					c := acceptedSettled(ctx, env)
					Expect(c.Status).To(Equal(metav1.ConditionTrue),
						"a cluster that cannot serve the spec was reported as a spec the controller refused: %s",
						c.Message)
					Expect(c.Reason).To(Equal(devenv.ReasonAccepted),
						"the spec is applied as written; what cannot serve it is the cluster: %s", c.Message)

					// Where the refusal is reported instead. The pod has to exist
					// first, and a pod the scheduler keeps refusing never stops
					// existing, so this waits for the observation rather than for a
					// transition.
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

					pod, err := env.Pod(ctx)
					Expect(err).NotTo(HaveOccurred())
					cond := podCondition(pod, corev1.PodScheduled)
					Expect(cond).NotTo(BeNil(),
						"the pod records no PodScheduled condition, so nothing anywhere says why it is stuck")
					Expect(cond.Reason).To(Equal(corev1.PodReasonUnschedulable),
						"the scheduler's reason for refusing the pod: %s", cond.Message)
					Expect(cond.Message).To(ContainSubstring("Insufficient"),
						"the scheduler's message has to name what it could not find: %q", cond.Message)
					Expect(cond.Message).To(ContainSubstring(string(nvidiaGPU)),
						"the scheduler reports the resource it could not find, and that name is the contract: %q",
						cond.Message)
				})
		},
	}.declare()
}
