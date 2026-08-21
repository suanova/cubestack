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

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

var modelVersionGVR = schema.GroupVersionResource{
	Group:    "ai.cubestack.io",
	Version:  "v1alpha1",
	Resource: "modelversions",
}

const (
	testModelName        = "deepseek-v4-flash"
	testStorageClassName = "juicefs-model-cache"
	testModelSubPath     = "models/deepseek-v4-flash/w8a8-v1"
)

func validModelVersion(name string) *ModelVersion {
	return &ModelVersion{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: ModelVersionSpec{
			Model:        testModelName,
			Version:      "w8a8-v1",
			Architecture: "deepseek_v4",
			Quantization: "w8a8",
			Meta:         map[string]string{"launcherSpec": testModelName},
			Storage: ModelStorage{
				Strategy: StorageStrategyHostPath,
				HostPath: &HostPathStorage{Path: "/workspace/models/deepseek-v4-flash"},
			},
		},
	}
}

func validPVCStorage() ModelStorage {
	return ModelStorage{
		Strategy: StorageStrategyPVC,
		PVC: &PVCStorage{
			StorageClassName: testStorageClassName,
			SubPath:          testModelSubPath,
			Capacity:         resource.MustParse("320Gi"),
		},
	}
}

var _ = Describe("ModelVersion", func() {
	Context("valid objects", func() {
		It("accepts a HostPath ModelVersion and round-trips its spec", func() {
			mv := validModelVersion("mv-hostpath")

			Expect(k8sClient.Create(ctx, mv)).To(Succeed())

			got := &ModelVersion{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mv.Name}, got)).To(Succeed())
			Expect(got.Spec).To(Equal(mv.Spec))

			Expect(k8sClient.Delete(ctx, mv)).To(Succeed())
		})

		It("accepts a PVC ModelVersion", func() {
			mv := validModelVersion("mv-pvc")
			mv.Spec.Storage = validPVCStorage()

			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			Expect(k8sClient.Delete(ctx, mv)).To(Succeed())
		})

		It("updates status through the status subresource", func() {
			mv := validModelVersion("mv-status")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())

			mv.Status.UsedBy = []ObjectRef{{Namespace: "project-a", Name: "dsv4-flash-pd"}}
			mv.Status.Conditions = []metav1.Condition{{
				Type:               "StorageResolved",
				Status:             metav1.ConditionTrue,
				Reason:             "StorageClassExists",
				Message:            "storage class found",
				LastTransitionTime: metav1.Now(),
			}}
			Expect(k8sClient.Status().Update(ctx, mv)).To(Succeed())

			got := &ModelVersion{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mv.Name}, got)).To(Succeed())
			Expect(got.Status.UsedBy).To(Equal([]ObjectRef{{Namespace: "project-a", Name: "dsv4-flash-pd"}}))
			Expect(got.Status.Conditions).To(HaveLen(1))
			Expect(got.Status.Conditions[0].Type).To(Equal("StorageResolved"))

			Expect(k8sClient.Delete(ctx, mv)).To(Succeed())
		})
	})

	Context("L0 validation", func() {
		DescribeTable("rejects invalid objects",
			func(name string, mutate func(*ModelVersionSpec), wantMessage string) {
				mv := validModelVersion(name)
				mutate(&mv.Spec)

				err := k8sClient.Create(ctx, mv)
				Expect(err).To(HaveOccurred())
				Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
				if wantMessage != "" {
					Expect(err.Error()).To(ContainSubstring(wantMessage))
				}
			},
			Entry("missing model",
				"mv-invalid-missing-model",
				func(s *ModelVersionSpec) { s.Model = "" },
				"spec.model"),
			Entry("missing version",
				"mv-invalid-missing-version",
				func(s *ModelVersionSpec) { s.Version = "" },
				"spec.version"),
			Entry("missing architecture",
				"mv-invalid-missing-architecture",
				func(s *ModelVersionSpec) { s.Architecture = "" },
				"spec.architecture"),
			Entry("missing quantization",
				"mv-invalid-missing-quantization",
				func(s *ModelVersionSpec) { s.Quantization = "" },
				"spec.quantization"),
			Entry("missing storage",
				"mv-invalid-missing-storage",
				func(s *ModelVersionSpec) { s.Storage = ModelStorage{} },
				"spec.storage.strategy"),
			Entry("unsupported strategy",
				"mv-invalid-strategy",
				func(s *ModelVersionSpec) { s.Storage.Strategy = "NFS" },
				"Unsupported value"),
			Entry("HostPath strategy without hostPath block",
				"mv-invalid-hostpath-missing-block",
				func(s *ModelVersionSpec) { s.Storage.HostPath = nil },
				"requires hostPath and forbids pvc"),
			Entry("HostPath strategy with pvc block",
				"mv-invalid-hostpath-with-pvc",
				func(s *ModelVersionSpec) {
					s.Storage.HostPath = nil
					s.Storage.PVC = &PVCStorage{
						StorageClassName: testStorageClassName,
						SubPath:          testModelSubPath,
						Capacity:         resource.MustParse("320Gi"),
					}
				},
				"requires hostPath and forbids pvc"),
			Entry("PVC strategy without pvc block",
				"mv-invalid-pvc-missing-block",
				func(s *ModelVersionSpec) {
					s.Storage.Strategy = StorageStrategyPVC
					s.Storage.HostPath = nil
				},
				"requires pvc and forbids hostPath"),
			Entry("PVC strategy with hostPath block",
				"mv-invalid-pvc-with-hostpath",
				func(s *ModelVersionSpec) { s.Storage.Strategy = StorageStrategyPVC },
				"requires pvc and forbids hostPath"),
			Entry("pvc block without storageClassName",
				"mv-invalid-pvc-missing-storageclass",
				func(s *ModelVersionSpec) {
					s.Storage = validPVCStorage()
					s.Storage.PVC.StorageClassName = ""
				},
				"spec.storage.pvc.storageClassName"),
			Entry("pvc block without subPath",
				"mv-invalid-pvc-missing-subpath",
				func(s *ModelVersionSpec) {
					s.Storage = validPVCStorage()
					s.Storage.PVC.SubPath = ""
				},
				"spec.storage.pvc.subPath"),
			Entry("relative hostPath",
				"mv-invalid-relative-path",
				func(s *ModelVersionSpec) {
					s.Storage.HostPath.Path = "models/deepseek-v4-flash"
				},
				"spec.storage.hostPath.path"),
		)

		// The pvc fields cannot be omitted with the typed client (a resource.Quantity
		// always serializes), so these cases are created as raw objects.
		DescribeTable("rejects a pvc block with invalid raw values",
			func(name string, pvc map[string]any, wantMessage string) {
				obj := map[string]any{
					"apiVersion": "ai.cubestack.io/v1alpha1",
					"kind":       "ModelVersion",
					"metadata":   map[string]any{"name": name},
					"spec": map[string]any{
						"model":        testModelName,
						"version":      "w8a8-v1",
						"architecture": "deepseek_v4",
						"quantization": "w8a8",
						"storage": map[string]any{
							"strategy": "PVC",
							"pvc":      pvc,
						},
					},
				}

				dynClient := dynamic.NewForConfigOrDie(cfg)
				_, err := dynClient.Resource(modelVersionGVR).Create(
					ctx, &unstructured.Unstructured{Object: obj}, metav1.CreateOptions{})
				Expect(err).To(HaveOccurred())
				Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
				Expect(err.Error()).To(ContainSubstring(wantMessage))
			},
			Entry("missing capacity",
				"mv-invalid-pvc-missing-capacity",
				map[string]any{
					"storageClassName": testStorageClassName,
					"subPath":          testModelSubPath,
				},
				"spec.storage.pvc.capacity"),
			Entry("invalid capacity format",
				"mv-invalid-capacity",
				map[string]any{
					"storageClassName": testStorageClassName,
					"subPath":          testModelSubPath,
					"capacity":         "not-a-quantity",
				},
				"spec.storage.pvc.capacity"),
		)
	})
})
