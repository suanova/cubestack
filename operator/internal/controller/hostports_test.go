package controller

import (
	"strconv"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
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
