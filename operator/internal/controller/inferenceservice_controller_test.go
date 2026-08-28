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
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// testLauncher is the profile.vars.launcher value used by the render specs.
const testLauncher = "sglang"

// testOverridePrefillReplicas is the override name declared by validRenderProfile.
const testOverridePrefillReplicas = "prefillReplicas"

// validResolveProfile returns a profile whose assets reference unique source
// ConfigMaps in cubestack-system, plus the matching immutable ConfigMaps.
func validResolveProfile(name string) *aiv1alpha1.InferenceRuntimeProfile {
	irp := validInferenceRuntimeProfile(name)
	irp.Spec.Assets = []aiv1alpha1.Asset{
		{Name: testAssetName, ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: name + "-cm-a"}, Mount: &aiv1alpha1.AssetMount{Path: "/opt/bootstrap", Mode: 0755}},
		{Name: "runtime-config", ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: name + "-cm-b"}, EnvFrom: ptrTo(true)},
	}
	for _, cmName := range []string{name + "-cm-a", name + "-cm-b"} {
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: cmName, Namespace: systemNamespace},
			Immutable:  ptrTo(true),
			Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
		}
		Expect(k8sClient.Create(ctx, cm)).To(Succeed())
	}
	return irp
}

func ensureSystemNamespace() {
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: systemNamespace}}
	if err := k8sClient.Create(ctx, ns); err != nil && !apierrors.IsAlreadyExists(err) {
		Expect(err).NotTo(HaveOccurred())
	}
}

