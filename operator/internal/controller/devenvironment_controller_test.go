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

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

const (
	testDevImage          = "harbor.local/ai-images/base-cuda:11.8-pytorch2.2"
	testDevStorageClass   = "ceph-rbd"
	testGPUResource       = "nvidia.com/gpu"
	testDevEnvGatewayName = "test-gw"
	testGatewayIP         = "1.2.3.4"
	testGRPCPortName      = "grpc"
	testJupyterName       = "jupyter"
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
				GPUCount: 1,
				CPU:      "16",
				Memory:   "64Gi",
			},
			Storage: &aiv1alpha1.StorageSpec{
				Size:             "200Gi",
				StorageClassName: testDevStorageClass,
				PVCRetention:     aiv1alpha1.PVCRetentionRetain,
				MountPath:        "/workspace",
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
func createStatefulPod(env *aiv1alpha1.DevEnvironment, nodeName string, phase corev1.PodPhase, ready bool, waiting *corev1.ContainerStateWaiting) {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      podName(env),
			Namespace: env.Namespace,
			Labels:    map[string]string{devEnvironmentLabelKey: env.Name},
		},
		Spec: corev1.PodSpec{
			NodeName:   nodeName,
			Containers: []corev1.Container{{Name: testJupyterName, Image: testDevImage}},
		},
	}
	Expect(k8sClient.Create(ctx, pod)).To(Succeed())
	pod.Status.Phase = phase
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
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
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
				g.Expect(sts.Spec.VolumeClaimTemplates[0].Spec.AccessModes).To(ContainElement(corev1.ReadWriteOnce))
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

		It("withdraws compute and routes when a running environment becomes mismatched", func() {
			createGateway(true)
			defer deleteGateway()

			env := validDevEnvironment("de-brand-transition")
			env.Spec.SSH = &aiv1alpha1.SSHSpec{Enabled: true}
			Expect(k8sClient.Create(ctx, env)).To(Succeed())
			defer deleteEnv(env.Name)
			createStatefulPod(env, "node-a", corev1.PodRunning, true, nil)
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
			createStatefulPod(env, "node-a", corev1.PodRunning, true, nil)
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
			createStatefulPod(env, "node-a", corev1.PodRunning, false,
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
				aiv1alpha1.Endpoint{Name: "ssh", Address: fmt.Sprintf("ssh://%s@%s:%d", sshEndpointUser, testGatewayIP, pSSH)},
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
				g.Expect(ssh).To(HavePrefix("ssh://" + sshEndpointUser + "@[2001:db8::1]:"))
				g.Expect(tcp).To(HavePrefix("[2001:db8::1]:"))
				g.Expect(portFromEndpoint(tcp)).To(BeNumerically(">", 0))
				g.Expect(portFromEndpoint(ssh)).To(BeNumerically(">", 0))
			}, "15s", "200ms").Should(Succeed())
		})
	})
})
