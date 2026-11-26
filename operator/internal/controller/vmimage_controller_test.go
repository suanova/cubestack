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
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

const (
	// vmImageTestRegistry is the catalogue entry's registry artifact.
	vmImageTestRegistry = "registry.cubestack.io/cubestack/guest-ubuntu-22.04:2026.11"

	// vmImageTestName is the catalogue entry every spec below references.
	vmImageTestName = "vmimage-ubuntu-22-04"

	// DataVolume status keys. They are constants because the specs read them
	// repeatedly and goconst counts the package as a whole.
	dvStatusKey     = "status"
	dvPhaseKey      = "phase"
	dvProgressKey   = "progress"
	dvConditionsKey = "conditions"
	dvSpecKey       = "spec"
	dvSourceKey     = "source"

	// testSystemDiskSize is the catalogue entry's minimum system disk.
	testSystemDiskSize = "20Gi"

	// cdiPhaseFailed is the phase a failed CDI import reports.
	cdiPhaseFailed = "Failed"
)

// testVMImage builds a catalogue entry for the specs below.
func testVMImage(name string, source aiv1alpha1.VMImageSource) *aiv1alpha1.VMImage {
	return &aiv1alpha1.VMImage{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: aiv1alpha1.VMImageSpec{
			DisplayName:   "Ubuntu 22.04 LTS Server",
			OS:            "ubuntu",
			OSVersion:     "22.04",
			Architecture:  "amd64",
			MinSystemDisk: resource.MustParse(testSystemDiskSize),
			GuestAgent:    true,
			Source:        source,
		},
	}
}

// testVMEnvironment builds the smallest environment that can reference an
// image; the VMEnvironment controller itself arrives with #514.
func testVMEnvironment(name, image string) *aiv1alpha1.VMEnvironment {
	return &aiv1alpha1.VMEnvironment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		Spec: aiv1alpha1.VMEnvironmentSpec{
			Image:      image,
			SystemDisk: aiv1alpha1.VMSystemDisk{Size: resource.MustParse(testSystemDiskSize)},
		},
	}
}

// systemDataVolume reads a DataVolume from the platform namespace, nil when it
// does not exist.
func systemDataVolume(name string) *unstructured.Unstructured {
	dv := newDataVolumeObject()
	err := k8sClient.Get(ctx, types.NamespacedName{Namespace: systemNamespace, Name: name}, dv)
	if apierrors.IsNotFound(err) {
		return nil
	}
	ExpectWithOffset(1, err).NotTo(HaveOccurred())
	return dv
}

// setDataVolumeStatus writes the CDI status a real importer would report.
func setDataVolumeStatus(name, phase, progress, failure string) {
	dv := systemDataVolume(name)
	ExpectWithOffset(1, dv).NotTo(BeNil())
	status := map[string]any{dvPhaseKey: phase}
	if progress != "" {
		status[dvProgressKey] = progress
	}
	if failure != "" {
		status[dvConditionsKey] = []any{map[string]any{
			"type":    "Ready",
			"status":  "False",
			"message": failure,
		}}
	}
	dv.Object[dvStatusKey] = status
	ExpectWithOffset(1, k8sClient.Status().Update(ctx, dv)).To(Succeed())
}

// imageReady returns the image's Ready condition, failing the calling spec
// when it is absent.
func imageReady(g Gomega, name string) *metav1.Condition {
	image := &aiv1alpha1.VMImage{}
	g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name}, image)).To(Succeed())
	condition := meta.FindStatusCondition(image.Status.Conditions, aiv1alpha1.ConditionReady)
	g.Expect(condition).NotTo(BeNil())
	return condition
}

