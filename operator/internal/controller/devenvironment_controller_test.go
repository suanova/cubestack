/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"fmt"
	"slices"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	eventsv1 "k8s.io/api/events/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/events"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

const (
	testDevImage          = "harbor.local/ai-images/base-cuda:11.8-pytorch2.2"
	testMismatchImage     = "harbor.local/ai-images/base-maca:1.0"
	testCPUImage          = "harbor.local/ai-images/ssh-ubuntu22.04:latest"
	testGPUResource       = "nvidia.com/gpu"
	testDevEnvGatewayName = "test-gw"
	testGatewayIP         = "1.2.3.4"
	testGRPCPortName      = "grpc"
	testJupyterName       = "jupyter"
	testRuntimeUser       = "jovyan"
	testUserSSHKey        = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ sample-key alice@example.com"
)

// webRootPath is the published web path prefix for environments in the test
// namespace (design §6.4: /dev/<ns>/<env>/).
var webRootPath = "/dev/" + testNamespace + "/"

// validDevEnvironment mirrors the API package fixture (minus the SSH config,
// which individual tests enable when they need it).
func validDevEnvironment(name string) *aiv1alpha1.DevEnvironment {
	return &aiv1alpha1.DevEnvironment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		Spec: aiv1alpha1.DevEnvironmentSpec{
			Type:    aiv1alpha1.DevEnvironmentTypeJupyter,
			Image:   testDevImage,
			Running: true,
			Resources: aiv1alpha1.ResourcesSpec{
				GPUType:  aiv1alpha1.GPUTypeNVIDIA,
				GPUCount: ptrTo(int32(1)),
				CPU:      "16",
				Memory:   "64Gi",
			},
			Storage: &aiv1alpha1.StorageSpec{
				Size:         "200Gi",
				PVCRetention: aiv1alpha1.PVCRetentionRetain,
				MountPath:    "/workspace",
			},
		},
	}
}

func envKey(name string) client.ObjectKey {
	return client.ObjectKey{Name: name, Namespace: testNamespace}
}

func deleteEnv(name string) {
	env := &aiv1alpha1.DevEnvironment{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace}}
	_ = k8sClient.Delete(ctx, env)
}

func deleteGateway() {
	_ = k8sClient.Delete(ctx, &gatewayv1.Gateway{ObjectMeta: metav1.ObjectMeta{Name: testDevEnvGatewayName, Namespace: testNamespace}})
}

// createStatefulPod fabricates the ordinal-0 pod that a real scheduler and
// kubelet would create for the environment. The pod's name and labels match
// what the controller looks up, so the fabricated status drives the phase.
func createStatefulPod(env *aiv1alpha1.DevEnvironment, ready bool, waiting *corev1.ContainerStateWaiting) {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      podName(env),
			Namespace: env.Namespace,
			Labels:    map[string]string{devEnvironmentLabelKey: env.Name},
		},
		Spec: corev1.PodSpec{
			NodeName:   "node-a",
			Containers: []corev1.Container{{Name: testJupyterName, Image: testDevImage}},
		},
	}
	Expect(k8sClient.Create(ctx, pod)).To(Succeed())
	pod.Status.Phase = corev1.PodRunning
	if ready {
		pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}
	}
	if waiting != nil {
		pod.Status.ContainerStatuses = []corev1.ContainerStatus{{
			Name:  testJupyterName,
			State: corev1.ContainerState{Waiting: waiting},
		}}
	}
	Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())
}

// createBoundPVC fabricates the workspace PVC the StatefulSet controller would
// create and bind; envtest has no provisioner, so the test sets Bound status.
func createBoundPVC(env *aiv1alpha1.DevEnvironment) {
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      workspacePVCName(env),
			Namespace: env.Namespace,
			Labels:    map[string]string{devEnvironmentLabelKey: env.Name},
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("200Gi")},
			},
		},
	}
	Expect(k8sClient.Create(ctx, pvc)).To(Succeed())
	pvc.Status.Phase = corev1.ClaimBound
	Expect(k8sClient.Status().Update(ctx, pvc)).To(Succeed())

	// envtest runs no PVC protection controller, so the apiserver adds a
	// kubernetes.io/pvc-protection finalizer at create time that would block
	// deletion of the workspace PVC. Remove it to simulate a bound-but-idle
	// PVC, which a real protection controller would release on delete.
	pvc.Finalizers = slices.DeleteFunc(pvc.Finalizers, func(f string) bool { return f == "kubernetes.io/pvc-protection" })
	Expect(k8sClient.Update(ctx, pvc)).To(Succeed())
}

// createGateway creates the shared test Gateway, optionally programming its
// status address (a real controller would assign it).
func createGateway(withAddress bool) {
	gw := &gatewayv1.Gateway{
		ObjectMeta: metav1.ObjectMeta{Name: testDevEnvGatewayName, Namespace: testNamespace},
		Spec: gatewayv1.GatewaySpec{
			GatewayClassName: gatewayv1.ObjectName("eg"),
			Listeners: []gatewayv1.Listener{{
				Name:     "http",
				Port:     gatewayv1.PortNumber(80),
				Protocol: gatewayv1.HTTPProtocolType,
			}},
		},
	}
	Expect(k8sClient.Create(ctx, gw)).To(Succeed())
	if withAddress {
		gw.Status.Addresses = []gatewayv1.GatewayStatusAddress{{Type: ptrTo(gatewayv1.IPAddressType), Value: testGatewayIP}}
		Expect(k8sClient.Status().Update(ctx, gw)).To(Succeed())
	}
}

func sshEndpointPort(endpoints []aiv1alpha1.Endpoint) int32 {
	for _, ep := range endpoints {
		if ep.Name == sshPortName {
			return portFromEndpoint(ep.Address)
		}
	}
	return 0
}

// listEventsForEnv returns the events.k8s.io/v1 Events recorded for the named
// DevEnvironment with the given reason. Events accumulate in the test namespace
// across specs under the shared manager, so assertions always filter by the
// unique environment name rather than global counts.
func listEventsForEnv(name, reason string) []eventsv1.Event {
	var evts eventsv1.EventList
	if err := k8sClient.List(ctx, &evts, client.InNamespace(testNamespace)); err != nil {
		return nil
	}
	out := []eventsv1.Event{}
	for _, e := range evts.Items {
		if e.Regarding.Name == name && e.Regarding.Kind == "DevEnvironment" && e.Reason == reason {
			out = append(out, e)
		}
	}
	return out
}

var _ = Describe("DevEnvironment resource helpers", func() {
	Describe("generateJupyterToken", func() {
		It("returns distinct non-empty 32-hex tokens", func() {
			a, err := generateJupyterToken()
			Expect(err).NotTo(HaveOccurred())
			b, err := generateJupyterToken()
			Expect(err).NotTo(HaveOccurred())
			Expect(a).To(HaveLen(32))
			Expect(b).To(MatchRegexp("^[0-9a-f]{32}$"))
			Expect(a).NotTo(Equal(b))
		})
	})

	Describe("allocatePort", func() {
		cfg := DevEnvironmentControllerConfig{SSHPortRangeStart: 20000, SSHPortRangeEnd: 20002}
		r := &DevEnvironmentReconciler{Config: cfg}
		used := func(ports ...int32) map[int32]bool {
			m := map[int32]bool{}
			for _, p := range ports {
				m[p] = true
			}
			return m
		}
		envWithSSHEndpoint := func(port int32) *aiv1alpha1.DevEnvironment {
			return &aiv1alpha1.DevEnvironment{
				ObjectMeta: metav1.ObjectMeta{Name: "e", Namespace: "ns"},
				Status: aiv1alpha1.DevEnvironmentStatus{Endpoints: []aiv1alpha1.Endpoint{
					{Name: sshPortName, Address: fmt.Sprintf("1.2.3.4:%d", port)},
				}},
			}
		}

		It("keeps the environment's own recorded port when it is still free", func() {
			Expect(r.allocatePort(envWithSSHEndpoint(20001), sshPortName, used(20002))).To(Equal(int32(20001)))
		})

		It("skips ports used by other environments and picks the lowest free", func() {
			env := envWithSSHEndpoint(0)
			env.Status.Endpoints = nil
			Expect(r.allocatePort(env, sshPortName, used(20000))).To(Equal(int32(20001)))
			Expect(r.allocatePort(env, sshPortName, used(20000, 20001))).To(Equal(int32(20002)))
		})

		It("does not reuse its own recorded port when another environment now holds it", func() {
			Expect(r.allocatePort(envWithSSHEndpoint(20001), sshPortName, used(20001))).To(Equal(int32(20000)))
		})

		It("returns 0 when the whole configured range is used", func() {
			env := envWithSSHEndpoint(0)
			env.Status.Endpoints = nil
			Expect(r.allocatePort(env, sshPortName, used(20000, 20001, 20002))).To(Equal(int32(0)))
		})
	})

	Describe("setPhase", func() {
		It("keeps LastTransitionTime stable while the phase name is unchanged", func() {
			status := &aiv1alpha1.DevEnvironmentStatus{}
			setPhase(status, aiv1alpha1.PhasePending, reasonPending)
			first := status.Phase.LastTransitionTime

			setPhase(status, aiv1alpha1.PhasePending, reasonNotScheduled)

			Expect(status.Phase.LastTransitionTime).To(BeIdenticalTo(first))
			Expect(status.Phase.Reason).To(Equal(reasonNotScheduled))
		})

		It("bumps LastTransitionTime when the phase name changes", func() {
			status := &aiv1alpha1.DevEnvironmentStatus{}
			setPhase(status, aiv1alpha1.PhasePending, reasonPending)
			first := status.Phase.LastTransitionTime

			setPhase(status, aiv1alpha1.PhaseRunning, reasonRunning)

			Expect(status.Phase.LastTransitionTime).NotTo(BeIdenticalTo(first))
			Expect(status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
		})
	})

	Describe("condition helper idempotency", func() {
		It("preserves LastTransitionTime when an unchanged condition is re-set", func() {
			conditions := []metav1.Condition{}
			setDevEnvironmentReadyCondition(&conditions, metav1.ConditionTrue, reasonRunning, "ready")
			first := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionReady).LastTransitionTime

			setDevEnvironmentReadyCondition(&conditions, metav1.ConditionTrue, reasonRunning, "ready")

			Expect(meta.FindStatusCondition(conditions, aiv1alpha1.ConditionReady).LastTransitionTime).To(Equal(first))
		})

		It("updates LastTransitionTime only when the condition status flips", func() {
			conditions := []metav1.Condition{}
			setDevEnvironmentReadyCondition(&conditions, metav1.ConditionTrue, reasonRunning, "ready")
			first := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionReady).LastTransitionTime

			setDevEnvironmentReadyCondition(&conditions, metav1.ConditionFalse, reasonStopped, "stopped")

			Expect(meta.FindStatusCondition(conditions, aiv1alpha1.ConditionReady).LastTransitionTime).NotTo(Equal(first))
		})
	})
})