var _ = Describe("InferenceService controller", func() {
	BeforeEach(func() { ensureSystemNamespace() })

	Context("Resolved", func() {
		It("marks Resolved true and echoes profile and model", func() {
			irp := validResolveProfile("isvc-resolve-ok")
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			mv := validModelVersion("isvc-resolve-mv")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			isvc := validInferenceService("isvc-resolve-ok", mv.Name)
			isvc.Spec.ProfileRef = irp.Name
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionResolved)).To(BeTrue())
				g.Expect(got.Status.Profile).ToNot(BeNil())
				g.Expect(got.Status.Profile.Name).To(Equal(irp.Name))
				g.Expect(got.Status.Model).To(Equal(&aiv1alpha1.ModelStatus{Name: "deepseek-v4-flash", Version: "w8a8-v1"}))
				g.Expect(got.Status.ObservedGeneration).To(Equal(got.Generation))
			}, "15s", "200ms").Should(Succeed())
		})

		It("marks Resolved false with ProfileNotFound when the profile is missing", func() {
			mv := validModelVersion("isvc-resolve-nomv-profile")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			isvc := validInferenceService("isvc-resolve-noprofile", mv.Name)
			isvc.Spec.ProfileRef = "missing-profile"
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionResolved)
				g.Expect(cond).ToNot(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal("ProfileNotFound"))
				g.Expect(cond.Message).To(ContainSubstring("missing-profile"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("marks Resolved false with ModelNotFound when the model is missing", func() {
			irp := validResolveProfile("isvc-resolve-nomodel")
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			isvc := validInferenceService("isvc-resolve-nomodel", "missing-model")
			isvc.Spec.ProfileRef = irp.Name
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionResolved)
				g.Expect(cond).ToNot(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal("ModelNotFound"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("marks Resolved false with ModelIncompatible on architecture or quantization mismatch", func() {
			irp := validResolveProfile("isvc-resolve-incompat")
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			mv := validModelVersion("isvc-resolve-incompat-mv")
			mv.Spec.Architecture = "llama3"
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			isvc := validInferenceService("isvc-resolve-incompat", mv.Name)
			isvc.Spec.ProfileRef = irp.Name
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionResolved)
				g.Expect(cond).ToNot(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal("ModelIncompatible"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("marks Resolved false with AssetNotFound when a source ConfigMap is missing", func() {
			irp := validResolveProfile("isvc-resolve-noasset")
			irp.Spec.Assets = []aiv1alpha1.Asset{
				{Name: testAssetName, ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: "isvc-resolve-noasset-cm"}, EnvFrom: ptrTo(true)},
			}
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			mv := validModelVersion("isvc-resolve-noasset-mv")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			isvc := validInferenceService("isvc-resolve-noasset", mv.Name)
			isvc.Spec.ProfileRef = irp.Name
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionResolved)
				g.Expect(cond).ToNot(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal("AssetNotFound"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("aggregates all failures in the message", func() {
			isvc := validInferenceService("isvc-resolve-aggregate", "missing-model")
			isvc.Spec.ProfileRef = "missing-profile"
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionResolved)
				g.Expect(cond).ToNot(BeNil())
				g.Expect(cond.Reason).To(Equal("ProfileNotFound"))
				g.Expect(cond.Message).To(ContainSubstring("missing-profile"))
				g.Expect(cond.Message).To(ContainSubstring("missing-model"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("flips to false when the model version is deleted", func() {
			irp := validResolveProfile("isvc-resolve-del-mv")
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			mv := validModelVersion("isvc-resolve-del-mv")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())

			isvc := validInferenceService("isvc-resolve-del-mv", mv.Name)
			isvc.Spec.ProfileRef = irp.Name
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionResolved)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			Expect(k8sClient.Delete(ctx, mv)).To(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionResolved)
				g.Expect(cond).ToNot(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal("ModelNotFound"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("flips to true when a source ConfigMap is created", func() {
			irp := validResolveProfile("isvc-resolve-late-cm")
			irp.Spec.Assets = []aiv1alpha1.Asset{
				{Name: testAssetName, ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: "isvc-resolve-late-cm"}, EnvFrom: ptrTo(true)},
			}
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			mv := validModelVersion("isvc-resolve-late-cm-mv")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, mv) }()

			isvc := validInferenceService("isvc-resolve-late-cm", mv.Name)
			isvc.Spec.ProfileRef = irp.Name
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionResolved)
				g.Expect(cond).ToNot(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			}, "15s", "200ms").Should(Succeed())

			cm := &corev1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{Name: "isvc-resolve-late-cm", Namespace: systemNamespace},
				Immutable:  ptrTo(true),
				Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
			}
			Expect(k8sClient.Create(ctx, cm)).To(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionResolved)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})
	})

	Context("Rendered, revision and warnings", func() {
		// validRenderProfile returns a profile with declared overrides, a vars
		// map, one asset and one Deployment role whose env references many
		// variables. The caller overrides fields per test.
		validRenderProfile := func(name string) *aiv1alpha1.InferenceRuntimeProfile {
			irp := validInferenceRuntimeProfile(name)
			irp.Spec.Vars = map[string]string{"launcher": testLauncher}
			irp.Spec.Assets = []aiv1alpha1.Asset{
				{Name: testAssetName, ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: name + "-cm"}, EnvFrom: ptrTo(true)},
			}
			irp.Spec.Overrides = []aiv1alpha1.Override{
				{Name: testOverridePrefillReplicas, Type: aiv1alpha1.OverrideTypeInteger, Min: ptrTo[int64](1), Max: ptrTo[int64](8), Default: &apiextensionsv1.JSON{Raw: []byte("1")}},
				{Name: "mode", Type: aiv1alpha1.OverrideTypeString, Enum: []apiextensionsv1.JSON{{Raw: []byte(`"pd"`)}, {Raw: []byte(`"normal"`)}}},
			}
			irp.Spec.Roles[0].Workload.Replicas = ptrTo(intstr.FromString("{{ overrides.prefillReplicas }}"))
			irp.Spec.Roles[0].PodTemplate.Env = append(irp.Spec.Roles[0].PodTemplate.Env,
				aiv1alpha1.EnvVar{Name: "LAUNCHER", Value: ptrTo("{{ profile.vars.launcher }}")})
			irp.Spec.Roles[0].PodTemplate.Env = append(irp.Spec.Roles[0].PodTemplate.Env,
				aiv1alpha1.EnvVar{Name: "MODEL_PATH", Value: ptrTo("{{ model.path }}")})
			irp.Spec.Roles[0].PodTemplate.Mounts = []aiv1alpha1.ModelMount{{Model: "main", At: "/workspace/model", ReadOnly: true}}
			return irp
		}

		createRenderBase := func(name string) (*aiv1alpha1.InferenceRuntimeProfile, *aiv1alpha1.ModelVersion) {
			irp := validRenderProfile(name)
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			mv := validModelVersion(name + "-mv")
			Expect(k8sClient.Create(ctx, mv)).To(Succeed())
			cm := &corev1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{Name: name + "-cm", Namespace: systemNamespace},
				Immutable:  ptrTo(true),
				Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
			}
			Expect(k8sClient.Create(ctx, cm)).To(Succeed())
			// The IRP controller writes status on the profile and source
			// ConfigMap creates, bumping the resourceVersion. Wait for the
			// status to settle, then re-read, so the tests' later spec updates
			// are valid optimistic-concurrency updates.
			settled := &aiv1alpha1.InferenceRuntimeProfile{}
			Eventually(func(g Gomega) {
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name}, settled)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(settled.Status.Conditions, aiv1alpha1.ConditionAssetsResolved)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
			return settled, mv
		}

		createRenderISVC := func(name string, irp *aiv1alpha1.InferenceRuntimeProfile, mv *aiv1alpha1.ModelVersion) {
			isvc := validInferenceService(name, mv.Name)
			isvc.Spec.ProfileRef = irp.Name
			isvc.Spec.Overrides = map[string]apiextensionsv1.JSON{testOverridePrefillReplicas: {Raw: []byte("2")}}
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
		}

		It("marks Rendered true and stores the revision", func() {
			irp, mv := createRenderBase("isvc-render-ok")
			defer func() {
				_ = k8sClient.Delete(ctx, irp)
				_ = k8sClient.Delete(ctx, mv)
			}()
			createRenderISVC("isvc-render-ok", irp, mv)
			defer func() {
				_ = k8sClient.Delete(ctx, &aiv1alpha1.InferenceService{ObjectMeta: metav1.ObjectMeta{Name: "isvc-render-ok", Namespace: testNamespace}})
			}()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: "isvc-render-ok", Namespace: testNamespace}, got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRendered)).To(BeTrue())
				g.Expect(got.Status.Profile).ToNot(BeNil())
				g.Expect(got.Status.Profile.Revision).To(HavePrefix("sha256:"))
				drifted := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionProfileDrifted)
				g.Expect(drifted).ToNot(BeNil())
				g.Expect(drifted.Status).To(Equal(metav1.ConditionFalse))
				deprecated := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionProfileDeprecated)
				g.Expect(deprecated).ToNot(BeNil())
				g.Expect(deprecated.Status).To(Equal(metav1.ConditionFalse))
			}, "15s", "200ms").Should(Succeed())
		})

		It("rejects an unknown override key", func() {
			irp, mv := createRenderBase("isvc-render-unknown-ov")
			defer func() {
				_ = k8sClient.Delete(ctx, irp)
				_ = k8sClient.Delete(ctx, mv)
			}()
			isvc := validInferenceService("isvc-render-unknown-ov", mv.Name)
			isvc.Spec.ProfileRef = irp.Name
			isvc.Spec.Overrides = map[string]apiextensionsv1.JSON{"bogus": {Raw: []byte("1")}}
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRendered)
				g.Expect(cond).ToNot(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal("UnknownOverride"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("rejects an invalid override value (enum violation)", func() {
			irp, mv := createRenderBase("isvc-render-invalid-ov")
			defer func() {
				_ = k8sClient.Delete(ctx, irp)
				_ = k8sClient.Delete(ctx, mv)
			}()
			isvc := validInferenceService("isvc-render-invalid-ov", mv.Name)
			isvc.Spec.ProfileRef = irp.Name
			isvc.Spec.Overrides = map[string]apiextensionsv1.JSON{"mode": {Raw: []byte(`"fast"`)}}
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRendered)
				g.Expect(cond).ToNot(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal("InvalidOverride"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("rejects unknown placeholders", func() {
			irp, mv := createRenderBase("isvc-render-unknown-ph")
			defer func() {
				_ = k8sClient.Delete(ctx, irp)
				_ = k8sClient.Delete(ctx, mv)
			}()
			isvc := validInferenceService("isvc-render-unknown-ph", mv.Name)
			isvc.Spec.ProfileRef = irp.Name
			irp.Spec.Roles[0].PodTemplate.Env = append(irp.Spec.Roles[0].PodTemplate.Env,
				aiv1alpha1.EnvVar{Name: "BAD", Value: ptrTo("{{ bogus.x }}")})
			Expect(k8sClient.Update(ctx, irp)).To(Succeed())
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRendered)
				g.Expect(cond).ToNot(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal("UnknownPlaceholder"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("rejects model.path in a role without a model mount", func() {
			irp, mv := createRenderBase("isvc-render-nomount")
			defer func() {
				_ = k8sClient.Delete(ctx, irp)
				_ = k8sClient.Delete(ctx, mv)
			}()
			irp.Spec.Roles[0].PodTemplate.Mounts = nil
			Expect(k8sClient.Update(ctx, irp)).To(Succeed())
			isvc := validInferenceService("isvc-render-nomount", mv.Name)
			isvc.Spec.ProfileRef = irp.Name
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRendered)
				g.Expect(cond).ToNot(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(cond.Reason).To(Equal("ModelNotMounted"))
			}, "15s", "200ms").Should(Succeed())
		})

		It("flags ProfileDeprecated for a deprecated profile", func() {
			irp, mv := createRenderBase("isvc-render-deprecated")
			defer func() {
				_ = k8sClient.Delete(ctx, irp)
				_ = k8sClient.Delete(ctx, mv)
			}()
			irp.Labels = map[string]string{deprecatedLabelKey: "true"}
			Expect(k8sClient.Update(ctx, irp)).To(Succeed())
			isvc := validInferenceService("isvc-render-deprecated", mv.Name)
			isvc.Spec.ProfileRef = irp.Name
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionProfileDeprecated)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())
		})

		It("flags ProfileDrifted when the profile is recreated with breaking content, then clears", func() {
			irp, mv := createRenderBase("isvc-render-drift")
			defer func() {
				_ = k8sClient.Delete(ctx, irp)
				_ = k8sClient.Delete(ctx, mv)
			}()
			isvc := validInferenceService("isvc-render-drift", mv.Name)
			isvc.Spec.ProfileRef = irp.Name
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRendered)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			// Recreate the profile with a different vars map: the template
			// references {{ profile.vars.launcher }} which no longer exists.
			Expect(k8sClient.Delete(ctx, irp)).To(Succeed())
			Eventually(func() bool {
				err := k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, &aiv1alpha1.InferenceRuntimeProfile{})
				return apierrors.IsNotFound(err)
			}, "15s", "200ms").Should(BeTrue())
			irp2 := validRenderProfile("isvc-render-drift")
			irp2.Spec.Vars = map[string]string{"other": "x"}
			Expect(k8sClient.Create(ctx, irp2)).To(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				cond := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRendered)
				g.Expect(cond).ToNot(BeNil())
				g.Expect(cond.Status).To(Equal(metav1.ConditionFalse))
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionProfileDrifted)).To(BeTrue())
				// The last adopted revision is preserved while the render is
				// broken: ProfileDrifted compares the current hash against it.
				g.Expect(got.Status.Profile).ToNot(BeNil())
				g.Expect(got.Status.Profile.Revision).To(HavePrefix("sha256:"))
			}, "15s", "200ms").Should(Succeed())

			// Restore the launcher var: the render succeeds again, the revision
			// is updated and the drift clears. envtest runs no VAP, so the spec
			// update (rejected in production by immutability) is allowed here —
			// exactly what the recreation scenario needs.
			current := &aiv1alpha1.InferenceRuntimeProfile{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, current)).To(Succeed())
			current.Spec.Vars = map[string]string{"launcher": testLauncher}
			Expect(k8sClient.Update(ctx, current)).To(Succeed())
			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRendered)).To(BeTrue())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionProfileDrifted)).To(BeFalse())
			}, "15s", "200ms").Should(Succeed())
		})

		It("does not flag ProfileDrifted when the profileRef switches", func() {
			irpA, mvA := createRenderBase("isvc-render-switch-a")
			defer func() {
				_ = k8sClient.Delete(ctx, irpA)
				_ = k8sClient.Delete(ctx, mvA)
			}()
			irpB, mvB := createRenderBase("isvc-render-switch-b")
			defer func() {
				_ = k8sClient.Delete(ctx, irpB)
				_ = k8sClient.Delete(ctx, mvB)
			}()

			isvc := validInferenceService("isvc-render-switch", mvA.Name)
			isvc.Spec.ProfileRef = irpA.Name
			isvc.Spec.Overrides = map[string]apiextensionsv1.JSON{testOverridePrefillReplicas: {Raw: []byte("2")}}
			Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, isvc) }()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRendered)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			// Switch to a different profile: its hash must not be compared
			// against the previous profile's revision.
			current := &aiv1alpha1.InferenceService{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, current)).To(Succeed())
			current.Spec.ProfileRef = irpB.Name
			Expect(k8sClient.Update(ctx, current)).To(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: isvc.Name, Namespace: testNamespace}, got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRendered)).To(BeTrue())
				drifted := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionProfileDrifted)
				g.Expect(drifted).ToNot(BeNil())
				g.Expect(drifted.Status).To(Equal(metav1.ConditionFalse))
			}, "15s", "200ms").Should(Succeed())
		})

		It("does not flag ProfileDrifted when an override changes", func() {
			name := "isvc-render-ov-change"
			irp, mv := createRenderBase(name)
			defer func() {
				_ = k8sClient.Delete(ctx, irp)
				_ = k8sClient.Delete(ctx, mv)
			}()
			createRenderISVC(name, irp, mv)
			defer func() {
				_ = k8sClient.Delete(ctx, &aiv1alpha1.InferenceService{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace}})
			}()

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, got)).To(Succeed())
				g.Expect(meta.IsStatusConditionTrue(got.Status.Conditions, aiv1alpha1.ConditionRendered)).To(BeTrue())
			}, "15s", "200ms").Should(Succeed())

			// The revision hashes profile and asset content only, so an
			// override change must neither alter it nor flag drift.
			current := &aiv1alpha1.InferenceService{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, current)).To(Succeed())
			current.Spec.Overrides = map[string]apiextensionsv1.JSON{testOverridePrefillReplicas: {Raw: []byte("5")}}
			Expect(k8sClient.Update(ctx, current)).To(Succeed())

			Eventually(func(g Gomega) {
				got := &aiv1alpha1.InferenceService{}
				g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, got)).To(Succeed())
				drifted := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionProfileDrifted)
				g.Expect(drifted).ToNot(BeNil())
				g.Expect(drifted.Status).To(Equal(metav1.ConditionFalse))
			}, "15s", "200ms").Should(Succeed())
		})
	})
})
