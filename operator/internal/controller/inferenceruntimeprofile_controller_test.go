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

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

func ptrTo[T any](v T) *T { return &v }

const (
	testAssetName          = "bootstrap"
	testConfigMapDataKey   = "key"
	testConfigMapDataValue = "value"
)

func validInferenceRuntimeProfile(name string) *aiv1alpha1.InferenceRuntimeProfile {
	return &aiv1alpha1.InferenceRuntimeProfile{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: aiv1alpha1.InferenceRuntimeProfileSpec{
			Accelerator: aiv1alpha1.Accelerator{
				Vendor: aiv1alpha1.AcceleratorVendorMetax,
				Models: []string{"MXC500"},
			},
			Engine: aiv1alpha1.Engine{
				Name:    "sglang",
				Version: "vendor-0.5.12-rc1",
			},
			ModelRequirements: aiv1alpha1.ModelRequirements{
				Architectures: []string{"deepseek_v4"},
				Quantization:  []string{"w8a8"},
			},
			Assets: []aiv1alpha1.Asset{
				{
					Name:         testAssetName,
					ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: "metax-c500-bootstrap-v0.5.12-rc1"},
					Mount:        &aiv1alpha1.AssetMount{Path: "/opt/cubestack-bootstrap", Mode: 0755},
				},
				{
					Name:         "runtime-config",
					ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: "metax-dsv4-runtime-v0.5.12-rc1"},
					EnvFrom:      ptrTo(true),
				},
			},
			Roles: []aiv1alpha1.Role{
				{
					Name: "router",
					Workload: aiv1alpha1.Workload{
						Kind:     aiv1alpha1.WorkloadKindDeployment,
						Replicas: ptrTo(intstr.FromInt(1)),
					},
					PodTemplate: aiv1alpha1.PodTemplate{Image: "registry.local/router:v1"},
				},
			},
			Endpoint: aiv1alpha1.EndpointSpec{Role: "router"},
		},
	}
}

// validProfileRefService returns an InferenceService referencing the given
// InferenceRuntimeProfile; the modelRef is fixed to a plain valid name since
// the profile index only cares about profileRef.
func validProfileRefService(name, profileRef string) *aiv1alpha1.InferenceService {
	isvc := validInferenceService(name, "model-ref")
	isvc.Spec.ProfileRef = profileRef
	return isvc
}