var _ = Describe("emitLifecycleTransition", func() {
	// envName is the DevEnvironment used by the specs below.
	const envName = "de-emit"

	// recordedEvent is one Event the reconciler's recorder saw, reduced to the
	// (type, reason) pair the emit calls use.
	type recordedEvent struct {
		typ    string
		reason string
	}

	// newRecorder returns a reconciler wired to an events.FakeRecorder plus a
	// drain that returns every (type, reason) pair recorded since the last call.
	newRecorder := func() (*DevEnvironmentReconciler, func() []recordedEvent) {
		fr := events.NewFakeRecorder(64)
		r := &DevEnvironmentReconciler{Recorder: fr}
		drain := func() []recordedEvent {
			out := []recordedEvent{}
			for {
				select {
				case msg := <-fr.Events:
					// FakeRecorder formats each emit as "<type> <reason> <note>".
					f := strings.Fields(msg)
					if len(f) >= 2 {
						out = append(out, recordedEvent{typ: f[0], reason: f[1]})
					}
				default:
					return out
				}
			}
		}
		return r, drain
	}

	// at returns an environment whose status records the given phase, i.e. the
	// last phase the controller persisted before the reconcile under test.
	at := func(phase aiv1alpha1.PhaseName) *aiv1alpha1.DevEnvironment {
		env := &aiv1alpha1.DevEnvironment{ObjectMeta: metav1.ObjectMeta{Name: envName, Namespace: testNamespace}}
		if phase != "" {
			setPhase(&env.Status, phase, "")
		}
		return env
	}

	It("records each transition exactly once and stays quiet on a repeat of the same phase", func() {
		r, drain := newRecorder()
		pending := at(aiv1alpha1.PhasePending)

		// Entering Running from Pending records one Started Event.
		running := at(aiv1alpha1.PhaseRunning)
		r.emitLifecycleTransition(pending, running)
		Expect(drain()).To(Equal([]recordedEvent{{typ: corev1.EventTypeNormal, reason: eventReasonStarted}}))

		// A later reconcile that derives Running again must not record another.
		r.emitLifecycleTransition(running, at(aiv1alpha1.PhaseRunning))
		Expect(drain()).To(BeEmpty())

		// Running -> Stopped records one Stopped Event; repeats stay quiet.
		stopped := at(aiv1alpha1.PhaseStopped)
		r.emitLifecycleTransition(running, stopped)
		Expect(drain()).To(Equal([]recordedEvent{{typ: corev1.EventTypeNormal, reason: eventReasonStopped}}))
		r.emitLifecycleTransition(stopped, at(aiv1alpha1.PhaseStopped))
		Expect(drain()).To(BeEmpty())

		// Entering Failed records one Warning Failed Event; repeats stay quiet.
		r.emitLifecycleTransition(running, at(aiv1alpha1.PhaseFailed))
		Expect(drain()).To(Equal([]recordedEvent{{typ: corev1.EventTypeWarning, reason: eventReasonFailed}}))
		r.emitLifecycleTransition(at(aiv1alpha1.PhaseFailed), at(aiv1alpha1.PhaseFailed))
		Expect(drain()).To(BeEmpty())
	})

	It("does not record a Stopped Event for an environment that never started", func() {
		r, drain := newRecorder()
		r.emitLifecycleTransition(at(""), at(aiv1alpha1.PhaseStopped))
		Expect(drain()).To(BeEmpty())
	})
})

