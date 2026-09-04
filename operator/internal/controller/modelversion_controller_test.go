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
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	storagev1 "k8s.io/api/storage/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

func validModelVersion(name string) *aiv1alpha1.ModelVersion {
	return &aiv1alpha1.ModelVersion{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: aiv1alpha1.ModelVersionSpec{
			Model:        "deepseek-v4-flash",
			Version:      "w8a8-v1",
			Architecture: "deepseek_v4",
			Quantization: "w8a8",
			Storage: aiv1alpha1.ModelStorage{
				Strategy: aiv1alpha1.StorageStrategyHostPath,
				HostPath: &aiv1alpha1.HostPathStorage{Path: "/workspace/models/deepseek-v4-flash"},
			},
		},
	}
}

func validInferenceService(name, modelRef string) *aiv1alpha1.InferenceService {
	return &aiv1alpha1.InferenceService{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		Spec: aiv1alpha1.InferenceServiceSpec{
			ModelRef:   modelRef,
			ProfileRef: "metax-sglang-dsv4-pd",
		},
	}
}

func validDynamicModelVersion(name, storageClassName string) *aiv1alpha1.ModelVersion {
	mv := validModelVersion(name)
	mv.Spec.Storage = aiv1alpha1.ModelStorage{
		Strategy: aiv1alpha1.StorageStrategyDynamic,
		Dynamic: &aiv1alpha1.DynamicStorage{
			StorageClassName: storageClassName,
			SubPath:          "models/deepseek-v4-flash/w8a8-v1",
			Capacity:         resource.MustParse("320Gi"),
		},
	}
	return mv
}

// validStaticModelVersion builds a Static-storage ModelVersion using the
// no-provisioner storage class of the pre-created PVs (design §3.1).
func validStaticModelVersion(name string) *aiv1alpha1.ModelVersion {
	mv := validModelVersion(name)
	mv.Spec.Storage = aiv1alpha1.ModelStorage{
		Strategy: aiv1alpha1.StorageStrategyStatic,
		Static: &aiv1alpha1.StaticStorage{
			StorageClassName: "cephfs-model-static",
			Capacity:         resource.MustParse("320Gi"),
		},
	}
	return mv
}

// validS3ModelVersion builds an S3-storage ModelVersion; credsSecret is the
// source credentials Secret name in cubestack-system, "" means anonymous.
func validS3ModelVersion(name, credsSecret string) *aiv1alpha1.ModelVersion {
	mv := validModelVersion(name)
	storage := aiv1alpha1.ModelStorage{
		Strategy: aiv1alpha1.StorageStrategyS3,
		S3: &aiv1alpha1.S3Storage{
			URI: "s3://model-registry/deepseek-v4-flash/w8a8-v1",
		},
	}
	if credsSecret != "" {
		storage.S3.CredentialsRef = &aiv1alpha1.S3CredentialsRef{Name: credsSecret}
	}
	mv.Spec.Storage = storage
	return mv
}