var _ = Describe("InferenceRuntimeProfile controller", func() {
	Context("usedBy reverse index", func() {
		It("builds usedBy from referencing services and marks InUse", func() {
			irp := validInferenceRuntimeProfile("irp-in-use")
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			isvc := validProfileRefService("irp-isvc-a", irp.Name)
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, got)).To(Succeed())
				g.Expect(got.Status.UsedBy).To(Equal([]aiv1alpha1.ObjectRef{{Namespace: testNamespace, Name: isvc.Name}}))
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionInUse)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("removes a deleted service from usedBy", func() {
			irp := validInferenceRuntimeProfile("irp-deleted-ref")
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			isvc := validProfileRefService("irp-isvc-to-delete", irp.Name)
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, got)).To(Succeed())
				g.Expect(got.Status.UsedBy).To(ContainElement(aiv1alpha1.ObjectRef{Namespace: testNamespace, Name: isvc.Name}))
			}, "15s", "200ms").Should(Succeed())

			Expect(k8sClient.Delete(ctx, isvc)).To(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, got)).To(Succeed())
				g.Expect(got.Status.UsedBy).To(BeEmpty())
				g.Expect(meta.IsStatusConditionFalse(got.Status.Conditions, aiv1alpha1.ConditionInUse)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("moves usedBy when profileRef changes", func() {
			irpOld := validInferenceRuntimeProfile("irp-old")
			Expect(k8sClient.Create(ctx, irpOld)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irpOld) }()
			irpNew := validInferenceRuntimeProfile("irp-new")
			Expect(k8sClient.Create(ctx, irpNew)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irpNew) }()

			isvc := validProfileRefService("irp-isvc-migrate", irpOld.Name)
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irpOld.Name}, got)).To(Succeed())
				g.Expect(got.Status.UsedBy).To(ContainElement(aiv1alpha1.ObjectRef{Namespace: testNamespace, Name: isvc.Name}))
			}, "15s", "200ms").Should(Succeed())

			isvc.Spec.ProfileRef = irpNew.Name
			Expect(k8sClient.Update(ctx, isvc)).To(Succeed())

			Eventually(func(g Gomega) {
				gotOld := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irpOld.Name}, gotOld)).To(Succeed())
				g.Expect(gotOld.Status.UsedBy).To(BeEmpty())

				gotNew := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irpNew.Name}, gotNew)).To(Succeed())
				g.Expect(gotNew.Status.UsedBy).To(ContainElement(aiv1alpha1.ObjectRef{Namespace: testNamespace, Name: isvc.Name}))
			}, "15s", "200ms").Should(Succeed())
		})

		It("sorts usedBy by namespace and name", func() {
			irp := validInferenceRuntimeProfile("irp-sorted")
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			for _, name := range []string{"irp-isvc-z", "irp-isvc-a", "irp-isvc-m"} {
				isvc := validProfileRefService(name, irp.Name)
				Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
				defer func() { _ = k8sClient.Delete(ctx, isvc) }()
			}

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, got)).To(Succeed())
				g.Expect(got.Status.UsedBy).To(Equal([]aiv1alpha1.ObjectRef{
					{Namespace: testNamespace, Name: "irp-isvc-a"},
					{Namespace: testNamespace, Name: "irp-isvc-m"},
					{Namespace: testNamespace, Name: "irp-isvc-z"},
				}))
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("AssetsResolved", func() {
		BeforeEach(func() {
			ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: systemNamespace}}
			err := k8sClient.Create(ctx, ns)
			if !apierrors.IsAlreadyExists(err) {
				Expect(err).NotTo(HaveOccurred())
			}
		})

		It("marks AssetsResolved false when a source ConfigMap is missing", func() {
			irp := validInferenceRuntimeProfile("irp-assets-missing")
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAssetsResolved)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal("AssetNotFound"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("marks AssetsResolved true when all source ConfigMaps exist and are immutable", func() {
			for _, cmName := range []string{"metax-c500-bootstrap-v0.5.12-rc1", "metax-dsv4-runtime-v0.5.12-rc1"} {
				cm := &corev1.ConfigMap{
					ObjectMeta: metav1.ObjectMeta{Name: cmName, Namespace: systemNamespace},
					Immutable:  ptrTo(true),
					Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
				}
				Expect(k8sClient.Create(ctx, cm)).To(Succeed())
			}

			irp := validInferenceRuntimeProfile("irp-assets-ok")
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAssetsResolved)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionTrue))
			}, "15s", "200ms").Should(Succeed())
		})

		It("marks AssetsResolved false when a source ConfigMap is not immutable", func() {
			cm := &corev1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{Name: "mutable-cm", Namespace: systemNamespace},
				Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
			}
			Expect(k8sClient.Create(ctx, cm)).To(Succeed())

			irp := validInferenceRuntimeProfile("irp-assets-mutable")
			irp.Spec.Assets = []aiv1alpha1.Asset{
				{Name: testAssetName, ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: cm.Name}, EnvFrom: ptrTo(true)},
			}
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAssetsResolved)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal("ConfigMapNotImmutable"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("marks AssetsResolved true when the profile declares no assets", func() {
			irp := validInferenceRuntimeProfile("irp-assets-none")
			irp.Spec.Assets = nil
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAssetsResolved)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionTrue))
				g.Expect(cond.Reason).To(Equal("NotApplicable"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("refreshes AssetsResolved when a source ConfigMap is created", func() {
			irp := validInferenceRuntimeProfile("irp-assets-late-create")
			irp.Spec.Assets = []aiv1alpha1.Asset{
				{Name: testAssetName, ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: "late-create-cm"}, EnvFrom: ptrTo(true)},
			}
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAssetsResolved)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			}, "15s", "200ms").Should(Succeed())

			cm := &corev1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{Name: "late-create-cm", Namespace: systemNamespace},
				Immutable:  ptrTo(true),
				Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
			}
			Expect(k8sClient.Create(ctx, cm)).To(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAssetsResolved)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionTrue))
			}, "15s", "200ms").Should(Succeed())
		})

		It("refreshes AssetsResolved when a source ConfigMap is deleted", func() {
			cm := &corev1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{Name: "to-delete-cm", Namespace: systemNamespace},
				Immutable:  ptrTo(true),
				Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
			}
			Expect(k8sClient.Create(ctx, cm)).To(Succeed())

			irp := validInferenceRuntimeProfile("irp-assets-late-delete")
			irp.Spec.Assets = []aiv1alpha1.Asset{
				{Name: testAssetName, ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: cm.Name}, EnvFrom: ptrTo(true)},
			}
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAssetsResolved)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionTrue))
			}, "15s", "200ms").Should(Succeed())

			Expect(k8sClient.Delete(ctx, cm)).To(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceRuntimeProfile{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionAssetsResolved)
				g.Expect(cond).NotTo(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			}, "15s", "200ms").Should(Succeed())
		})
	})
})
