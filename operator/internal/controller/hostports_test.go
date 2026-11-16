package controller

import (
	"strconv"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// A host-network environment binds the node's ports, so the platform allocates
// them per environment instead of taking the type's fixed ones; without that,
// one RoCE environment per node is all a cluster can run.
var _ = Describe("host port allocation", func() {
	roce := func() *aiv1alpha1.NetworkSpec {
		return &aiv1alpha1.NetworkSpec{RDMAEnabled: true, RDMAType: aiv1alpha1.RDMATypeRoCE}
	}

	// createBoundPod stands in for the StatefulSet controller, which envtest does
	// not run: the workload still on the node's network and still on the numbers
	// an allocation records.
	createBoundPod := func(env *aiv1alpha1.DevEnvironment, held *aiv1alpha1.HostPorts) {
		ports := []corev1.ContainerPort{{Name: mainPortName, ContainerPort: held.Main}}
		if held.SSH != 0 {
			ports = append(ports, corev1.ContainerPort{Name: sshPortName, ContainerPort: held.SSH})
		}
		pod := &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name: podName(env), Namespace: env.Namespace,
				Labels: map[string]string{devEnvironmentLabelKey: env.Name},
			},
			Spec: corev1.PodSpec{
				HostNetwork: true,
				NodeName:    "node-a",
				Containers:  []corev1.Container{{Name: testJupyterName, Image: testDevImage, Ports: ports}},
			},
		}
		Expect(k8sClient.Create(ctx, pod)).To(Succeed())
	}

	// deleteBoundPod removes it. The zero grace period is not incidental: the pod
	// is bound to a node and envtest runs no kubelet to confirm the termination,
	// so an ordinary delete would leave it Terminating forever.
	deleteBoundPod := func(env *aiv1alpha1.DevEnvironment) {
		pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: podName(env), Namespace: env.Namespace}}
		Expect(k8sClient.Delete(ctx, pod, client.GracePeriodSeconds(0))).To(Succeed())
	}

	Describe("allocateHostPort", func() {
		It("keeps the port the environment already holds while it is free", func() {
			used := map[int32]bool{}
			port, ok := allocateHostPort(21005, used, 21000, 21010)
			Expect(ok).To(BeTrue())
			Expect(port).To(Equal(int32(21005)))
			Expect(used[21005]).To(BeTrue())
		})

		It("takes the lowest free port when the held one is taken", func() {
			used := map[int32]bool{21000: true, 21001: true}
			port, ok := allocateHostPort(21000, used, 21000, 21010)
			Expect(ok).To(BeTrue())
			Expect(port).To(Equal(int32(21002)))
		})

		It("reallocates a held port that is outside the range", func() {
			port, ok := allocateHostPort(8888, map[int32]bool{}, 21000, 21010)
			Expect(ok).To(BeTrue())
			Expect(port).To(Equal(int32(21000)))
		})

		It("reports an exhausted pool rather than reusing a port", func() {
			used := map[int32]bool{21000: true, 21001: true}
			_, ok := allocateHostPort(0, used, 21000, 21001)
			Expect(ok).To(BeFalse())
		})
	})

	Describe("settledAllocation", func() {
		// The replacement declares the main port from its first moment and may have
		// no sshd at all, so each number is judged on its own. A rule that kept the
		// record whole while any part of it was bound would never release the port
		// the pass dropped, and the spec below fails on it.
		It("drops a number the replacement pod does not bind", func() {
			pod := &corev1.Pod{Spec: corev1.PodSpec{
				HostNetwork: true,
				Containers: []corev1.Container{{Ports: []corev1.ContainerPort{
					{ContainerPort: 21000},
				}}},
			}}
			settled := settledAllocation(
				&aiv1alpha1.HostPorts{Main: 21000},
				&aiv1alpha1.HostPorts{Main: 21000, SSH: 21001},
				pod,
			)
			Expect(settled).NotTo(BeNil())
			Expect(settled.Main).To(Equal(int32(21000)))
			Expect(settled.SSH).To(BeZero())
		})
	})

	Describe("the allocation on a live environment", func() {
		It("gives two RoCE environments distinct node ports", func() {
			first := validDevEnvironment("de-roce-first")
			first.Spec.Network = roce()
			Expect(k8sClient.Create(ctx, first)).To(Succeed())
			defer deleteEnv(first.Name)

			second := validDevEnvironment("de-roce-second")
			second.Spec.Network = roce()
			Expect(k8sClient.Create(ctx, second)).To(Succeed())
			defer deleteEnv(second.Name)

			Eventually(func(g Gomega) {
				a, b := &aiv1alpha1.DevEnvironment{}, &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(first.Name), a)).To(Succeed())
				g.Expect(k8sClient.Get(ctx, envKey(second.Name), b)).To(Succeed())
				g.Expect(a.Status.HostPorts).NotTo(BeNil())
				g.Expect(b.Status.HostPorts).NotTo(BeNil())
				g.Expect(a.Status.HostPorts.Main).NotTo(Equal(b.Status.HostPorts.Main))
			}, "15s", "200ms").Should(Succeed())
		})

		It("gives sshd a node port of its own and points the Service at both", func() {
			env := validDevEnvironment("de-roce-ssh")
			env.Spec.Network = roce()
			env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
				held := observed.Status.HostPorts
				g.Expect(held.SSH).NotTo(BeZero())
				g.Expect(held.SSH).NotTo(Equal(held.Main))

				// The Service keeps the conventional ports and moves what they
				// forward to: the allocation is the container's, not the address.
				svc := &corev1.Service{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), svc)).To(Succeed())
				g.Expect(servicePorts(svc)).To(HaveKeyWithValue(mainPortName, [2]int32{8888, held.Main}))
				g.Expect(servicePorts(svc)).To(HaveKeyWithValue(sshPortName, [2]int32{sshServicePort, held.SSH}))

				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Template.Spec.Containers[0].Env).To(ContainElement(corev1.EnvVar{
					Name: sshPortEnv, Value: itoa(held.SSH),
				}))
			}, "15s", "200ms").Should(Succeed())
		})

		It("leaves a pod-network environment without one", func() {
			env := validDevEnvironment("de-podnet-ports")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Template.Spec.HostNetwork).To(BeFalse())
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: env.Name, Namespace: testNamespace}, observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).To(BeNil())
				g.Expect(sts.Spec.Template.Spec.Containers[0].Ports).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())
		})

		It("blocks a spec.ports entry against the allocated port from the first pass", func() {
			// The main entry's targetPort is the allocation on the host network, so
			// an entry reusing the published 8888 is not the lossless fold it would
			// be on the pod network. Resolving the allocation before the gate keeps
			// that decision the same on every pass: the environment never
			// provisions, rather than running once and failing later on a spec
			// nobody changed.
			env := validDevEnvironment("de-roce-port-collision")
			env.Spec.Network = roce()
			env.Spec.Ports = []aiv1alpha1.PortSpec{{Name: "notebook-again", Type: aiv1alpha1.PortTypeTCP, ContainerPort: 8888}}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.Phase).NotTo(BeNil())
				g.Expect(observed.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseFailed))
				// Recorded before the gate ran, which is what the gate read.
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
			}, "15s", "200ms").Should(Succeed())

			err := k8sClient.Get(ctx, envKey(env.Name), &appsv1.StatefulSet{})
			Expect(apierrors.IsNotFound(err)).To(BeTrue(), "the gate must decide before anything is applied")
		})

		It("keeps an allocation until the pass that replaces the workload", func() {
			// A move off the host network resolves no ports, but the workload on
			// the old allocation keeps binding them until the StatefulSet is
			// re-applied below. The first pass here refuses the spec, so that
			// apply never happens: releasing the number then would hand it back
			// to the pool while a pod still holds it, and one whose workload is
			// never replaced would keep holding a port nothing recorded.
			env := validDevEnvironment("de-roce-released")
			env.Spec.Network = roce()
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var held *aiv1alpha1.HostPorts
			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
				held = observed.Status.HostPorts.DeepCopy()

				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Template.Spec.HostNetwork).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			updateEnvSpec(env.Name, func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Network = nil
				// A name the platform publishes for this environment, refused
				// before anything is applied.
				e.Spec.Ports = []aiv1alpha1.PortSpec{{
					Name: mainPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 9091,
				}}
			})

			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.Phase).NotTo(BeNil())
				g.Expect(observed.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseFailed))
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
				g.Expect(observed.Status.HostPorts.Main).To(Equal(held.Main))

				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Template.Spec.HostNetwork).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			// Getting as far as the apply is what releases it.
			updateEnvSpec(env.Name, func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Ports = nil
			})

			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).To(BeNil())

				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Template.Spec.HostNetwork).To(BeFalse())
			}, "15s", "200ms").Should(Succeed())
		})

		It("keeps the ssh port a workload still binds after SSH is turned off", func() {
			// Turning SSH off resolves the main port alone, so the ssh port this
			// pass no longer uses leaves the status with the write that follows the
			// apply — unless the workload being replaced is still standing on it,
			// which is what the record is there to keep out of the pool.
			env := validDevEnvironment("de-roce-ssh-off")
			env.Spec.Network = roce()
			env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var held *aiv1alpha1.HostPorts
			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
				g.Expect(observed.Status.HostPorts.SSH).NotTo(BeZero())
				held = observed.Status.HostPorts.DeepCopy()
			}, "15s", "200ms").Should(Succeed())

			createBoundPod(env, held)
			updateEnvSpec(env.Name, func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: false}
			})

			Eventually(func(g Gomega) {
				// The workload no longer launches sshd, so the port is not the
				// platform's to keep — only the pod's, until it is gone.
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				for _, e := range sts.Spec.Template.Spec.Containers[0].Env {
					g.Expect(e.Name).NotTo(Equal(sshPortEnv))
				}

				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
				g.Expect(observed.Status.HostPorts.SSH).To(Equal(held.SSH))
			}, "15s", "200ms").Should(Succeed())

			deleteBoundPod(env)
			Eventually(func(g Gomega) {
				err := k8sClient.Get(ctx, envKey(podName(env)), &corev1.Pod{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			// The replacement declares the main port from its first moment and has
			// no sshd, so the record has to drop the ssh port here while keeping the
			// main one: a release that reads the record whole would see the main
			// port bound and never let the ssh port go.
			createBoundPod(env, &aiv1alpha1.HostPorts{Main: held.Main})

			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
				g.Expect(observed.Status.HostPorts.Main).To(Equal(held.Main))
				g.Expect(observed.Status.HostPorts.SSH).To(BeZero())
			}, "15s", "200ms").Should(Succeed())
		})

		It("keeps the port a spec.ports entry names", func() {
			// An entry naming the number the environment already holds is the
			// exposure the platform publishes, not a second claim on it. Reading it
			// as one moves the allocation off a port the running pod binds — and
			// withdraws that number from the pool while the pod still holds it.
			env := validDevEnvironment("de-roce-declared-held")
			env.Spec.Network = roce()
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var held *aiv1alpha1.HostPorts
			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
				held = observed.Status.HostPorts.DeepCopy()
			}, "15s", "200ms").Should(Succeed())

			updateEnvSpec(env.Name, func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Ports = []aiv1alpha1.PortSpec{{
					Name: "notebook-host", Type: aiv1alpha1.PortTypeTCP, ContainerPort: held.Main,
				}}
			})

			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
				g.Expect(observed.Status.HostPorts.Main).To(Equal(held.Main))
				accepted := meta.FindStatusCondition(observed.Status.Conditions, aiv1alpha1.ConditionAccepted)
				g.Expect(accepted).NotTo(BeNil())
				g.Expect(accepted.Status).To(Equal(metav1.ConditionTrue))

				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Template.Spec.HostNetwork).To(BeTrue())
				g.Expect(sts.Spec.Template.Spec.Containers[0].Ports).To(ContainElement(
					HaveField("ContainerPort", held.Main)))
			}, "15s", "200ms").Should(Succeed())
		})

		It("keeps a port out of the pool while a workload on it is being replaced", func() {
			// Another environment declaring the number in spec.ports moves this
			// one's allocation off it: the declared number is the user's and cannot
			// be moved, so the allocation yields. The workload on the old number is
			// not replaced until the StatefulSet is rolled, but the record lets the
			// number go as soon as the allocation moves — the pod still binding it
			// is what has to keep it out of the pool in between.
			env := validDevEnvironment("de-roce-displaced")
			env.Spec.Network = roce()
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var held *aiv1alpha1.HostPorts
			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
				held = observed.Status.HostPorts.DeepCopy()
			}, "15s", "200ms").Should(Succeed())

			createBoundPod(env, held)
			// Tolerated, because the spec deletes the pod itself below.
			defer func() {
				pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: podName(env), Namespace: env.Namespace}}
				_ = k8sClient.Delete(ctx, pod, client.GracePeriodSeconds(0))
			}()

			declaring := validDevEnvironment("de-roce-declares-held")
			declaring.Spec.Network = roce()
			declaring.Spec.Ports = []aiv1alpha1.PortSpec{{
				Name: "nodeviz", Type: aiv1alpha1.PortTypeTCP, ContainerPort: held.Main,
			}}
			Expect(k8sClient.Create(ctx, declaring)).To(Succeed())
			defer deleteEnv(declaring.Name)

			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
				g.Expect(observed.Status.HostPorts.Main).NotTo(Equal(held.Main))
			}, "15s", "200ms").Should(Succeed())

			// With the declaration gone, no record names the number any more — only
			// the pod standing on it.
			updateEnvSpec(declaring.Name, func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Ports = nil
			})

			next := validDevEnvironment("de-roce-wants-the-port")
			next.Spec.Network = roce()
			only := &DevEnvironmentReconciler{
				Client:    k8sClient,
				APIReader: k8sClient,
				Config:    DevEnvironmentControllerConfig{HostPortRangeStart: held.Main, HostPortRangeEnd: held.Main},
			}
			Eventually(func(g Gomega) {
				_, err := only.hostPortsForPass(ctx, next)
				g.Expect(err).To(MatchError(ContainSubstring("no free host port")))
			}, "15s", "200ms").Should(Succeed())

			deleteBoundPod(env)

			// Once the workload on it is gone, the pool may hand the number out.
			Eventually(func(g Gomega) {
				allocated, err := only.hostPortsForPass(ctx, next)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(allocated.Main).To(Equal(held.Main))
			}, "15s", "200ms").Should(Succeed())
		})

		It("keeps an allocation until the workload that binds it is gone", func() {
			// The apply does not free the node's port: a StatefulSet replaces its
			// pod by deleting it and creating the next one, so the pass that applies
			// a pod-network template still finds the old pod on the allocation. The
			// number leaves the status on the later pass that finds it gone.
			env := validDevEnvironment("de-roce-bound")
			env.Spec.Network = roce()
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var held *aiv1alpha1.HostPorts
			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
				held = observed.Status.HostPorts.DeepCopy()
			}, "15s", "200ms").Should(Succeed())

			createBoundPod(env, held)
			updateEnvSpec(env.Name, func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Network = nil
			})

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Template.Spec.HostNetwork).To(BeFalse())

				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
				g.Expect(observed.Status.HostPorts.Main).To(Equal(held.Main))
			}, "15s", "200ms").Should(Succeed())

			deleteBoundPod(env)

			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).To(BeNil())
			}, "15s", "200ms").Should(Succeed())
		})

		It("compares spec.ports against the port the environment will bind", func() {
			// An allocation on its way out is not the container port the
			// Service forwards to. Read against it, an entry on the fixed port
			// the environment is moving to looks like a second exposure of some
			// other number, and the pass refuses a spec that is the lossless
			// fold the platform already serves.
			env := validDevEnvironment("de-roce-fold")
			env.Spec.Network = roce()
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
			}, "15s", "200ms").Should(Succeed())

			updateEnvSpec(env.Name, func(e *aiv1alpha1.DevEnvironment) {
				e.Spec.Network = nil
				e.Spec.Ports = []aiv1alpha1.PortSpec{{
					Name: "notebook", Type: aiv1alpha1.PortTypeHTTP, ContainerPort: mainContainerPort(aiv1alpha1.DevEnvironmentTypeJupyter),
				}}
			})

			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), observed)).To(Succeed())
				accepted := meta.FindStatusCondition(observed.Status.Conditions, aiv1alpha1.ConditionAccepted)
				g.Expect(accepted).NotTo(BeNil())
				g.Expect(accepted.Status).To(Equal(metav1.ConditionTrue))
				g.Expect(accepted.Reason).To(Equal(reasonOverridden))

				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Template.Spec.HostNetwork).To(BeFalse())
			}, "15s", "200ms").Should(Succeed())
		})

		It("drops a node port the spec declares", func() {
			// A declared port would move the container off the number the probe,
			// the Service and the activity agent all read, so it is dropped like
			// CUBSTACK_TYPE: the environment still becomes Ready. On a pod-network
			// environment the platform states no port at all, which is the case the
			// drop has to cover even though no host port is involved.
			env := validDevEnvironment("de-podnet-declared-port")
			env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{Env: []corev1.EnvVar{
				{Name: mainPortEnv, Value: "7777"},
				{Name: sshPortEnv, Value: "7778"},
			}}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Template.Spec.Containers).NotTo(BeEmpty())
				g.Expect(portEnv(sts.Spec.Template.Spec.Containers[0])).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Describe("hostPortsForPass", func() {
		// A pool one port wide that the cluster has already given away, so every
		// allocation this reconciler attempts fails.
		exhausted := func(taken int32) *DevEnvironmentReconciler {
			return &DevEnvironmentReconciler{
				Client:    k8sClient,
				APIReader: k8sClient,
				Config:    DevEnvironmentControllerConfig{HostPortRangeStart: taken, HostPortRangeEnd: taken},
			}
		}

		It("reports an exhausted pool for an environment the pass wants running", func() {
			holder := validDevEnvironment("de-roce-holder")
			holder.Spec.Network = roce()
			Expect(k8sClient.Create(ctx, holder)).To(Succeed())
			defer deleteEnv(holder.Name)

			var taken int32
			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(holder.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
				taken = observed.Status.HostPorts.Main
			}, "15s", "200ms").Should(Succeed())

			wanted := validDevEnvironment("de-roce-wanted")
			wanted.Spec.Network = roce()
			_, err := exhausted(taken).hostPortsForPass(ctx, wanted)
			Expect(err).To(MatchError(ContainSubstring("no free host port")))
		})

		It("lets a stop through and keeps what the environment already holds", func() {
			holder := validDevEnvironment("de-roce-holder-stopped")
			holder.Spec.Network = roce()
			Expect(k8sClient.Create(ctx, holder)).To(Succeed())
			defer deleteEnv(holder.Name)

			var taken int32
			Eventually(func(g Gomega) {
				observed := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(holder.Name), observed)).To(Succeed())
				g.Expect(observed.Status.HostPorts).NotTo(BeNil())
				taken = observed.Status.HostPorts.Main
			}, "15s", "200ms").Should(Succeed())

			stopped := validDevEnvironment("de-roce-stopped")
			stopped.Spec.Network = roce()
			stopped.Spec.Running = false
			stopped.Status.HostPorts = &aiv1alpha1.HostPorts{Main: taken - 1}

			hostPorts, err := exhausted(taken).hostPortsForPass(ctx, stopped)
			Expect(err).NotTo(HaveOccurred())
			Expect(hostPorts).NotTo(BeNil())
			Expect(hostPorts.Main).To(Equal(taken - 1))
		})
	})
})

// portEnv lists the node-port variables a container carries, rendered as
// name=value so a wrong value fails as loudly as a missing one.
func portEnv(container corev1.Container) []string {
	var stated []string
	for _, v := range container.Env {
		if v.Name == mainPortEnv || v.Name == sshPortEnv {
			stated = append(stated, v.Name+"="+v.Value)
		}
	}
	return stated
}

// servicePorts maps each Service port name to its published port and the
// container port it forwards to.
func servicePorts(svc *corev1.Service) map[string][2]int32 {
	ports := make(map[string][2]int32, len(svc.Spec.Ports))
	for _, p := range svc.Spec.Ports {
		ports[p.Name] = [2]int32{p.Port, p.TargetPort.IntVal}
	}
	return ports
}

func itoa(port int32) string {
	return strconv.Itoa(int(port))
}