var _ = Describe("ModelVersion controller", func() {
	Context("usedBy reverse index", func() {
		It("builds usedBy from referencing services and marks InUse", func() {
			mv := validModelVersion("mv-in-use")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			isvc := validInferenceService("isvc-a", mv.Name)
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.ModelVersion{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mv.Name}, got)).To(Succeed())
				g.Expect(got.Status.UsedBy).To(Equal([]aiv1alpha1.ObjectRef{{Namespace: testNamespace, Name: isvc.Name}}))
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionInUse)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("removes a deleted service from usedBy", func() {
			mv := validModelVersion("mv-deleted-ref")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			isvc := validInferenceService("isvc-to-delete", mv.Name)
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.ModelVersion{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mv.Name}, got)).To(Succeed())
				g.Expect(got.Status.UsedBy).To(ContainElement(aiv1alpha1.ObjectRef{Namespace: testNamespace, Name: isvc.Name}))
			}, "15s", "200ms").Should(Succeed())

			Expect(k8sClient.Delete(ctx, isvc)).To(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.ModelVersion{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mv.Name}, got)).To(Succeed())
				g.Expect(got.Status.UsedBy).To(BeEmpty())
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionInUse)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("moves usedBy when modelRef changes", func() {
			mvOld := validModelVersion("mv-old")
			Expect(k8sClient.Create(ctx, mvOld)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mvOld) }()
			mvNew := validModelVersion("mv-new")
			Expect(k8sClient.Create(ctx, mvNew)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mvNew) }()

			isvc := validInferenceService("isvc-migrate", mvOld.Name)
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.ModelVersion{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mvOld.Name}, got)).To(Succeed())
				g.Expect(got.Status.UsedBy).To(ContainElement(aiv1alpha1.ObjectRef{Namespace: testNamespace, Name: isvc.Name}))
			}, "15s", "200ms").Should(Succeed())

			// Re-fetch before mutating: the InferenceService controller writes
			// status, so the object created above may be stale.
			fresh := &aiv1alpha1.InferenceService{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, fresh)).To(Succeed())
			fresh.Spec.ModelRef = mvNew.Name
			Expect(k8sClient.Update(ctx, fresh)).To(Succeed())

			Eventually(func(g Gomega) {
				gotOld := &aiv1alpha1.ModelVersion{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mvOld.Name}, gotOld)).To(Succeed())
				g.Expect(gotOld.Status.UsedBy).To(BeEmpty())

				gotNew := &aiv1alpha1.ModelVersion{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mvNew.Name}, gotNew)).To(Succeed())
				g.Expect(gotNew.Status.UsedBy).To(ContainElement(aiv1alpha1.ObjectRef{Namespace: testNamespace, Name: isvc.Name}))
			}, "15s", "200ms").Should(Succeed())
		})

		It("marks an unreferenced ModelVersion as not in use", func() {
			mv := validModelVersion("mv-unreferenced")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.ModelVersion{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mv.Name}, got)).To(Succeed())
				g.Expect(got.Status.UsedBy).To(BeEmpty())
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionInUse)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("sorts usedBy by namespace and name", func() {
			mv := validModelVersion("mv-sorted")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			for _, name := range []string{"isvc-z", "isvc-a", "isvc-m"} {
				isvc := validInferenceService(name, mv.Name)
				Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
				defer func() { _ = k8sClient.Delete(ctx, isvc) }()
			}

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.ModelVersion{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mv.Name}, got)).To(Succeed())
				g.Expect(got.Status.UsedBy).To(Equal([]aiv1alpha1.ObjectRef{
					{Namespace: testNamespace, Name: "isvc-a"},
					{Namespace: testNamespace, Name: "isvc-m"},
					{Namespace: testNamespace, Name: "isvc-z"},
				}))
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("StorageResolved", func() {
		It("marks StorageResolved false when the Dynamic storage class is missing", func() {
			mv := validDynamicModelVersion("mv-storage-missing", "missing-sc")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.ModelVersion{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mv.Name}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionStorageResolved)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal("StorageClassNotFound"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("marks StorageResolved true when the Dynamic storage class exists", func() {
			sc := &storagev1.StorageClass{
				ObjectMeta:  metav1.ObjectMeta{Name: "exists-sc"},
				Provisioner: "kubernetes.io/no-provisioner",
			}
			Expect(k8sClient.Create(ctx, sc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, sc) }()

			mv := validDynamicModelVersion("mv-storage-exists", sc.Name)
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.ModelVersion{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mv.Name}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionStorageResolved)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionTrue))
			}, "15s", "200ms").Should(Succeed())
		})

		It("marks StorageResolved true for HostPath storage", func() {
			mv := validModelVersion("mv-storage-hostpath")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.ModelVersion{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mv.Name}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionStorageResolved)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionTrue))
			}, "15s", "200ms").Should(Succeed())
		})

		It("does not manage StorageResolved for Static storage", func() {
			mv := validStaticModelVersion("mv-storage-static")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			// Wait until the controller has reconciled (InUse is written on
			// the same reconcile), then confirm StorageResolved is absent:
			// the storage-side integration owns it for Static.
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.ModelVersion{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mv.Name}, got)).To(Succeed())
				g.Expect(meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionInUse)).NotTo(BeNil())
			}, "15s", "200ms").Should(Succeed())

			got := &aiv1alpha1.ModelVersion{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mv.Name}, got)).To(Succeed())
			Expect(meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionStorageResolved)).To(BeNil())
		})

		It("does not manage StorageResolved for S3 storage", func() {
			mv := validS3ModelVersion("mv-storage-s3", "")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			// Wait until the controller has reconciled (InUse is written on
			// the same reconcile), then confirm StorageResolved is absent:
			// the storage-side integration owns it for S3.
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.ModelVersion{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mv.Name}, got)).To(Succeed())
				g.Expect(meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionInUse)).NotTo(BeNil())
			}, "15s", "200ms").Should(Succeed())

			got := &aiv1alpha1.ModelVersion{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: mv.Name}, got)).To(Succeed())
			Expect(meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionStorageResolved)).To(BeNil())
		})
	})
})