var _ = Describe("DevEnvironment pod spec rendering", func() {
	Describe("mainContainerPort", func() {
		It("maps jupyter to the 8888 web port", func() {
			Expect(mainContainerPort(aiv1alpha1.DevEnvironmentTypeJupyter)).To(Equal(int32(8888)))
		})

		It("maps ssh to the 22 sshd port", func() {
			Expect(mainContainerPort(aiv1alpha1.DevEnvironmentTypeSSH)).To(Equal(int32(22)))
		})

		It("maps vscode to the 8080 code-server port", func() {
			Expect(mainContainerPort(aiv1alpha1.DevEnvironmentTypeVSCode)).To(Equal(int32(8080)))
		})
	})

	Describe("desiredResources", func() {
		It("requests and limits the nvidia gpu by gpuCount", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{Resources: aiv1alpha1.ResourcesSpec{
				GPUType: aiv1alpha1.GPUTypeNVIDIA, GPUCount: ptrTo(int32(2)),
			}}}
			got := desiredResources(env)
			key := corev1.ResourceName(testGPUResource)
			Expect(got.Requests).To(HaveKey(key))
			Expect(got.Limits).To(HaveKey(key))
			req := got.Requests[key]
			lim := got.Limits[key]
			Expect(req.Value()).To(Equal(int64(2)))
			Expect(lim.Value()).To(Equal(int64(2)))
		})

		It("maps a metax gpuType to the metax-tech.com/gpu resource", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{Resources: aiv1alpha1.ResourcesSpec{
				GPUType: aiv1alpha1.GPUTypeMetaX, GPUCount: ptrTo(int32(1)),
			}}}
			got := desiredResources(env)
			key := corev1.ResourceName("metax-tech.com/gpu")
			Expect(got.Requests).To(HaveKey(key))
			Expect(got.Limits).To(HaveKey(key))
			Expect(got.Requests).NotTo(HaveKey(corev1.ResourceName(testGPUResource)))
		})

		It("maps optional cpu and memory to limits only", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{Resources: aiv1alpha1.ResourcesSpec{
				GPUType: aiv1alpha1.GPUTypeNVIDIA, GPUCount: ptrTo(int32(1)), CPU: "16", Memory: "32Gi",
			}}}
			got := desiredResources(env)
			Expect(got.Limits.Cpu().Cmp(resource.MustParse("16"))).To(Equal(0))
			Expect(got.Limits.Memory().Cmp(resource.MustParse("32Gi"))).To(Equal(0))
			Expect(got.Requests).NotTo(HaveKey(corev1.ResourceCPU))
			Expect(got.Requests).NotTo(HaveKey(corev1.ResourceMemory))
		})

		It("omits the gpu entirely when gpuCount is 0", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{Resources: aiv1alpha1.ResourcesSpec{
				GPUType: aiv1alpha1.GPUTypeMetaX, GPUCount: ptrTo(int32(0)), CPU: "4", Memory: "8Gi",
			}}}
			got := desiredResources(env)
			// Neither vendor: a zero request would still pin the pod to a node
			// advertising that resource.
			Expect(got.Requests).NotTo(HaveKey(corev1.ResourceName(testGPUResource)))
			Expect(got.Requests).NotTo(HaveKey(corev1.ResourceName("metax-tech.com/gpu")))
			Expect(got.Limits).NotTo(HaveKey(corev1.ResourceName(testGPUResource)))
			Expect(got.Limits).NotTo(HaveKey(corev1.ResourceName("metax-tech.com/gpu")))
			Expect(got.Limits.Cpu().Cmp(resource.MustParse("4"))).To(Equal(0))
			Expect(got.Limits.Memory().Cmp(resource.MustParse("8Gi"))).To(Equal(0))
		})

		It("treats an unset gpuCount as the schema default of 1", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{Resources: aiv1alpha1.ResourcesSpec{
				GPUType: aiv1alpha1.GPUTypeNVIDIA,
			}}}
			got := desiredResources(env)
			key := corev1.ResourceName(testGPUResource)
			Expect(got.Requests).To(HaveKey(key))
			req := got.Requests[key]
			lim := got.Limits[key]
			Expect(req.Value()).To(Equal(int64(1)))
			Expect(lim.Value()).To(Equal(int64(1)))
		})
	})

	Describe("brandMismatchReason", func() {
		DescribeTable("gates the image brand against the requested accelerator",
			func(image string, gpuType aiv1alpha1.GPUType, gpuCount *int32, wantMatch bool) {
				env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{
					Image:     image,
					Resources: aiv1alpha1.ResourcesSpec{GPUType: gpuType, GPUCount: gpuCount},
				}}
				reason := brandMismatchReason(env)
				if wantMatch {
					Expect(reason).To(BeEmpty())
				} else {
					Expect(reason).NotTo(BeEmpty())
				}
			},
			Entry("nvidia with a base-cuda image matches", testDevImage, aiv1alpha1.GPUTypeNVIDIA, ptrTo(int32(1)), true),
			Entry("nvidia with a base-maca image mismatches", testMismatchImage, aiv1alpha1.GPUTypeNVIDIA, ptrTo(int32(1)), false),
			Entry("metax with a base-cuda image mismatches", testDevImage, aiv1alpha1.GPUTypeMetaX, ptrTo(int32(1)), false),
			// No accelerator ⇒ nothing to match, whatever the image or gpuType.
			Entry("gpuCount 0 exempts a non-brand image", testCPUImage, aiv1alpha1.GPUTypeNVIDIA, ptrTo(int32(0)), true),
			Entry("gpuCount 0 exempts a mismatched image", testMismatchImage, aiv1alpha1.GPUTypeNVIDIA, ptrTo(int32(0)), true),
		)

		It("names the CPU-only escape in the mismatch message", func() {
			env := &aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{
				Image:     testMismatchImage,
				Resources: aiv1alpha1.ResourcesSpec{GPUType: aiv1alpha1.GPUTypeNVIDIA, GPUCount: ptrTo(int32(1))},
			}}
			Expect(brandMismatchReason(env)).To(ContainSubstring("gpuCount: 0"))
		})
	})

	Describe("desiredSecurityContext", func() {
		It("defaults a nil runtime to non-root uid and gid 1000", func() {
			sc := desiredSecurityContext(nil)
			Expect(sc.RunAsNonRoot).To(Equal(ptrTo(true)))
			Expect(sc.RunAsUser).To(Equal(ptrTo(int64(1000))))
			Expect(sc.RunAsGroup).To(Equal(ptrTo(int64(1000))))
			Expect(sc.Privileged).To(BeNil())
		})

		It("keeps the non-root defaults when runtime has no security context", func() {
			sc := desiredSecurityContext(&aiv1alpha1.RuntimeSpec{Command: []string{"sleep"}})
			Expect(sc.RunAsNonRoot).To(Equal(ptrTo(true)))
			Expect(sc.RunAsUser).To(Equal(ptrTo(int64(1000))))
			Expect(sc.RunAsGroup).To(Equal(ptrTo(int64(1000))))
		})

		It("honors runAsUser=0 as root and disables runAsNonRoot", func() {
			sc := desiredSecurityContext(&aiv1alpha1.RuntimeSpec{SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))}})
			Expect(sc.RunAsNonRoot).To(Equal(ptrTo(false)))
			Expect(sc.RunAsUser).To(Equal(ptrTo(int64(0))))
			Expect(sc.RunAsGroup).To(Equal(ptrTo(int64(1000))))
		})

		It("honors the explicit runAsGroup when root is requested", func() {
			sc := desiredSecurityContext(&aiv1alpha1.RuntimeSpec{SecurityContext: &aiv1alpha1.RuntimeSecurityContext{
				RunAsUser: ptrTo(int64(0)), RunAsGroup: ptrTo(int64(2000)),
			}})
			Expect(sc.RunAsNonRoot).To(Equal(ptrTo(false)))
			Expect(sc.RunAsUser).To(Equal(ptrTo(int64(0))))
			Expect(sc.RunAsGroup).To(Equal(ptrTo(int64(2000))))
		})

		It("keeps runAsNonRoot enabled for an explicit non-root user", func() {
			sc := desiredSecurityContext(&aiv1alpha1.RuntimeSpec{SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(1001))}})
			Expect(sc.RunAsNonRoot).To(Equal(ptrTo(true)))
			Expect(sc.RunAsUser).To(Equal(ptrTo(int64(1001))))
		})
	})

	Describe("resolveMountPath", func() {
		// The path depends only on spec.storage.mountPath and the runtime identity,
		// so the fixture carries nothing else.
		env := func(mutate func(*aiv1alpha1.DevEnvironmentSpec)) *aiv1alpha1.DevEnvironment {
			e := &aiv1alpha1.DevEnvironment{}
			if mutate != nil {
				mutate(&e.Spec)
			}
			return e
		}

		It("falls back to the platform default when nothing is set", func() {
			// The default account is "user", but an unset spec.runtime.user means
			// /workspace — not /home/user.
			Expect(resolveMountPath(env(nil))).To(Equal("/workspace"))
		})

		It("derives /home/<user> from a named account", func() {
			Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
				s.Runtime = &aiv1alpha1.RuntimeSpec{User: testRuntimeUser}
			}))).To(Equal("/home/jovyan"))
		})

		It("derives /root when the container runs as root", func() {
			Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
				s.Runtime = &aiv1alpha1.RuntimeSpec{SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))}}
			}))).To(Equal("/root"))
		})

		It("lets an explicit mountPath win over the derivation", func() {
			Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
				s.Runtime = &aiv1alpha1.RuntimeSpec{User: testRuntimeUser}
				s.Storage = &aiv1alpha1.StorageSpec{MountPath: "/mnt/data"}
			}))).To(Equal("/mnt/data"))
		})

		It("prefers root's home when root is requested alongside a named account", func() {
			// Contradictory config: the container runs as root, so /root is the
			// home the workspace has to follow.
			Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
				s.Runtime = &aiv1alpha1.RuntimeSpec{
					User:            "alice",
					SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(0))},
				}
			}))).To(Equal("/root"))
		})

		It("keeps an explicit non-root runAsUser on the account's home", func() {
			Expect(resolveMountPath(env(func(s *aiv1alpha1.DevEnvironmentSpec) {
				s.Runtime = &aiv1alpha1.RuntimeSpec{
					User:            "jovyan",
					SecurityContext: &aiv1alpha1.RuntimeSecurityContext{RunAsUser: ptrTo(int64(1000))},
				}
			}))).To(Equal("/home/jovyan"))
		})
	})

	Describe("runtimeUser", func() {
		It("advertises the account the spec names", func() {
			Expect(runtimeUser(&aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{
				Runtime: &aiv1alpha1.RuntimeSpec{User: testRuntimeUser},
			}})).To(Equal(testRuntimeUser))
		})

		It("falls back to the platform default account", func() {
			Expect(runtimeUser(&aiv1alpha1.DevEnvironment{})).To(Equal("user"))
		})

		It("falls back when the runtime is present but names no account", func() {
			Expect(runtimeUser(&aiv1alpha1.DevEnvironment{Spec: aiv1alpha1.DevEnvironmentSpec{
				Runtime: &aiv1alpha1.RuntimeSpec{Command: []string{"sleep"}},
			}})).To(Equal("user"))
		})
	})

	Describe("desiredPodSpec", func() {
		newEnv := func() *aiv1alpha1.DevEnvironment {
			return &aiv1alpha1.DevEnvironment{
				ObjectMeta: metav1.ObjectMeta{Name: "de-render", Namespace: "default"},
				Spec: aiv1alpha1.DevEnvironmentSpec{
					Type: aiv1alpha1.DevEnvironmentTypeVSCode, Image: testDevImage,
				},
			}
		}
		render := func(mut func(*aiv1alpha1.DevEnvironment)) corev1.PodSpec {
			env := newEnv()
			if mut != nil {
				mut(env)
			}
			return (&DevEnvironmentReconciler{}).desiredPodSpec(env)
		}

		It("pins the pod to the compute pool and probes the main port per type", func() {
			for _, tt := range []struct {
				typ  aiv1alpha1.DevEnvironmentType
				port int32
			}{
				{typ: aiv1alpha1.DevEnvironmentTypeJupyter, port: 8888},
				{typ: aiv1alpha1.DevEnvironmentTypeSSH, port: 22},
				{typ: aiv1alpha1.DevEnvironmentTypeVSCode, port: 8080},
			} {
				spec := render(func(env *aiv1alpha1.DevEnvironment) { env.Spec.Type = tt.typ })
				Expect(spec.NodeSelector).To(Equal(map[string]string{computeNodePoolLabelKey: computeNodePoolValue}))
				Expect(spec.Containers).To(HaveLen(1))
				c := spec.Containers[0]
				Expect(c.Name).To(Equal(string(tt.typ)))
				Expect(c.Image).To(Equal(testDevImage))
				Expect(c.ReadinessProbe).NotTo(BeNil())
				Expect(c.ReadinessProbe.ProbeHandler.TCPSocket.Port.IntVal).To(Equal(tt.port))
			}
		})

		It("copies runtime command, args and env onto the container", func() {
			command := []string{"/bin/sh"}
			args := []string{"-c", "sleep infinity"}
			runtimeEnv := []corev1.EnvVar{
				{Name: "FOO", Value: "bar"},
				{Name: "FROM_SECRET", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: "creds"}, Key: "k",
				}}},
			}
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{Command: command, Args: args, Env: runtimeEnv}
			})
			c := spec.Containers[0]
			Expect(c.Command).To(Equal(command))
			Expect(c.Args).To(Equal(args))
			Expect(c.Env).To(Equal(runtimeEnv))
		})

		It("mounts the workspace claim at spec.storage.mountPath and none when storage is omitted", func() {
			mountPath := "/workspace"
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Storage = &aiv1alpha1.StorageSpec{MountPath: mountPath}
			})
			Expect(spec.Containers[0].VolumeMounts).To(Equal([]corev1.VolumeMount{{
				Name: workspaceClaimName, MountPath: mountPath,
			}}))

			spec = render(nil)
			Expect(spec.Containers[0].VolumeMounts).To(BeEmpty())
		})

		It("mounts spec.volumes with pvc, path, subPath and readOnly fidelity", func() {
			ro := aiv1alpha1.VolumeMount{Name: "artifacts", PVCName: "artifacts-pvc", MountPath: "/data/artifacts", ReadOnly: true, SubPath: "artifacts/v3"}
			rw := aiv1alpha1.VolumeMount{Name: "cache", PVCName: "cache-pvc", MountPath: "/cache"}
			spec := render(func(env *aiv1alpha1.DevEnvironment) {
				env.Spec.Volumes = []aiv1alpha1.VolumeMount{ro, rw}
			})
			c := spec.Containers[0]
			Expect(c.VolumeMounts).To(Equal([]corev1.VolumeMount{
				{Name: ro.Name, MountPath: ro.MountPath, ReadOnly: ro.ReadOnly, SubPath: ro.SubPath},
				{Name: rw.Name, MountPath: rw.MountPath, ReadOnly: rw.ReadOnly},
			}))
			Expect(spec.Volumes).To(Equal([]corev1.Volume{
				{Name: ro.Name, VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: ro.PVCName, ReadOnly: ro.ReadOnly}}},
				{Name: rw.Name, VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: rw.PVCName, ReadOnly: rw.ReadOnly}}},
			}))
		})

		It("mounts the ssh keys secret for an exposed ssh type", func() {
			var env *aiv1alpha1.DevEnvironment
			spec := render(func(e *aiv1alpha1.DevEnvironment) { env = e; e.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH })
			Expect(spec.Containers[0].VolumeMounts).To(Equal([]corev1.VolumeMount{{
				Name: sshKeysVolumeName, MountPath: "/etc/cubestack/ssh", ReadOnly: true,
			}}))
			Expect(spec.Volumes).To(Equal([]corev1.Volume{{
				Name:         sshKeysVolumeName,
				VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: sshSecretName(env), DefaultMode: ptrTo(int32(0o644))}},
			}}))
		})

		It("injects JUPYTER_TOKEN from the managed auth secret and drops a user override", func() {
			env := newEnv()
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeJupyter
			env.Spec.Runtime = &aiv1alpha1.RuntimeSpec{Env: []corev1.EnvVar{
				{Name: jupyterTokenEnv, Value: "user-override"},
				{Name: "KEEP", Value: "me"},
			}}
			c := (&DevEnvironmentReconciler{}).desiredPodSpec(env).Containers[0]
			Expect(c.Env).To(Equal([]corev1.EnvVar{
				{Name: "KEEP", Value: "me"},
				{Name: jupyterTokenEnv, ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: authSecretName(env)},
					Key:                  jupyterTokenKey,
				}}},
			}))
			// A jupyter environment without ssh.enabled mounts no ssh volume.
			Expect(c.VolumeMounts).To(BeEmpty())
		})
	})
})