var _ = Describe("VMImage controller", func() {
	BeforeEach(func() {
		ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: systemNamespace}}
		if err := k8sClient.Create(ctx, ns); err != nil && !apierrors.IsAlreadyExists(err) {
			Expect(err).NotTo(HaveOccurred())
		}
	})

	// envtest runs no garbage collector, so the platform's DataVolume outlives
	// the image that owns it; every spec removes it itself.
	deleteGolden := func(name string) {
		dv := newDataVolumeObject()
		dv.SetNamespace(systemNamespace)
		dv.SetName(name)
		_ = k8sClient.Delete(ctx, dv)
	}

	It("imports the golden disk when an environment first references the image", func() {
		image := testVMImage(vmImageTestName, aiv1alpha1.VMImageSource{Registry: vmImageTestRegistry})
		Expect(k8sClient.Create(ctx, image)).To(Succeed())
		DeferCleanup(func() {
			_ = k8sClient.Delete(ctx, image)
			deleteGolden(goldenDataVolumeName(vmImageTestName))
		})

		// Published but unused: the catalogue records the image, nothing is
		// imported.
		Eventually(func(g Gomega) {
			g.Expect(imageReady(g, vmImageTestName).Reason).To(Equal("NotReferenced"))
		}, "15s", "200ms").Should(Succeed())
		Expect(systemDataVolume(goldenDataVolumeName(vmImageTestName))).To(BeNil())

		env := testVMEnvironment("vme-golden-ref", vmImageTestName)
		Expect(k8sClient.Create(ctx, env)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, env) })

		Eventually(func(g Gomega) {
			g.Expect(systemDataVolume(goldenDataVolumeName(vmImageTestName))).NotTo(BeNil())
		}, "15s", "200ms").Should(Succeed())

		dv := systemDataVolume(goldenDataVolumeName(vmImageTestName))
		spec, found, err := unstructured.NestedMap(dv.Object, dvSpecKey)
		Expect(err).NotTo(HaveOccurred())
		Expect(found).To(BeTrue())
		Expect(spec).To(Equal(map[string]any{
			dvSourceKey: map[string]any{
				"registry": map[string]any{"url": "docker://" + vmImageTestRegistry},
			},
			"storage": map[string]any{
				"accessModes":      []any{string(corev1.ReadWriteOnce)},
				"volumeMode":       string(corev1.PersistentVolumeBlock),
				"storageClassName": goldenImageStorageClass,
				"resources": map[string]any{
					"requests": map[string]any{"storage": testSystemDiskSize},
				},
			},
		}))
		owner := metav1.GetControllerOf(dv)
		Expect(owner).NotTo(BeNil())
		Expect(owner.UID).To(Equal(image.UID))

		Eventually(func(g Gomega) {
			condition := imageReady(g, vmImageTestName)
			g.Expect(condition.Status).To(Equal(metav1.ConditionFalse))
			g.Expect(condition.Reason).To(Equal(diskPhaseImporting))
			stored := &aiv1alpha1.VMImage{}
			g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: vmImageTestName}, stored)).To(Succeed())
			g.Expect(stored.Status.DataVolume).To(Equal(dv.GetName()))
		}, "15s", "200ms").Should(Succeed())

		// The importer's percentage reaches the condition.
		setDataVolumeStatus(dv.GetName(), "ImportInProgress", "42.5%", "")
		Eventually(func(g Gomega) {
			condition := imageReady(g, vmImageTestName)
			g.Expect(condition.Reason).To(Equal(diskPhaseImporting))
			g.Expect(condition.Message).To(ContainSubstring("42% complete"))
		}, "15s", "200ms").Should(Succeed())

		// Succeeded is the transition to usable.
		setDataVolumeStatus(dv.GetName(), "Succeeded", "100.0%", "")
		Eventually(func(g Gomega) {
			condition := imageReady(g, vmImageTestName)
			g.Expect(condition.Status).To(Equal(metav1.ConditionTrue))
			g.Expect(condition.Reason).To(Equal("Imported"))
		}, "15s", "200ms").Should(Succeed())
	})

	It("reports a failed import with the importer's own message", func() {
		name := "vmimage-import-fails"
		image := testVMImage(name, aiv1alpha1.VMImageSource{Registry: vmImageTestRegistry})
		Expect(k8sClient.Create(ctx, image)).To(Succeed())
		DeferCleanup(func() {
			_ = k8sClient.Delete(ctx, image)
			deleteGolden(goldenDataVolumeName(name))
		})
		env := testVMEnvironment("vme-import-fails", name)
		Expect(k8sClient.Create(ctx, env)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, env) })

		goldenName := goldenDataVolumeName(name)
		Eventually(func(g Gomega) {
			g.Expect(systemDataVolume(goldenName)).NotTo(BeNil())
		}, "15s", "200ms").Should(Succeed())

		setDataVolumeStatus(goldenName, cdiPhaseFailed, "", "registry rejected the pull: unauthorized")
		Eventually(func(g Gomega) {
			condition := imageReady(g, name)
			g.Expect(condition.Status).To(Equal(metav1.ConditionFalse))
			g.Expect(condition.Reason).To(Equal("ImportFailed"))
			g.Expect(condition.Message).To(Equal("registry rejected the pull: unauthorized"))
		}, "15s", "200ms").Should(Succeed())
	})

	It("copies a source claim in the platform namespace", func() {
		name := "vmimage-from-pvc"
		image := testVMImage(name, aiv1alpha1.VMImageSource{
			PVC: &corev1.LocalObjectReference{Name: "ubuntu-golden-image"},
		})
		Expect(k8sClient.Create(ctx, image)).To(Succeed())
		DeferCleanup(func() {
			_ = k8sClient.Delete(ctx, image)
			deleteGolden(goldenDataVolumeName(name))
		})
		env := testVMEnvironment("vme-from-pvc", name)
		Expect(k8sClient.Create(ctx, env)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, env) })

		Eventually(func(g Gomega) {
			dv := systemDataVolume(goldenDataVolumeName(name))
			g.Expect(dv).NotTo(BeNil())
			src, found, err := unstructured.NestedMap(dv.Object, dvSpecKey, dvSourceKey)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(found).To(BeTrue())
			g.Expect(src).To(Equal(map[string]any{
				"pvc": map[string]any{"name": "ubuntu-golden-image", "namespace": systemNamespace},
			}))
		}, "15s", "200ms").Should(Succeed())
	})

	It("refuses a golden DataVolume another object controls", func() {
		name := "vmimage-conflict"
		foreign := &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": dataVolumeGVK.GroupVersion().String(),
			"kind":       dataVolumeGVK.Kind,
			metadataField: map[string]any{
				"name":      goldenDataVolumeName(name),
				"namespace": systemNamespace,
			},
			dvSpecKey: map[string]any{},
		}}
		Expect(k8sClient.Create(ctx, foreign)).To(Succeed())
		DeferCleanup(func() {
			_ = k8sClient.Delete(ctx, foreign)
			deleteGolden(goldenDataVolumeName(name))
		})

		image := testVMImage(name, aiv1alpha1.VMImageSource{Registry: vmImageTestRegistry})
		Expect(k8sClient.Create(ctx, image)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, image) })
		env := testVMEnvironment("vme-conflict", name)
		Expect(k8sClient.Create(ctx, env)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, env) })

		Eventually(func(g Gomega) {
			condition := imageReady(g, name)
			g.Expect(condition.Status).To(Equal(metav1.ConditionFalse))
			g.Expect(condition.Reason).To(Equal("DataVolumeConflict"))
		}, "15s", "200ms").Should(Succeed())

		// The foreign object is left alone.
		dv := systemDataVolume(goldenDataVolumeName(name))
		Expect(dv).NotTo(BeNil())
		Expect(metav1.GetControllerOf(dv)).To(BeNil())
	})
})

