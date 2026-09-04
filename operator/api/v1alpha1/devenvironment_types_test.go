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

package v1alpha1

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const (
	testPortName = "app"
	testDevImage = "harbor.local/ai-images/base-cuda:11.8-pytorch2.2"
)

// testAPIVersion derives from SchemeGroupVersion to avoid repeating the group
// and version literals (goconst).
var testAPIVersion = SchemeGroupVersion.Group + "/" + SchemeGroupVersion.Version

var devEnvironmentGVR = schema.GroupVersionResource{
	Group:    SchemeGroupVersion.Group,
	Version:  SchemeGroupVersion.Version,
	Resource: "devenvironments",
}

// rawDevEnvironment builds a DevEnvironment object map with a single copy of the
// apiVersion/kind/metadata/spec keys shared by the raw-object rejection tables.
func rawDevEnvironment(name string, spec map[string]any) map[string]any {
	return map[string]any{
		"apiVersion": testAPIVersion,
		"kind":       "DevEnvironment",
		"metadata":   map[string]any{"name": name, "namespace": testNamespace},
		"spec":       spec,
	}
}

func validDevEnvironment(name string) *DevEnvironment {
	return &DevEnvironment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		Spec: DevEnvironmentSpec{
			Type:    DevEnvironmentTypeJupyter,
			Image:   testDevImage,
			Running: true,
			Resources: ResourcesSpec{
				GPUType:  GPUTypeNVIDIA,
				GPUCount: 1,
				CPU:      "16",
				Memory:   "64Gi",
			},
			Storage: &StorageSpec{
				Size:         "200Gi",
				PVCRetention: PVCRetentionRetain,
				MountPath:    "/home",
			},
			Volumes: []VolumeMount{
				{Name: "shared-dataset", PVCName: "dataset-llm-shared", MountPath: "/data", ReadOnly: true},
			},
			SSH: &SSHSpec{
				Enabled: true,
				KeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: "dev-alice-ssh-keys"},
					Key:                  "keys",
				},
			},
			Network:   &NetworkSpec{RDMAEnabled: false, RDMAType: RDMATypeRoCE},
			Runtime:   &RuntimeSpec{Env: []corev1.EnvVar{{Name: "MODEL_REPO", Value: "/models/llama3-8b"}}},
			Lifecycle: &LifecycleSpec{IdleTimeout: 3600},
		},
	}
}