var _ = Describe("DevEnvironment controller", func() {
	Context("provisioning", func() {
		It("creates the StatefulSet with the desired pod template", func() {
			env := validDevEnvironment("de-shape")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Replicas).To(Equal(ptrTo(int32(1))))
				g.Expect(sts.Spec.ServiceName).To(Equal(env.Name))
				g.Expect(sts.Spec.Selector.MatchLabels).To(HaveKeyWithValue(devEnvironmentLabelKey, env.Name))
				g.Expect(sts.Spec.Template.Spec.NodeSelector).To(HaveKeyWithValue(computeNodePoolLabelKey, computeNodePoolValue))
				g.Expect(sts.Spec.Template.Spec.Containers).To(HaveLen(1))
				c := sts.Spec.Template.Spec.Containers[0]
				g.Expect(c.Image).To(Equal(testDevImage))
				gpuLimit := c.Resources.Limits[corev1.ResourceName(testGPUResource)]
				gpuRequest := c.Resources.Requests[corev1.ResourceName(testGPUResource)]
				g.Expect(gpuLimit.Value()).To(Equal(int64(1)))
				g.Expect(gpuRequest.Value()).To(Equal(int64(1)))
				g.Expect(c.SecurityContext.RunAsUser).To(Equal(ptrTo(int64(1000))))
				g.Expect(c.SecurityContext.RunAsNonRoot).To(Equal(ptrTo(true)))
				g.Expect(c.ReadinessProbe).NotTo(BeNil())
				g.Expect(sts.Spec.VolumeClaimTemplates).To(HaveLen(1))
				g.Expect(sts.Spec.VolumeClaimTemplates[0].Name).To(Equal(workspaceClaimName))
				g.Expect(sts.Spec.VolumeClaimTemplates[0].Spec.AccessModes).To(ContainElement(corev1.ReadWriteMany))
				g.Expect(sts.Spec.VolumeClaimTemplates[0].Spec.StorageClassName).To(Equal(ptrTo(workspaceStorageClassName)))
				g.Expect(sts.Spec.PersistentVolumeClaimRetentionPolicy.WhenDeleted).To(Equal(appsv1.RetainPersistentVolumeClaimRetentionPolicyType))
				g.Expect(sts.Spec.PersistentVolumeClaimRetentionPolicy.WhenScaled).To(Equal(appsv1.RetainPersistentVolumeClaimRetentionPolicyType))
				g.Expect(metav1.GetControllerOf(sts).UID).To(Equal(env.UID))
			}, "15s", "200ms").Should(Succeed())
		})

		It("scales the StatefulSet with running and reports Stopped", func() {
			env := validDevEnvironment("de-scale")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Replicas).To(Equal(ptrTo(int32(1))))
			}, "15s", "200ms").Should(Succeed())

			fresh := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), fresh)).To(Succeed())
			fresh.Spec.Running = false
			Expect(k8sClient.Update(ctx, fresh)).To(Succeed())

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Replicas).To(Equal(ptrTo(int32(0))))

				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseStopped))
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionReady)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("fails a gpuType/image brand mismatch without provisioning", func() {
			env := validDevEnvironment("de-brand-bad")
			env.Spec.Image = "harbor.local/ai-images/base-maca:1.0"
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionBrandMatchValid)).To(BeTrue())
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionReady)).To(BeTrue())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseFailed))
				g.Expect(got.Status.Phase.Reason).To(Equal(reasonBrandMismatch))
			}, "15s", "200ms").Should(Succeed())

			sts := &appsv1.StatefulSet{}
			Expect(apierrors.IsNotFound(k8sClient.Get(ctx, envKey(env.Name), sts))).To(BeTrue())
		})

		It("accepts a matching image brand and provisions", func() {
			env := validDevEnvironment("de-brand-good")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionBrandMatchValid)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			sts := &appsv1.StatefulSet{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
		})

		It("provisions a CPU-only environment from a non-brand image", func() {
			env := validDevEnvironment("de-cpu-only")
			// A CPU image the brand gate would reject if a GPU were requested,
			// and a gpuType that does not match it either.
			env.Spec.Resources.GPUCount = ptrTo(int32(0))
			env.Spec.Image = testCPUImage
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionBrandMatchValid)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionTrue))
				g.Expect(cond.Reason).To(Equal(reasonNotApplicable))
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).NotTo(Equal(aiv1alpha1.PhaseFailed))
			}, "15s", "200ms").Should(Succeed())

			sts := &appsv1.StatefulSet{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
			c := sts.Spec.Template.Spec.Containers[0]
			// No vendor key in either map: a zero request would still pin the
			// pod to a node advertising that resource.
			Expect(c.Resources.Requests).NotTo(HaveKey(corev1.ResourceName(testGPUResource)))
			Expect(c.Resources.Limits).NotTo(HaveKey(corev1.ResourceName(testGPUResource)))
			Expect(c.Resources.Limits).NotTo(HaveKey(corev1.ResourceName("metax-tech.com/gpu")))
		})

		It("withdraws compute and routes when a running environment becomes mismatched", func() {
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-brand-transition")
			env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)
			createStatefulPod(env, true, nil)
			// The synthetic pod has no owner reference, so deleteEnv cannot
			// remove it; clean it up here so it does not leak into later specs.
			defer func() {
				_ = k8sClient.Delete(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: podName(env), Namespace: env.Namespace}})
			}()

			// The environment provisions and runs: the StatefulSet is scaled to
			// 1 and the routes are published.
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Replicas).NotTo(BeNil())
				g.Expect(*sts.Spec.Replicas).To(Equal(int32(1)))
			}, "15s", "200ms").Should(Succeed())

			// Editing the image into a brand mismatch must withdraw the
			// previously-provisioned compute and access before marking Failed.
			got := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			got.Spec.Image = "harbor.local/ai-images/base-maca:1.0"
			Expect(k8sClient.Update(ctx, got)).To(Succeed())

			Eventually(func(g Gomega) {
				got2 := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got2)).To(Succeed())
				g.Expect(got2.Status.Phase).NotTo(BeNil())
				g.Expect(got2.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseFailed))
				g.Expect(got2.Status.Phase.Reason).To(Equal(reasonBrandMismatch))
				g.Expect(got2.Status.Endpoints).To(BeEmpty())
				// Compute is withdrawn: the StatefulSet is scaled to zero.
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Replicas).NotTo(BeNil())
				g.Expect(*sts.Spec.Replicas).To(Equal(int32(0)))
				// Access is withdrawn: no HTTP or TCP routes remain.
				var hrs gatewayv1.HTTPRouteList
				g.Expect(k8sClient.List(ctx, &hrs, client.InNamespace(testNamespace), client.MatchingLabels{devEnvironmentLabelKey: env.Name})).To(Succeed())
				g.Expect(hrs.Items).To(BeEmpty())
				var trs gatewayv1.TCPRouteList
				g.Expect(k8sClient.List(ctx, &trs, client.InNamespace(testNamespace), client.MatchingLabels{devEnvironmentLabelKey: env.Name})).To(Succeed())
				g.Expect(trs.Items).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("storage", func() {
		It("reports StorageReady true once the workspace PVC is bound", func() {
			env := validDevEnvironment("de-storage-bound")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)
			createBoundPVC(env)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionStorageReady)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionTrue))
				g.Expect(cond.Reason).To(Equal(reasonBound))
			}, "15s", "200ms").Should(Succeed())
		})

		It("reports StorageReady false while the workspace PVC is missing", func() {
			env := validDevEnvironment("de-storage-missing")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionStorageReady)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal(reasonWaiting))
			}, "15s", "200ms").Should(Succeed())
		})

		It("treats environments without workspace storage as StorageReady", func() {
			env := validDevEnvironment("de-storage-none")
			env.Spec.Storage = nil
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionStorageReady)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionTrue))
				g.Expect(cond.Reason).To(Equal(reasonNotApplicable))
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("phase", func() {
		It("reports Pending while the pod does not exist", func() {
			env := validDevEnvironment("de-phase-no-pod")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhasePending))
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionPodScheduled)).To(BeTrue())
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionReady)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("reports Running when the pod is running and ready", func() {
			env := validDevEnvironment("de-phase-running")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)
			createStatefulPod(env, true, nil)
			createBoundPVC(env)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionPodScheduled)).To(BeTrue())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionReady)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("reports Failed when the pod is crash-looping", func() {
			env := validDevEnvironment("de-phase-failed")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)
			createStatefulPod(env, false,
				&corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff", Message: "back-off"})

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseFailed))
				g.Expect(got.Status.Phase.Reason).To(Equal(crashLoopBackOff))
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionReady)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("reports Running but not Ready while the pod runs without passing readiness", func() {
			env := validDevEnvironment("de-phase-running-unready")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)
			createStatefulPod(env, false, nil)
			defer func() {
				_ = k8sClient.Delete(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: podName(env), Namespace: env.Namespace}})
			}()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionPodScheduled)).To(BeTrue())
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionReady)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("status generation", func() {
		It("tracks observedGeneration and re-derives status after a spec change", func() {
			env := validDevEnvironment("de-gen")
			env.Spec.Running = false
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.ObservedGeneration).To(Equal(got.Generation))
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseStopped))
			}, "15s", "200ms").Should(Succeed())

			// A spec edit bumps metadata.generation; the status is re-derived for
			// the new generation (observedGeneration catches up), never left stale.
			Eventually(func(g Gomega) {
				cur := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), cur)).To(Succeed())
				cur.Spec.Running = true
				g.Expect(k8sClient.Update(ctx, cur)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.ObservedGeneration).To(Equal(got.Generation))
				g.Expect(got.Status.Phase).NotTo(BeNil())
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("lifecycle events", func() {
		It("records a Created event on adoption and a Started event on running", func() {
			env := validDevEnvironment("de-ev-start")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				g.Expect(listEventsForEnv(env.Name, eventReasonCreated)).NotTo(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			createStatefulPod(env, true, nil)
			defer func() {
				_ = k8sClient.Delete(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: podName(env), Namespace: env.Namespace}})
			}()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
				g.Expect(listEventsForEnv(env.Name, eventReasonStarted)).NotTo(BeEmpty())
			}, "15s", "200ms").Should(Succeed())
		})

		It("records a Stopped event when running is set to false", func() {
			env := validDevEnvironment("de-ev-stop")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)
			createStatefulPod(env, true, nil)
			defer func() {
				_ = k8sClient.Delete(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: podName(env), Namespace: env.Namespace}})
			}()

			// Converge to Running first, so the later stop is a real transition.
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseRunning))
			}, "15s", "200ms").Should(Succeed())

			Eventually(func(g Gomega) {
				cur := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), cur)).To(Succeed())
				cur.Spec.Running = false
				g.Expect(k8sClient.Update(ctx, cur)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseStopped))
				g.Expect(listEventsForEnv(env.Name, eventReasonStopped)).NotTo(BeEmpty())
			}, "15s", "200ms").Should(Succeed())
		})

		It("records a Warning Failed event on a gpuType/image brand mismatch", func() {
			env := validDevEnvironment("de-ev-fail")
			env.Spec.Image = testMismatchImage
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.Phase).NotTo(BeNil())
				g.Expect(got.Status.Phase.Name).To(Equal(aiv1alpha1.PhaseFailed))
				evts := listEventsForEnv(env.Name, eventReasonFailed)
				g.Expect(evts).NotTo(BeEmpty())
				g.Expect(evts[0].Type).To(Equal(corev1.EventTypeWarning))
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("ssh", func() {
		It("generates and records the SSH secret for an ssh environment", func() {
			env := validDevEnvironment("de-ssh")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.SSHKeysSecret).To(Equal(&corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: sshSecretName(env)},
					Key:                  sshAuthorizedKeysKey,
				}))

				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshSecretName(env)), s)).To(Succeed())
				g.Expect(s.Data).To(HaveKey(sshHostKeyKey))
				g.Expect(s.Data).To(HaveKey(sshHostPubKeyKey))
				g.Expect(string(s.Data[sshHostPubKeyKey])).To(HavePrefix("ssh-ed25519 "))
				g.Expect(s.Data).To(HaveKey(sshAuthorizedKeysKey))
			}, "15s", "200ms").Should(Succeed())
		})

		It("copies user public keys into the managed authorized_keys", func() {
			keys := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "dev-alice-ssh-keys",
					Namespace: testNamespace,
					Labels:    map[string]string{devEnvSSHKeysDelegatedLabel: devEnvSSHKeysDelegatedValue},
				},
				Data: map[string][]byte{sshUserKeysDefaultKey: []byte(testUserSSHKey)},
			}
			Expect(k8sClient.Create(ctx, keys)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, keys) }()

			env := validDevEnvironment("de-ssh-keys")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			env.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				KeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: keys.Name},
					Key:                  sshUserKeysDefaultKey,
				},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshSecretName(env)), s)).To(Succeed())
				g.Expect(string(s.Data[sshAuthorizedKeysKey])).To(Equal(testUserSSHKey))
				g.Expect(s.Data).To(HaveKey(sshHostKeyKey))
			}, "15s", "200ms").Should(Succeed())
		})

		It("refreshes authorized_keys when the referenced keys Secret changes", func() {
			rotated := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI rotated-key alice@example.com"
			keys := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "dev-alice-rotate-keys",
					Namespace: testNamespace,
					Labels:    map[string]string{devEnvSSHKeysDelegatedLabel: devEnvSSHKeysDelegatedValue},
				},
				Data: map[string][]byte{sshUserKeysDefaultKey: []byte(testUserSSHKey)},
			}
			Expect(k8sClient.Create(ctx, keys)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, keys) }()

			env := validDevEnvironment("de-rotate-keys")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			env.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				KeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: keys.Name},
					Key:                  sshUserKeysDefaultKey,
				},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var hostKey []byte
			Eventually(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshSecretName(env)), s)).To(Succeed())
				g.Expect(string(s.Data[sshAuthorizedKeysKey])).To(Equal(testUserSSHKey))
				hostKey = s.Data[sshHostKeyKey]
			}, "15s", "200ms").Should(Succeed())

			// Rotate the user's keys: the watch on spec.ssh.keysSecret re-reconciles
			// the environment, so the managed authorized_keys follows while the host
			// keypair stays stable.
			freshKeys := &corev1.Secret{}
			Expect(k8sClient.Get(ctx, envKey(keys.Name), freshKeys)).To(Succeed())
			freshKeys.Data[sshUserKeysDefaultKey] = []byte(rotated)
			Expect(k8sClient.Update(ctx, freshKeys)).To(Succeed())

			Eventually(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(sshSecretName(env)), s)).To(Succeed())
				g.Expect(string(s.Data[sshAuthorizedKeysKey])).To(Equal(rotated))
				g.Expect(s.Data[sshHostKeyKey]).To(Equal(hostKey))
			}, "15s", "200ms").Should(Succeed())
		})

		It("rejects an undelegated keysSecret without copying its data", func() {
			// A Secret without the delegation label must never back
			// authorized_keys: copying it would let the environment creator read
			// any same-namespace Secret through the managed SSH secret.
			leaked := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Name: "dev-secret-undelegated", Namespace: testNamespace},
				Data:       map[string][]byte{sshUserKeysDefaultKey: []byte(testUserSSHKey)},
			}
			Expect(k8sClient.Create(ctx, leaked)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, leaked) }()

			env := validDevEnvironment("de-undelegated")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			env.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				KeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: leaked.Name},
					Key:                  sshUserKeysDefaultKey,
				},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			// The reconcile aborts on the undelegated secret before recording
			// the SSH secret reference or creating the managed secret, so the
			// referenced keys can never surface as authorized_keys.
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Status.SSHKeysSecret).To(BeNil())
				s := &corev1.Secret{}
				g.Expect(apierrors.IsNotFound(k8sClient.Get(ctx, envKey(sshSecretName(env)), s))).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("jupyter token", func() {
		It("creates the <env>-auth Secret and injects JUPYTER_TOKEN into the workload", func() {
			env := validDevEnvironment("de-token")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(authSecretName(env)), s)).To(Succeed())
				g.Expect(string(s.Data[jupyterTokenKey])).To(HaveLen(32))
				g.Expect(metav1.GetControllerOf(s).UID).To(Equal(env.UID))
				g.Expect(s.Labels).To(HaveKeyWithValue(devEnvironmentLabelKey, env.Name))

				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				var injected *corev1.EnvVar
				for i := range sts.Spec.Template.Spec.Containers[0].Env {
					if sts.Spec.Template.Spec.Containers[0].Env[i].Name == jupyterTokenEnv {
						injected = &sts.Spec.Template.Spec.Containers[0].Env[i]
					}
				}
				g.Expect(injected).NotTo(BeNil())
				g.Expect(injected.ValueFrom).NotTo(BeNil())
				g.Expect(injected.ValueFrom.SecretKeyRef.Name).To(Equal(authSecretName(env)))
				g.Expect(injected.ValueFrom.SecretKeyRef.Key).To(Equal(jupyterTokenKey))
			}, "15s", "200ms").Should(Succeed())
		})

		It("keeps the token across reconciles and refills an emptied token key", func() {
			env := validDevEnvironment("de-token-stable")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var original string
			Eventually(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(authSecretName(env)), s)).To(Succeed())
				original = string(s.Data[jupyterTokenKey])
				g.Expect(original).To(HaveLen(32))
			}, "15s", "200ms").Should(Succeed())

			// Further reconciles (e.g. a stop/start) must not rotate the token:
			// the token is generated once and kept while non-empty.
			fresh := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), fresh)).To(Succeed())
			fresh.Spec.Running = false
			Expect(k8sClient.Update(ctx, fresh)).To(Succeed())
			Consistently(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(authSecretName(env)), s)).To(Succeed())
				g.Expect(string(s.Data[jupyterTokenKey])).To(Equal(original))
			}, "2s", "200ms").Should(Succeed())

			// Capture the pod-template token revision and STS spec hash while the
			// original token is in effect, so a later refill can be proven to roll
			// the workload onto the new token.
			var hashBefore string
			Eventually(func(g Gomega) {
				gotSTS := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), gotSTS)).To(Succeed())
				// JUPYTER_TOKEN is read at container start, so the pod template
				// records a non-sensitive digest of the token in effect.
				g.Expect(gotSTS.Spec.Template.Annotations[jupyterTokenRevisionAnnotationKey]).To(Equal(jupyterTokenDigest(original)))
				hashBefore = gotSTS.Annotations[stsSpecHashAnnotationKey]
				g.Expect(hashBefore).NotTo(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			// An emptied key is refilled with a fresh token rather than left
			// empty, so the workload's JUPYTER_TOKEN env always resolves.
			s := &corev1.Secret{}
			Expect(k8sClient.Get(ctx, envKey(authSecretName(env)), s)).To(Succeed())
			s.Data[jupyterTokenKey] = []byte("")
			Expect(k8sClient.Update(ctx, s)).To(Succeed())

			Eventually(func(g Gomega) {
				freshSecret := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(authSecretName(env)), freshSecret)).To(Succeed())
				val := string(freshSecret.Data[jupyterTokenKey])
				g.Expect(val).To(HaveLen(32))
				g.Expect(val).NotTo(Equal(original))
			}, "15s", "200ms").Should(Succeed())

			// The refill must roll the workload: the pod template's token revision
			// becomes the digest of the new token and the STS spec hash changes, so
			// applyStatefulSet updates the template and a StatefulSet controller
			// restarts the pod onto the refilled JUPYTER_TOKEN.
			Eventually(func(g Gomega) {
				gotSTS := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), gotSTS)).To(Succeed())
				freshSecret := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(authSecretName(env)), freshSecret)).To(Succeed())
				g.Expect(gotSTS.Spec.Template.Annotations[jupyterTokenRevisionAnnotationKey]).To(Equal(jupyterTokenDigest(string(freshSecret.Data[jupyterTokenKey]))))
				g.Expect(gotSTS.Annotations[stsSpecHashAnnotationKey]).NotTo(Equal(hashBefore))
			}, "15s", "200ms").Should(Succeed())
		})

		It("does not create the token Secret or env for non-jupyter environments", func() {
			env := validDevEnvironment("de-token-ssh")
			env.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				for _, c := range sts.Spec.Template.Spec.Containers {
					for _, v := range c.Env {
						g.Expect(v.Name).NotTo(Equal(jupyterTokenEnv))
					}
				}
				err := k8sClient.Get(ctx, envKey(authSecretName(env)), &corev1.Secret{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("removes the token Secret when the environment is deleted", func() {
			env := validDevEnvironment("de-token-del")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())

			Eventually(func(g Gomega) {
				s := &corev1.Secret{}
				g.Expect(k8sClient.Get(ctx, envKey(authSecretName(env)), s)).To(Succeed())
				g.Expect(s.Data[jupyterTokenKey]).NotTo(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			Expect(k8sClient.Delete(ctx, env)).To(Succeed())

			Eventually(func(g Gomega) {
				err := k8sClient.Get(ctx, envKey(env.Name), &aiv1alpha1.DevEnvironment{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
				err = k8sClient.Get(ctx, envKey(authSecretName(env)), &corev1.Secret{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("retention", func() {
		It("deletes the workspace PVC when pvcRetention=delete", func() {
			env := validDevEnvironment("de-retention-delete")
			env.Spec.Storage.PVCRetention = aiv1alpha1.PVCRetentionDelete
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			createBoundPVC(env)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Finalizers).To(ContainElement(devEnvFinalizer))
			}, "15s", "200ms").Should(Succeed())

			Expect(k8sClient.Delete(ctx, env)).To(Succeed())

			Eventually(func(g Gomega) {
				err := k8sClient.Get(ctx, envKey(env.Name), &aiv1alpha1.DevEnvironment{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
				err = k8sClient.Get(ctx, envKey(env.Name), &appsv1.StatefulSet{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
				err = k8sClient.Get(ctx, client.ObjectKey{Name: workspacePVCName(env), Namespace: env.Namespace}, &corev1.PersistentVolumeClaim{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("retains the workspace PVC when pvcRetention=retain", func() {
			env := validDevEnvironment("de-retention-retain")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			createBoundPVC(env)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Finalizers).To(ContainElement(devEnvFinalizer))
			}, "15s", "200ms").Should(Succeed())

			Expect(k8sClient.Delete(ctx, env)).To(Succeed())

			Eventually(func(g Gomega) {
				err := k8sClient.Get(ctx, envKey(env.Name), &aiv1alpha1.DevEnvironment{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			pvc := &corev1.PersistentVolumeClaim{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: workspacePVCName(env), Namespace: env.Namespace}, pvc)).To(Succeed())
		})

		It("does not delete foreign resources that share the environment's name or labels", func() {
			// Foreign resources occupy the environment's name and labels before
			// the controller provisions anything; none carry an ownerRef to the
			// environment.
			envName := "de-foreign"
			foreignSvc := &corev1.Service{
				ObjectMeta: metav1.ObjectMeta{Name: envName, Namespace: testNamespace},
				Spec:       corev1.ServiceSpec{Ports: []corev1.ServicePort{{Port: 8080}}},
			}
			Expect(k8sClient.Create(ctx, foreignSvc)).To(Succeed())
			foreignHTTP := &gatewayv1.HTTPRoute{
				ObjectMeta: metav1.ObjectMeta{Name: "de-foreign-web", Namespace: testNamespace, Labels: map[string]string{devEnvironmentLabelKey: envName}},
				Spec: gatewayv1.HTTPRouteSpec{
					CommonRouteSpec: gatewayv1.CommonRouteSpec{ParentRefs: []gatewayv1.ParentReference{
						{Group: ptrTo(gatewayv1.Group(gatewayAPIGroup)), Kind: ptrTo(gatewayv1.Kind(gatewayKind)), Namespace: ptrTo(gatewayv1.Namespace(testNamespace)), Name: gatewayv1.ObjectName(testDevEnvGatewayName)},
					}},
					Rules: []gatewayv1.HTTPRouteRule{{BackendRefs: []gatewayv1.HTTPBackendRef{{BackendRef: gatewayv1.BackendRef{
						BackendObjectReference: gatewayv1.BackendObjectReference{Name: gatewayv1.ObjectName("some-svc"), Port: ptrTo(gatewayv1.PortNumber(8080))},
					}}}}},
				},
			}
			Expect(k8sClient.Create(ctx, foreignHTTP)).To(Succeed())
			foreignTCP := &gatewayv1.TCPRoute{
				ObjectMeta: metav1.ObjectMeta{Name: "de-foreign-tcp-9999", Namespace: testNamespace, Labels: map[string]string{devEnvironmentLabelKey: envName}},
				Spec: gatewayv1.TCPRouteSpec{
					CommonRouteSpec: gatewayv1.CommonRouteSpec{ParentRefs: []gatewayv1.ParentReference{
						{Group: ptrTo(gatewayv1.Group(gatewayAPIGroup)), Kind: ptrTo(gatewayv1.Kind(gatewayKind)), Namespace: ptrTo(gatewayv1.Namespace(testNamespace)), Name: gatewayv1.ObjectName(testDevEnvGatewayName)},
					}},
					Rules: []gatewayv1.TCPRouteRule{{BackendRefs: []gatewayv1.BackendRef{{
						BackendObjectReference: gatewayv1.BackendObjectReference{Name: gatewayv1.ObjectName("some-svc"), Port: ptrTo(gatewayv1.PortNumber(8080))},
					}}}},
				},
			}
			Expect(k8sClient.Create(ctx, foreignTCP)).To(Succeed())
			defer func() {
				_ = k8sClient.Delete(ctx, foreignSvc)
				_ = k8sClient.Delete(ctx, foreignHTTP)
				_ = k8sClient.Delete(ctx, foreignTCP)
			}()

			// The controller must not adopt the foreign Service: applying its
			// own Service conflicts, so the environment never provisions.
			env := validDevEnvironment(envName)
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(got.Finalizers).To(ContainElement(devEnvFinalizer))
			}, "15s", "200ms").Should(Succeed())

			Expect(k8sClient.Delete(ctx, env)).To(Succeed())

			Eventually(func(g Gomega) {
				err := k8sClient.Get(ctx, envKey(env.Name), &aiv1alpha1.DevEnvironment{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			// Cleanup deleted nothing it did not own: all three foreign
			// resources survive.
			Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(foreignSvc), foreignSvc)).To(Succeed())
			Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(foreignHTTP), foreignHTTP)).To(Succeed())
			Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(foreignTCP), foreignTCP)).To(Succeed())
		})
	})

	Context("legacy StatefulSet with an RWO workspace claim", func() {
		// A DevEnvironment whose StatefulSet was created before the platform
		// pinned the workspace claim (ReadWriteOnce, no StorageClassName) must
		// stay updatable after an operator upgrade: spec.volumeClaimTemplates is
		// immutable, so the controller preserves the stored claim and applies
		// pod-template/replica changes around it instead of wedging the
		// environment on an immutability error (design §7.2).
		It("keeps the existing claim template and updates the pod template", func() {
			const mismatchedImage = "harbor.local/ai-images/base-maca:1.0"

			env := validDevEnvironment("de-legacy-claim")
			// Seed the environment brand-mismatched so the live reconciler does
			// not race this spec into creating its own StatefulSet: while the
			// brand gate fails, nothing is provisioned, so the legacy StatefulSet
			// seeded below is left in place.
			env.Spec.Image = mismatchedImage
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			legacySTS := &appsv1.StatefulSet{
				ObjectMeta: metav1.ObjectMeta{
					Name:      env.Name,
					Namespace: env.Namespace,
					Labels:    map[string]string{devEnvironmentLabelKey: env.Name},
					Annotations: map[string]string{
						stsSpecHashAnnotationKey: stsSpecHash(env),
					},
				},
				Spec: appsv1.StatefulSetSpec{
					Replicas:    ptrTo(int32(0)),
					ServiceName: env.Name,
					Selector:    &metav1.LabelSelector{MatchLabels: map[string]string{devEnvironmentLabelKey: env.Name}},
					Template: corev1.PodTemplateSpec{
						ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{devEnvironmentLabelKey: env.Name}},
						Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: testJupyterName, Image: mismatchedImage}}},
					},
					VolumeClaimTemplates: []corev1.PersistentVolumeClaim{{
						ObjectMeta: metav1.ObjectMeta{Name: workspaceClaimName},
						Spec: corev1.PersistentVolumeClaimSpec{
							AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
							Resources: corev1.VolumeResourceRequirements{
								Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse(env.Spec.Storage.Size)},
							},
						},
					}},
				},
			}
			Expect(controllerutil.SetControllerReference(env, legacySTS, k8sClient.Scheme())).To(Succeed())
			Expect(k8sClient.Create(ctx, legacySTS)).To(Succeed())
			createBoundPVC(env)

			// The first post-upgrade drift (a real spec edit) must reconcile:
			// repair the image and scale back up without touching the immutable
			// claim template. The controller writes status for this mismatched
			// environment concurrently, so retry the edit on the 409 conflict it
			// can otherwise cause (re-fetching each attempt, as in convergence
			// specs).
			Eventually(func(g Gomega) {
				cur := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), cur)).To(Succeed())
				cur.Spec.Image = testDevImage
				g.Expect(k8sClient.Update(ctx, cur)).To(Succeed())
			}, "10s", "200ms").Should(Succeed())

			Eventually(func(g Gomega) {
				sts := &appsv1.StatefulSet{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
				g.Expect(sts.Spec.Replicas).To(Equal(ptrTo(int32(1))))
				g.Expect(sts.Spec.Template.Spec.Containers[0].Image).To(Equal(testDevImage))
				// The immutable claim template is preserved as originally created.
				g.Expect(sts.Spec.VolumeClaimTemplates).To(HaveLen(1))
				g.Expect(sts.Spec.VolumeClaimTemplates[0].Spec.AccessModes).To(ContainElement(corev1.ReadWriteOnce))
				g.Expect(sts.Spec.VolumeClaimTemplates[0].Spec.StorageClassName).To(BeNil())
			}, "15s", "200ms").Should(Succeed())

			// The retained workspace claim survives the upgrade untouched.
			pvc := &corev1.PersistentVolumeClaim{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: workspacePVCName(env), Namespace: env.Namespace}, pvc)).To(Succeed())
			Expect(pvc.Status.Phase).To(Equal(corev1.ClaimBound))
		})
	})

	Context("gateway routes", func() {
		It("publishes HTTPRoute and TCPRoutes and builds endpoints", func() {
			createGateway(true)
			defer deleteGateway()

			keys := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "de-routes-keys",
					Namespace: testNamespace,
					Labels:    map[string]string{devEnvSSHKeysDelegatedLabel: devEnvSSHKeysDelegatedValue},
				},
				Data: map[string][]byte{sshUserKeysDefaultKey: []byte(testUserSSHKey)},
			}
			Expect(k8sClient.Create(ctx, keys)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, keys) }()

			env := validDevEnvironment("de-routes")
			env.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				KeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: keys.Name},
					Key:                  sshUserKeysDefaultKey,
				},
			}
			env.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: "metrics", Type: aiv1alpha1.PortTypeHTTP, ContainerPort: 9090},
				{Name: testGRPCPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 50051},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var pSSH, pGRPC int32
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeTrue())
				pSSH = sshEndpointPort(got.Status.Endpoints)
				pGRPC = 0
				for _, ep := range got.Status.Endpoints {
					if ep.Name == testGRPCPortName {
						pGRPC = portFromEndpoint(ep.Address)
					}
				}
				g.Expect(pSSH).To(BeNumerically(">", 0))
				g.Expect(pGRPC).To(BeNumerically(">", 0))
				g.Expect(pSSH).NotTo(Equal(pGRPC))
			}, "15s", "200ms").Should(Succeed())

			route := &gatewayv1.HTTPRoute{}
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: env.Name + "-web", Namespace: env.Namespace}, route)).To(Succeed())
				g.Expect(route.Spec.ParentRefs).To(HaveLen(1))
				g.Expect(string(route.Spec.ParentRefs[0].Name)).To(Equal(testDevEnvGatewayName))
				g.Expect(route.Spec.Rules).To(HaveLen(2))
				g.Expect(route.Spec.Rules[0].Matches).To(HaveLen(1))
				g.Expect(route.Spec.Rules[0].Matches[0].Path.Value).To(Equal(ptrTo(webRootPath + env.Name + "/")))
				g.Expect(route.Spec.Rules[0].BackendRefs).To(HaveLen(1))
				g.Expect(route.Spec.Rules[0].BackendRefs[0].Port).To(Equal(ptrTo(gatewayv1.PortNumber(8888))))
				g.Expect(route.Spec.Rules[1].Matches[0].Path.Value).To(Equal(ptrTo(webRootPath + env.Name + "/port/metrics/")))
				g.Expect(route.Spec.Rules[1].BackendRefs[0].Port).To(Equal(ptrTo(gatewayv1.PortNumber(9090))))
			}, "15s", "200ms").Should(Succeed())

			// One TCPRoute per allocated port: SSH behind tcp-<port> with backend
			// port 22, the grpc extra port with its container port.
			for _, tc := range []struct {
				endpointName string
				port         int32
				backendPort  int32
			}{
				{endpointName: sshPortName, port: pSSH, backendPort: 22},
				{endpointName: testGRPCPortName, port: pGRPC, backendPort: 50051},
			} {
				tr := &gatewayv1.TCPRoute{}
				Expect(k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-tcp-%d", env.Name, tc.port), Namespace: env.Namespace}, tr)).To(Succeed())
				Expect(tr.Spec.ParentRefs).To(HaveLen(1))
				Expect(tr.Spec.ParentRefs[0].SectionName).To(Equal(ptrTo(gatewayv1.SectionName(fmt.Sprintf("tcp-%d", tc.port)))))
				Expect(tr.Spec.Rules[0].BackendRefs).To(HaveLen(1))
				Expect(tr.Spec.Rules[0].BackendRefs[0].Port).To(Equal(ptrTo(tc.backendPort)))
			}

			got := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			Expect(got.Status.Endpoints).To(ContainElements(
				aiv1alpha1.Endpoint{Name: testJupyterName, Address: "http://" + testGatewayIP + ":80" + webRootPath + env.Name + "/"},
				aiv1alpha1.Endpoint{Name: "ssh", Address: fmt.Sprintf("ssh://%s@%s:%d", defaultRuntimeUser, testGatewayIP, pSSH)},
				aiv1alpha1.Endpoint{Name: "metrics", Address: "http://" + testGatewayIP + ":80" + webRootPath + env.Name + "/port/metrics/"},
				aiv1alpha1.Endpoint{Name: testGRPCPortName, Address: fmt.Sprintf("%s:%d", testGatewayIP, pGRPC)},
			))
		})

		It("keeps the SSH port stable and allocates distinct ports", func() {
			createGateway(true)
			defer deleteGateway()

			env1 := validDevEnvironment("de-port-a")
			env1.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			Expect(k8sClient.Create(ctx, env1)).To(Succeed())
			defer deleteEnv(env1.Name)

			var p1 int32
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env1.Name), got)).To(Succeed())
				p1 = sshEndpointPort(got.Status.Endpoints)
				g.Expect(p1).To(BeNumerically(">", 0))
			}, "15s", "200ms").Should(Succeed())

			env2 := validDevEnvironment("de-port-b")
			env2.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env2)).To(Succeed())
			defer deleteEnv(env2.Name)

			Eventually(func(g Gomega) {
				got2 := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env2.Name), got2)).To(Succeed())
				p2 := sshEndpointPort(got2.Status.Endpoints)
				g.Expect(p2).To(BeNumerically(">", 0))
				g.Expect(p2).NotTo(Equal(p1))

				// The enqueue-all watch re-reconciles env1; its recorded port stays
				// stable because it is still free.
				got1 := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env1.Name), got1)).To(Succeed())
				g.Expect(sshEndpointPort(got1.Status.Endpoints)).To(Equal(p1))
			}, "15s", "200ms").Should(Succeed())
		})

		It("prunes TCPRoutes for removed exposures and frees the listener port", func() {
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-prune")
			env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			env.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: testGRPCPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 50051},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			var pSSH, pGRPC int32
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				pSSH = sshEndpointPort(got.Status.Endpoints)
				for _, ep := range got.Status.Endpoints {
					if ep.Name == testGRPCPortName {
						pGRPC = portFromEndpoint(ep.Address)
					}
				}
				g.Expect(pSSH).To(BeNumerically(">", 0))
				g.Expect(pGRPC).To(BeNumerically(">", 0))
			}, "15s", "200ms").Should(Succeed())

			// Drop the extra TCP exposure: the grpc TCPRoute must be deleted
			// while the SSH route and its port stay stable.
			got := &aiv1alpha1.DevEnvironment{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
			got.Spec.Ports = nil
			Expect(k8sClient.Update(ctx, got)).To(Succeed())

			Eventually(func(g Gomega) {
				tr := &gatewayv1.TCPRoute{}
				g.Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-tcp-%d", env.Name, pGRPC), Namespace: env.Namespace}, tr))).To(BeTrue())
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-tcp-%d", env.Name, pSSH), Namespace: env.Namespace}, tr)).To(Succeed())
				got2 := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got2)).To(Succeed())
				g.Expect(sshEndpointPort(got2.Status.Endpoints)).To(Equal(pSSH))
				for _, ep := range got2.Status.Endpoints {
					g.Expect(ep.Name).NotTo(Equal(testGRPCPortName))
				}
			}, "15s", "200ms").Should(Succeed())

			// The freed listener port is reusable: a new environment with the
			// same TCP exposure (and no SSH of its own) takes the released port.
			env2 := validDevEnvironment("de-prune-b")
			env2.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: testGRPCPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 50051},
			}
			Expect(k8sClient.Create(ctx, env2)).To(Succeed())
			defer deleteEnv(env2.Name)

			Eventually(func(g Gomega) {
				got2 := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env2.Name), got2)).To(Succeed())
				p2 := int32(0)
				for _, ep := range got2.Status.Endpoints {
					if ep.Name == testGRPCPortName {
						p2 = portFromEndpoint(ep.Address)
					}
				}
				g.Expect(p2).To(Equal(pGRPC))
			}, "15s", "200ms").Should(Succeed())
		})

		It("frees the listener port and TCPRoute when the environment is deleted", func() {
			createGateway(true)
			defer deleteGateway()

			// Earlier specs release their environments asynchronously (via the
			// finalizer), so drain them first: the port pool below must start
			// empty for the reuse assertion to be deterministic.
			Eventually(func(g Gomega) {
				list := &aiv1alpha1.DevEnvironmentList{}
				g.Expect(k8sClient.List(ctx, list)).To(Succeed())
				g.Expect(list.Items).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())

			env1 := validDevEnvironment("de-free-a")
			env1.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env1)).To(Succeed())

			var p int32
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env1.Name), got)).To(Succeed())
				p = sshEndpointPort(got.Status.Endpoints)
				g.Expect(p).To(BeNumerically(">", 0))
				tr := &gatewayv1.TCPRoute{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-tcp-%d", env1.Name, p), Namespace: env1.Namespace}, tr)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())

			// Deleting the environment must release both the TCPRoute and the
			// listener port. Wait until the object is fully gone: its status
			// endpoints would otherwise still mark the port as in use.
			Expect(k8sClient.Delete(ctx, env1)).To(Succeed())
			Eventually(func(g Gomega) {
				err := k8sClient.Get(ctx, envKey(env1.Name), &aiv1alpha1.DevEnvironment{})
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
				tr := &gatewayv1.TCPRoute{}
				err = k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-tcp-%d", env1.Name, p), Namespace: env1.Namespace}, tr)
				g.Expect(apierrors.IsNotFound(err)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			// With the pool empty again, a new ssh environment reuses the freed
			// port (lowest free) and publishes its own TCPRoute for it.
			env2 := validDevEnvironment("de-free-b")
			env2.Spec.Type = aiv1alpha1.DevEnvironmentTypeSSH
			Expect(k8sClient.Create(ctx, env2)).To(Succeed())
			defer deleteEnv(env2.Name)

			Eventually(func(g Gomega) {
				got2 := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env2.Name), got2)).To(Succeed())
				g.Expect(sshEndpointPort(got2.Status.Endpoints)).To(Equal(p))
				tr := &gatewayv1.TCPRoute{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: fmt.Sprintf("%s-tcp-%d", env2.Name, p), Namespace: env2.Namespace}, tr)).To(Succeed())
			}, "15s", "200ms").Should(Succeed())
		})

		It("degrades RouteReady when the Gateway is missing", func() {
			gw := &gatewayv1.Gateway{ObjectMeta: metav1.ObjectMeta{Name: testDevEnvGatewayName, Namespace: testNamespace}}
			if err := k8sClient.Get(ctx, client.ObjectKeyFromObject(gw), gw); err == nil {
				Expect(k8sClient.Delete(ctx, gw)).To(Succeed())
			}

			env := validDevEnvironment("de-no-gateway")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal(reasonGatewayNotFound))
			}, "15s", "200ms").Should(Succeed())

			// Core provisioning is unaffected by the gateway being missing.
			sts := &appsv1.StatefulSet{}
			Expect(k8sClient.Get(ctx, envKey(env.Name), sts)).To(Succeed())
		})

		It("degrades RouteReady when the Gateway has no address", func() {
			createGateway(false)
			defer deleteGateway()

			env := validDevEnvironment("de-gw-not-ready")
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRouteReady)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal(reasonGatewayNotReady))
				g.Expect(got.Status.Endpoints).To(BeEmpty())
			}, "15s", "200ms").Should(Succeed())
		})

		It("brackets an IPv6 gateway address in published endpoints", func() {
			gw := &gatewayv1.Gateway{
				ObjectMeta: metav1.ObjectMeta{Name: testDevEnvGatewayName, Namespace: testNamespace},
				Spec: gatewayv1.GatewaySpec{
					GatewayClassName: gatewayv1.ObjectName("eg"),
					Listeners: []gatewayv1.Listener{{
						Name:     gatewayv1.SectionName(testPortName),
						Port:     gatewayv1.PortNumber(80),
						Protocol: gatewayv1.HTTPProtocolType,
					}},
				},
			}
			Expect(k8sClient.Create(ctx, gw)).To(Succeed())
			defer deleteGateway()
			gw.Status.Addresses = []gatewayv1.GatewayStatusAddress{{Type: ptrTo(gatewayv1.IPAddressType), Value: "2001:db8::1"}}
			Expect(k8sClient.Status().Update(ctx, gw)).To(Succeed())

			env := validDevEnvironment("de-ipv6")
			env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			env.Spec.Ports = []aiv1alpha1.PortSpec{
				{Name: testGRPCPortName, Type: aiv1alpha1.PortTypeTCP, ContainerPort: 50051},
			}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.DevEnvironment{}
				g.Expect(k8sClient.Get(ctx, envKey(env.Name), got)).To(Succeed())
				var web, ssh, tcp string
				for _, ep := range got.Status.Endpoints {
					switch ep.Name {
					case string(env.Spec.Type):
						web = ep.Address
					case sshPortName:
						ssh = ep.Address
					case testGRPCPortName:
						tcp = ep.Address
					}
				}
				g.Expect(web).To(Equal("http://[2001:db8::1]:80" + webRootPath + env.Name + "/"))
				g.Expect(ssh).To(HavePrefix("ssh://" + defaultRuntimeUser + "@[2001:db8::1]:"))
				g.Expect(tcp).To(HavePrefix("[2001:db8::1]:"))
				g.Expect(portFromEndpoint(tcp)).To(BeNumerically(">", 0))
				g.Expect(portFromEndpoint(ssh)).To(BeNumerically(">", 0))
			}, "15s", "200ms").Should(Succeed())
		})
	})
})