var _ = Describe("dataVolumeState", func() {
	DescribeTable("maps a DataVolume's status onto the disk phases",
		func(object map[string]any, want dataVolumeImportState) {
			got := dataVolumeState(&unstructured.Unstructured{Object: object})
			Expect(got).To(Equal(want))
		},
		Entry("no status yet",
			map[string]any{},
			dataVolumeImportState{phase: diskPhaseImporting}),
		Entry("importing with a percentage",
			map[string]any{dvStatusKey: map[string]any{dvPhaseKey: "ImportInProgress", dvProgressKey: "42.5%"}},
			dataVolumeImportState{phase: diskPhaseImporting, progress: ptrTo(int32(42)), message: "Importing: 42% complete"}),
		Entry("succeeded",
			map[string]any{dvStatusKey: map[string]any{dvPhaseKey: "Succeeded"}},
			dataVolumeImportState{phase: diskPhaseReady}),
		Entry("failed, with the importer's message",
			map[string]any{dvStatusKey: map[string]any{
				dvPhaseKey: cdiPhaseFailed,
				dvConditionsKey: []any{map[string]any{
					"type": "Ready", "status": "False", "message": "no space left on device",
				}},
			}},
			dataVolumeImportState{phase: diskPhaseFailed, message: "no space left on device"}),
		Entry("failed, with no explanation",
			map[string]any{dvStatusKey: map[string]any{dvPhaseKey: cdiPhaseFailed}},
			dataVolumeImportState{phase: diskPhaseFailed, message: "the disk import failed"}),
	)

	DescribeTable("reads CDI's progress string",
		func(progress string, want *int32) {
			Expect(parsePercent(progress)).To(Equal(want))
		},
		Entry("whole", "42.5%", ptrTo(int32(42))),
		Entry("complete", "100.0%", ptrTo(int32(100))),
		Entry("capped", "120%", ptrTo(int32(100))),
		Entry("no percentage", "", nil),
		Entry("negative", "-1%", nil),
		Entry("unreadable", "not-a-number", nil),
	)
})

var _ = Describe("VMImage catalogue helpers", func() {
	It("names the golden disk after the image", func() {
		Expect(goldenDataVolumeName("ubuntu-22.04")).To(Equal("ubuntu-22.04-golden"))
	})

	It("offers an image until it is deprecated", func() {
		image := testVMImage(vmImageTestName, aiv1alpha1.VMImageSource{Registry: vmImageTestRegistry})
		Expect(imageNotAllowed(image)).To(BeEmpty())

		image.Spec.Deprecated = true
		Expect(imageNotAllowed(image)).To(ContainSubstring("deprecated"))
	})
})
