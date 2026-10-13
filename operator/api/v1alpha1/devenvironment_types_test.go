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
	"strings"

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

	// testGPUModelMXC550 is a real model name of a real vendor, so the round-trip
	// test would catch the API rewriting a value in the shape the clusters
	// actually advertise rather than only in a synthetic one.
	testGPUModelMXC550 = "MXC550"
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
				GPU:    &GPUSpec{Vendor: AcceleratorVendorNvidia, Count: ptrTo(int32(1))},
				CPU:    "16",
				Memory: "64Gi",
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
				AuthorizedKeysSecret: &corev1.SecretKeySelector{
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
			// The gpu block is deliberately not defaulted into existence: defaulting
			// it would put an accelerator on every environment and leave "no
			// accelerator" with no way to be expressed. Absent stays absent.
			Expect(got.Spec.Resources.GPU).To(BeNil())
			Expect(got.Spec.Storage.Size).To(Equal("10Gi"))
			// The workspace claim is provisioned and owned by the platform, so
			// omitting the policy reclaims it with the environment; keeping the
			// data is the explicit choice.
			Expect(got.Spec.Storage.PVCRetention).To(Equal(PVCRetentionDelete))
			// No schema default: an unset mountPath stays empty so the controller
			// can derive it from the runtime identity (resolveMountPath).
			Expect(got.Spec.Storage.MountPath).To(BeEmpty())
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
			Entry("unsupported gpu vendor",
				"de-invalid-gpuvendor",
				func(s *DevEnvironmentSpec) { s.Resources.GPU = &GPUSpec{Vendor: AcceleratorVendor("amd")} },
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
			Entry("runtime user with an uppercase letter",
				"de-invalid-runtime-user-case",
				func(s *DevEnvironmentSpec) { s.Runtime.User = "Jovyan" },
				"spec.runtime.user"),
			Entry("runtime user starting with a digit",
				"de-invalid-runtime-user-digit",
				func(s *DevEnvironmentSpec) { s.Runtime.User = "1user" },
				"spec.runtime.user"),
			Entry("runtime user that could split the ssh endpoint",
				"de-invalid-runtime-user-at",
				func(s *DevEnvironmentSpec) { s.Runtime.User = "user@host" },
				"spec.runtime.user"),
			Entry("runtime user longer than the maximum",
				"de-invalid-runtime-user-long",
				func(s *DevEnvironmentSpec) { s.Runtime.User = strings.Repeat("a", 33) },
				"spec.runtime.user"),
			Entry("empty authorizedKeysSecret data key",
				"de-invalid-ssh-key-empty",
				func(s *DevEnvironmentSpec) {
					s.SSH = &SSHSpec{Enabled: true, AuthorizedKeysSecret: &corev1.SecretKeySelector{
						LocalObjectReference: corev1.LocalObjectReference{Name: "dev-alice-ssh-keys"},
					}}
				},
				"spec.ssh.authorizedKeysSecret"),
		)

		// Required fields are enforced as "the key must be present", so an empty
		// string is still accepted by the schema — except where a field carries its
		// own non-empty rule, as spec.ssh.authorizedKeysSecret.key does above. These cases are
		// created as raw objects to omit the keys entirely.
		DescribeTable("rejects objects with missing required fields",
			func(name string, mutate func(map[string]any), wantMessage string) {
				spec := map[string]any{
					"image":     testDevImage,
					"resources": map[string]any{},
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

		// These cases are created as raw objects so they can send values the typed
		// client would not produce.
		DescribeTable("rejects objects with invalid raw values",
			func(name string, mutate func(map[string]any), wantMessage string) {
				spec := map[string]any{
					"image": testDevImage,
					"resources": map[string]any{
						"gpu": map[string]any{
							"vendor": "nvidia",
							"count":  1,
						},
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
			Entry("gpu count below minimum",
				"de-invalid-gpucount-raw",
				func(s map[string]any) { s["resources"].(map[string]any)["gpu"].(map[string]any)["count"] = -1 },
				"spec.resources.gpu.count"),
			// There is no count of zero: the block's absence is how an environment
			// asks for no accelerator, so a zero inside the block describes nothing
			// and is refused rather than quietly reinterpreted.
			Entry("gpu count of zero",
				"de-invalid-gpucount-zero-raw",
				func(s map[string]any) { s["resources"].(map[string]any)["gpu"].(map[string]any)["count"] = 0 },
				"spec.resources.gpu.count"),
			// The model carries its own non-empty rule: an empty string would be
			// a legal-looking pin that names no model and so matches no node,
			// which is the failure this field exists to express rather than hide.
			// Omitting the key is how an environment leaves the model open.
			Entry("empty gpu model",
				"de-invalid-gpumodel-empty-raw",
				func(s map[string]any) { s["resources"].(map[string]any)["gpu"].(map[string]any)["model"] = "" },
				"spec.resources.gpu.model"),
			// The model becomes a node selector's value, so it is held to that
			// shape and a value outside it is refused here rather than accepted
			// and left to select nothing — no node can advertise it, since the
			// label itself could not be written. A space is the mistake to write
			// down: a product name copied out of a datasheet is the input most
			// likely to carry one.
			Entry("gpu model that is not a label value",
				"de-invalid-gpumodel-space-raw",
				func(s map[string]any) { s["resources"].(map[string]any)["gpu"].(map[string]any)["model"] = "MXC 550" },
				"spec.resources.gpu.model"),
			Entry("gpu model longer than a label value",
				"de-invalid-gpumodel-long-raw",
				func(s map[string]any) {
					s["resources"].(map[string]any)["gpu"].(map[string]any)["model"] = strings.Repeat("A", 64)
				},
				"spec.resources.gpu.model"),
		)

		// Within the block, an omitted vendor and an omitted count are defaulted —
		// the block's presence is the request, and there is nothing sensible for
		// the halves to be missing.
		It("defaults the halves of a gpu block that is present", func() {
			de := validDevEnvironment("de-gpu-block-defaults")
			de.Spec.Resources.GPU = &GPUSpec{Count: ptrTo(int32(2))}

			Expect(k8sClient.Create(ctx, de)).To(Succeed())

			got := &DevEnvironment{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: de.Name, Namespace: de.Namespace}, got)).To(Succeed())
			Expect(got.Spec.Resources.GPU).NotTo(BeNil())
			Expect(got.Spec.Resources.GPU.Vendor).To(Equal(AcceleratorVendorNvidia))
			Expect(got.Spec.Resources.GPU.Count).To(Equal(ptrTo(int32(2))))
			// The model is the exception, and deliberately so: there is no
			// default to give it. A defaulted model would pin every environment
			// that names none to one card the platform picked, which is exactly
			// the choice the field exists to leave to the user.
			Expect(got.Spec.Resources.GPU.Model).To(BeEmpty())

			Expect(k8sClient.Delete(ctx, de)).To(Succeed())
		})

		// The model is free-form — the cluster's own device plugin decides which
		// names exist, and a new SKU must not need an operator release — so the
		// API's whole job is to carry it through unaltered. Anything that
		// normalised the value would stop a model the cluster advertises from
		// ever matching.
		It("round-trips a declared gpu model verbatim", func() {
			de := validDevEnvironment("de-gpu-model-roundtrip")
			de.Spec.Resources.GPU = &GPUSpec{
				Vendor: AcceleratorVendorMetax, Model: testGPUModelMXC550, Count: ptrTo(int32(2)),
			}

			Expect(k8sClient.Create(ctx, de)).To(Succeed())

			got := &DevEnvironment{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: de.Name, Namespace: de.Namespace}, got)).To(Succeed())
			Expect(got.Spec.Resources.GPU).NotTo(BeNil())
			Expect(got.Spec.Resources.GPU.Vendor).To(Equal(AcceleratorVendorMetax))
			Expect(got.Spec.Resources.GPU.Model).To(Equal(testGPUModelMXC550))

			Expect(k8sClient.Delete(ctx, de)).To(Succeed())
		})

		// An environment that asks for no accelerator must stay that way across a
		// write. If the CRD ever grew a default on the block itself, the block would
		// be materialised on the way in and the environment would silently become a
		// GPU one on the controller's first Update.
		It("keeps an absent gpu block absent across a write", func() {
			de := validDevEnvironment("de-cpu-only")
			de.Spec.Resources.GPU = nil

			Expect(k8sClient.Create(ctx, de)).To(Succeed())
			Expect(de.Spec.Resources.GPU).To(BeNil())

			// A write that does not touch resources — the shape the controller's
			// finalizer Update takes.
			de.Labels = map[string]string{"probe": "true"}
			Expect(k8sClient.Update(ctx, de)).To(Succeed())

			got := &DevEnvironment{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: de.Name, Namespace: de.Namespace}, got)).To(Succeed())
			Expect(got.Spec.Resources.GPU).To(BeNil())

			Expect(k8sClient.Delete(ctx, de)).To(Succeed())
		})
	})
})