var _ = Describe("DevEnvironment", func() {
	Context("valid objects", func() {
		It("accepts a valid DevEnvironment and round-trips its spec", func() {
			de := validDevEnvironment("de-valid")

			Expect(k8sClient.Create(ctx, de)).To(Succeed())

			got := &DevEnvironment{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: de.Name, Namespace: de.Namespace}, got)).To(Succeed())
			Expect(got.Spec).To(Equal(de.Spec))

			Expect(k8sClient.Delete(ctx, de)).To(Succeed())
		})

		It("applies the documented defaults for omitted optional fields", func() {
			de := &DevEnvironment{
				ObjectMeta: metav1.ObjectMeta{Name: "de-defaults", Namespace: testNamespace},
				Spec: DevEnvironmentSpec{
					Image:     testDevImage,
					Resources: ResourcesSpec{},
					Storage:   &StorageSpec{},
					Network:   &NetworkSpec{},
					Lifecycle: &LifecycleSpec{},
				},
			}

			Expect(k8sClient.Create(ctx, de)).To(Succeed())

			got := &DevEnvironment{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: de.Name, Namespace: de.Namespace}, got)).To(Succeed())
			Expect(got.Spec.Type).To(Equal(DevEnvironmentTypeSSH))
			Expect(got.Spec.Running).To(BeFalse())
			Expect(got.Spec.Resources.GPUType).To(Equal(GPUTypeNVIDIA))
			Expect(got.Spec.Resources.GPUCount).To(Equal(int32(1)))
			Expect(got.Spec.Storage.Size).To(Equal("10Gi"))
			Expect(got.Spec.Storage.PVCRetention).To(Equal(PVCRetentionRetain))
			Expect(got.Spec.Storage.MountPath).To(Equal("/workspace"))
			Expect(got.Spec.Network.RDMAType).To(Equal(RDMATypeRoCE))
			Expect(got.Spec.Lifecycle.IdleTimeout).To(Equal(int32(0)))

			Expect(k8sClient.Delete(ctx, got)).To(Succeed())
		})

		It("applies the http default to a PortSpec with an omitted type", func() {
			de := &DevEnvironment{
				ObjectMeta: metav1.ObjectMeta{Name: "de-port-default", Namespace: testNamespace},
				Spec: DevEnvironmentSpec{
					Image:     testDevImage,
					Resources: ResourcesSpec{},
					Ports:     []PortSpec{{Name: testPortName, ContainerPort: 8080}},
				},
			}

			Expect(k8sClient.Create(ctx, de)).To(Succeed())

			got := &DevEnvironment{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: de.Name, Namespace: de.Namespace}, got)).To(Succeed())
			Expect(got.Spec.Ports).To(HaveLen(1))
			Expect(got.Spec.Ports[0].Type).To(Equal(PortTypeHTTP))

			Expect(k8sClient.Delete(ctx, got)).To(Succeed())
		})

		It("updates status through the status subresource", func() {
			de := validDevEnvironment("de-status")
			Expect(k8sClient.Create(ctx, de)).To(Succeed())

			now := metav1.Now()
			de.Status.Phase = &Phase{Name: PhaseRunning, LastTransitionTime: &now, Reason: "pod running"}
			de.Status.Conditions = []metav1.Condition{{
				Type:               ConditionReady,
				Status:             metav1.ConditionTrue,
				Reason:             "PodReady",
				Message:            "pod ready",
				LastTransitionTime: now,
			}}
			Expect(k8sClient.Status().Update(ctx, de)).To(Succeed())

			got := &DevEnvironment{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: de.Name, Namespace: de.Namespace}, got)).To(Succeed())
			Expect(got.Status.Phase.Name).To(Equal(PhaseRunning))
			Expect(got.Status.Phase.Reason).To(Equal("pod running"))
			Expect(got.Status.Phase.LastTransitionTime).NotTo(BeNil())
			Expect(got.Status.Conditions).To(HaveLen(1))
			Expect(got.Status.Conditions[0].Type).To(Equal(ConditionReady))

			Expect(k8sClient.Delete(ctx, de)).To(Succeed())
		})
	})

	Context("L0 validation", func() {
		DescribeTable("rejects invalid objects",
			func(name string, mutate func(*DevEnvironmentSpec), wantMessage string) {
				de := validDevEnvironment(name)
				mutate(&de.Spec)

				err := k8sClient.Create(ctx, de)
				Expect(err).To(HaveOccurred())
				Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
				if wantMessage != "" {
					Expect(err.Error()).To(ContainSubstring(wantMessage))
				}
			},
			Entry("empty image",
				"de-invalid-empty-image",
				func(s *DevEnvironmentSpec) { s.Image = "" },
				"spec.image"),
			Entry("unsupported type",
				"de-invalid-type",
				func(s *DevEnvironmentSpec) { s.Type = DevEnvironmentType("docker") },
				"Unsupported value"),
			Entry("unsupported gpuType",
				"de-invalid-gputype",
				func(s *DevEnvironmentSpec) { s.Resources.GPUType = GPUType("amd") },
				"Unsupported value"),
			Entry("unsupported pvcRetention",
				"de-invalid-retention",
				func(s *DevEnvironmentSpec) { s.Storage.PVCRetention = "keep" },
				"Unsupported value"),
			Entry("unsupported rdmaType",
				"de-invalid-rdmatype",
				func(s *DevEnvironmentSpec) { s.Network.RDMAType = "infinibandx" },
				"Unsupported value"),
			Entry("negative idleTimeout",
				"de-invalid-idletimeout",
				func(s *DevEnvironmentSpec) { s.Lifecycle.IdleTimeout = -1 },
				"spec.lifecycle.idleTimeout"),
			Entry("unsupported ports type",
				"de-invalid-porttype",
				func(s *DevEnvironmentSpec) {
					s.Ports = []PortSpec{{Name: testPortName, Type: "ftp", ContainerPort: 8080}}
				},
				"Unsupported value"),
			Entry("containerPort below minimum",
				"de-invalid-port-min",
				func(s *DevEnvironmentSpec) {
					s.Ports = []PortSpec{{Name: testPortName, ContainerPort: 0}}
				},
				"spec.ports"),
			Entry("containerPort above maximum",
				"de-invalid-port-max",
				func(s *DevEnvironmentSpec) {
					s.Ports = []PortSpec{{Name: testPortName, ContainerPort: 65536}}
				},
				"spec.ports"),
		)

		// Required fields are enforced as "the key must be present", so an empty
		// string is still accepted by the schema. These cases are created as raw
		// objects to omit the keys entirely.
		DescribeTable("rejects objects with missing required fields",
			func(name string, mutate func(map[string]any), wantMessage string) {
				spec := map[string]any{
					"image": testDevImage,
					"resources": map[string]any{
						"gpuType": GPUTypeNVIDIA,
					},
				}
				mutate(spec)

				dynClient := dynamic.NewForConfigOrDie(cfg)
				_, err := dynClient.Resource(devEnvironmentGVR).Namespace(testNamespace).Create(
					ctx, &unstructured.Unstructured{Object: rawDevEnvironment(name, spec)}, metav1.CreateOptions{})
				Expect(err).To(HaveOccurred())
				Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
				Expect(err.Error()).To(ContainSubstring(wantMessage))
			},
			Entry("missing image",
				"de-invalid-missing-image",
				func(s map[string]any) { delete(s, "image") },
				"spec.image"),
			Entry("missing resources",
				"de-invalid-missing-resources",
				func(s map[string]any) { delete(s, "resources") },
				"spec.resources"),
		)

		// gpuCount is an omitempty int32, so a zero value is dropped by the typed
		// client and the schema default 1 applies instead. These cases are created
		// as raw objects to send an explicit out-of-range value.
		DescribeTable("rejects objects with invalid raw values",
			func(name string, mutate func(map[string]any), wantMessage string) {
				spec := map[string]any{
					"image": testDevImage,
					"resources": map[string]any{
						"gpuType":  GPUTypeNVIDIA,
						"gpuCount": 1,
					},
				}
				mutate(spec)

				dynClient := dynamic.NewForConfigOrDie(cfg)
				_, err := dynClient.Resource(devEnvironmentGVR).Namespace(testNamespace).Create(
					ctx, &unstructured.Unstructured{Object: rawDevEnvironment(name, spec)}, metav1.CreateOptions{})
				Expect(err).To(HaveOccurred())
				Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
				Expect(err.Error()).To(ContainSubstring(wantMessage))
			},
			Entry("gpuCount below minimum",
				"de-invalid-gpucount-raw",
				func(s map[string]any) { s["resources"].(map[string]any)["gpuCount"] = 0 },
				"spec.resources.gpuCount"),
		)
	})
})
