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
	"fmt"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const (
	testVMImage = "ubuntu-24.04"
	testVMData  = "scratch"

	// testVMImageRegistry is the catalogue artifact the VMImage specs import.
	testVMImageRegistry = "harbor.isuanova.com/suanova/ubuntu:24.04"

	vmEnvironmentKind = "VMEnvironment"
	vmImageKind       = "VMImage"

	// Keys of the unstructured objects built by the raw-object tables. They are
	// constants because the sibling CRD tests name the same keys, and the
	// package-wide repetition is what goconst reports.
	objAPIVersion = "apiVersion"
	objKind       = "kind"
	objMetadata   = "metadata"
	objName       = "name"
	objSpec       = "spec"
	specImage     = "image"
	specResources = "resources"

	// specMinSystemDisk and specRegistry are the catalogue entry's disk and
	// artifact, named by the raw objects that write them in a form the typed
	// client cannot.
	specMinSystemDisk = "minSystemDisk"
	specRegistry      = "registry"
)

var vmEnvironmentGVR = schema.GroupVersionResource{
	Group:    SchemeGroupVersion.Group,
	Version:  SchemeGroupVersion.Version,
	Resource: "vmenvironments",
}

var vmImageGVR = schema.GroupVersionResource{
	Group:    SchemeGroupVersion.Group,
	Version:  SchemeGroupVersion.Version,
	Resource: "vmimages",
}

// rawVMEnvironment builds a VMEnvironment object map with a single copy of the
// apiVersion/kind/metadata/spec keys shared by the raw-object tables.
func rawVMEnvironment(name string, spec map[string]any) map[string]any {
	return map[string]any{
		objAPIVersion: testAPIVersion,
		objKind:       vmEnvironmentKind,
		objMetadata:   map[string]any{objName: name, "namespace": testNamespace},
		objSpec:       spec,
	}
}

// rawVMImage builds a cluster-scoped VMImage object map around a raw source, so
// values the typed client cannot express (an empty string) reach the schema.
func rawVMImage(name string, source map[string]any) map[string]any {
	return map[string]any{
		objAPIVersion: testAPIVersion,
		objKind:       vmImageKind,
		objMetadata:   map[string]any{objName: name},
		objSpec: map[string]any{
			"displayName":     "Ubuntu 24.04 LTS",
			"os":              "ubuntu",
			"osVersion":       "24.04",
			"architecture":    "amd64",
			specMinSystemDisk: "20Gi",
			"guestAgent":      true,
			"source":          source,
		},
	}
}

func validVMEnvironment(name string) *VMEnvironment {
	size := resource.MustParse("100Gi")

	return &VMEnvironment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		Spec: VMEnvironmentSpec{
			Image: testVMImage,
			Resources: ResourcesSpec{
				GPU:    &GPUSpec{Vendor: AcceleratorVendorMetax, Count: ptrTo(int32(1))},
				CPU:    "16",
				Memory: "64Gi",
			},
			SystemDisk: VMSystemDisk{Size: resource.MustParse("40Gi")},
			DataDisks:  []VMDataDisk{{Name: testVMData, Type: VMDataDiskBlock, Size: &size}},
			Network:    &VMNetworkSpec{RDMAEnabled: false, RDMAType: RDMATypeRoCE},
			SSH:        &VMSSHSpec{Enabled: ptrTo(true)},
			Ports:      []PortSpec{{Name: testPortName, Type: PortTypeHTTP, ContainerPort: 8080}},
		},
	}
}

var _ = Describe("VMEnvironment", func() {
	Context("valid objects", func() {
		It("accepts a valid VMEnvironment and round-trips its spec", func() {
			vme := validVMEnvironment("vme-valid")
			// Create decodes the stored object back into vme, so the expectation
			// is taken before the call: a default or an admission rewrite landing
			// in both objects would otherwise pass unnoticed.
			want := vme.Spec.DeepCopy()

			Expect(k8sClient.Create(ctx, vme)).To(Succeed())

			got := &VMEnvironment{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: vme.Name, Namespace: vme.Namespace}, got)).To(Succeed())
			Expect(got.Spec).To(Equal(*want))

			Expect(k8sClient.Delete(ctx, vme)).To(Succeed())
		})

		It("accepts the minimal spec, with no data disks, network or ssh block", func() {
			vme := &VMEnvironment{
				ObjectMeta: metav1.ObjectMeta{Name: "vme-minimal", Namespace: testNamespace},
				Spec: VMEnvironmentSpec{
					Image:      testVMImage,
					Resources:  ResourcesSpec{},
					SystemDisk: VMSystemDisk{Size: resource.MustParse("20Gi")},
				},
			}

			Expect(k8sClient.Create(ctx, vme)).To(Succeed())
			Expect(k8sClient.Delete(ctx, vme)).To(Succeed())
		})

		It("accepts a name the API server generates", func() {
			// The generated name is checked by the same root rule as an explicit
			// one: the apiserver fills metadata.name before admission runs.
			vme := validVMEnvironment("")
			vme.GenerateName = "vme-"

			Expect(k8sClient.Create(ctx, vme)).To(Succeed())
			Expect(vme.Name).NotTo(BeEmpty())
			Expect(k8sClient.Delete(ctx, vme)).To(Succeed())
		})

		It("applies the documented defaults for omitted optional fields", func() {
			size := resource.MustParse("100Gi")
			vme := &VMEnvironment{
				ObjectMeta: metav1.ObjectMeta{Name: "vme-defaults", Namespace: testNamespace},
				Spec: VMEnvironmentSpec{
					Image:      testVMImage,
					Resources:  ResourcesSpec{GPU: &GPUSpec{}},
					SystemDisk: VMSystemDisk{Size: resource.MustParse("20Gi")},
					DataDisks:  []VMDataDisk{{Name: testVMData, Size: &size}},
					Network:    &VMNetworkSpec{},
					SSH:        &VMSSHSpec{},
					Ports:      []PortSpec{{Name: testPortName, ContainerPort: 8080}},
				},
			}

			Expect(k8sClient.Create(ctx, vme)).To(Succeed())

			got := &VMEnvironment{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: vme.Name, Namespace: vme.Namespace}, got)).To(Succeed())
			Expect(got.Spec.Running).To(BeFalse())
			// The vendor default stays nvidia even on a cluster that only has
			// MetaX cards: the controller rejects the request rather than
			// rewriting what the user wrote.
			Expect(got.Spec.Resources.GPU.Vendor).To(Equal(AcceleratorVendorNvidia))
			Expect(got.Spec.Resources.GPU.Count).To(Equal(ptrTo(int32(1))))
			Expect(got.Spec.SystemDisk.Retain).To(BeFalse())
			Expect(got.Spec.DataDisks[0].Type).To(Equal(VMDataDiskBlock))
			Expect(got.Spec.DataDisks[0].Retain).To(BeFalse())
			Expect(got.Spec.DataDisks[0].ReadOnly).To(BeFalse())
			Expect(got.Spec.Network.RDMAEnabled).To(BeFalse())
			Expect(got.Spec.Network.RDMAType).To(Equal(RDMATypeRoCE))
			// SSH is on by default, password login is off: an unreachable
			// password prompt is the safe default.
			Expect(got.Spec.SSH.Enabled).To(Equal(ptrTo(true)))
			Expect(got.Spec.SSH.PasswordAuth).To(BeNil())
			Expect(got.Spec.Ports[0].Type).To(Equal(PortTypeHTTP))

			// A default equal to the Go zero value is indistinguishable from an
			// absent field through the typed object, so presence is asserted on
			// the stored form: a default silently dropped from the schema would
			// leave the field unset here.
			raw := &unstructured.Unstructured{}
			raw.SetAPIVersion(testAPIVersion)
			raw.SetKind(vmEnvironmentKind)
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: vme.Name, Namespace: vme.Namespace}, raw)).To(Succeed())
			fields, found, err := unstructured.NestedMap(raw.Object, objSpec)
			Expect(err).NotTo(HaveOccurred())
			Expect(found).To(BeTrue())
			Expect(fields).To(HaveKeyWithValue("running", false))
			Expect(fields["systemDisk"]).To(HaveKeyWithValue("retain", false))
			Expect(fields["network"]).To(HaveKeyWithValue("rdmaEnabled", false))
			disks, ok := fields["dataDisks"].([]any)
			Expect(ok).To(BeTrue())
			Expect(disks).To(HaveLen(1))
			disk, ok := disks[0].(map[string]any)
			Expect(ok).To(BeTrue())
			Expect(disk).To(HaveKeyWithValue("retain", false))
			Expect(disk).To(HaveKeyWithValue("readOnly", false))

			Expect(k8sClient.Delete(ctx, got)).To(Succeed())
		})

		It("updates status through the status subresource", func() {
			vme := validVMEnvironment("vme-status")
			Expect(k8sClient.Create(ctx, vme)).To(Succeed())

			now := metav1.Now()
			vme.Status.Phase = &VMPhase{Name: VMPhaseRunning, LastTransitionTime: &now}
			vme.Status.IP = "10.0.0.10"
			vme.Status.Conditions = []metav1.Condition{{
				Type:               ConditionGuestReady,
				Status:             metav1.ConditionTrue,
				Reason:             "GuestAgentReady",
				Message:            "guest agent answered",
				LastTransitionTime: now,
			}}
			Expect(k8sClient.Status().Update(ctx, vme)).To(Succeed())

			got := &VMEnvironment{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: vme.Name, Namespace: vme.Namespace}, got)).To(Succeed())
			Expect(got.Status.Phase.Name).To(Equal(VMPhaseRunning))
			Expect(got.Status.IP).To(Equal("10.0.0.10"))
			Expect(got.Status.Conditions).To(HaveLen(1))
			Expect(got.Status.Conditions[0].Type).To(Equal(ConditionGuestReady))

			Expect(k8sClient.Delete(ctx, got)).To(Succeed())
		})
	})

	Context("spec validation", func() {
		DescribeTable("rejects invalid objects",
			func(name string, mutate func(*VMEnvironmentSpec), wantMessage string) {
				vme := validVMEnvironment(name)
				mutate(&vme.Spec)

				err := k8sClient.Create(ctx, vme)
				Expect(err).To(HaveOccurred())
				Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
				Expect(err.Error()).To(ContainSubstring(wantMessage))
			},
			Entry("empty image",
				"vme-invalid-image",
				func(s *VMEnvironmentSpec) { s.Image = "" },
				"spec.image"),
			Entry("data disk with both size and pvcName",
				"vme-invalid-disk-both",
				func(s *VMEnvironmentSpec) {
					size := resource.MustParse("100Gi")
					s.DataDisks = []VMDataDisk{{
						Name: testVMData, Type: VMDataDiskShared, Size: &size, PVCName: "shared-data",
					}}
				},
				"exactly one of size and pvcName"),
			Entry("data disk with neither size nor pvcName",
				"vme-invalid-disk-neither",
				func(s *VMEnvironmentSpec) {
					s.DataDisks = []VMDataDisk{{Name: testVMData}}
				},
				"exactly one of size and pvcName"),
			Entry("pvcName on a block disk",
				"vme-invalid-disk-pvc-block",
				func(s *VMEnvironmentSpec) {
					s.DataDisks = []VMDataDisk{{
						Name: testVMData, Type: VMDataDiskBlock, PVCName: "shared-data",
					}}
				},
				"pvcName is only allowed for type=shared"),
			Entry("underlay without a pool",
				"vme-invalid-underlay",
				func(s *VMEnvironmentSpec) {
					s.Network = &VMNetworkSpec{Underlay: &VMUnderlaySpec{}}
				},
				"pool"),
			Entry("password auth with ssh disabled",
				"vme-invalid-password",
				func(s *VMEnvironmentSpec) {
					s.SSH = &VMSSHSpec{Enabled: ptrTo(false), PasswordAuth: &VMSSHPasswordAuth{}}
				},
				"passwordAuth requires ssh.enabled"),
			Entry("infiniBand rdmaType",
				"vme-invalid-rdmatype",
				func(s *VMEnvironmentSpec) {
					// The fabric enum offers roce only: InfiniBand is refused at
					// admission rather than accepted and reported later.
					s.Network = &VMNetworkSpec{RDMAEnabled: true, RDMAType: RDMAType("infiniband")}
				},
				"Unsupported value"),
			Entry("image that is not a VMImage name",
				"vme-invalid-image-ref",
				func(s *VMEnvironmentSpec) {
					// A reference the catalogue could never resolve is refused
					// rather than stored.
					s.Image = "registry.cubestack.io/cubestack/ubuntu:24.04"
				},
				"spec.image"),
			Entry("duplicate data disk name",
				"vme-invalid-disk-dup",
				func(s *VMEnvironmentSpec) {
					size := resource.MustParse("100Gi")
					s.DataDisks = []VMDataDisk{
						{Name: testVMData, Type: VMDataDiskBlock, Size: &size},
						{Name: testVMData, Type: VMDataDiskBlock, Size: &size},
					}
				},
				"Duplicate value"),
		)

		// The typed client omits empty strings, so the non-empty rules on
		// pvcName and on the Secret selectors are only reachable as raw objects.
		DescribeTable("rejects raw values the typed client cannot express",
			func(name string, mutate func(map[string]any), wantMessage string) {
				spec := map[string]any{
					specImage:     testVMImage,
					specResources: map[string]any{},
					"systemDisk":  map[string]any{"size": "20Gi"},
				}
				mutate(spec)

				dynClient := dynamic.NewForConfigOrDie(cfg)
				_, err := dynClient.Resource(vmEnvironmentGVR).Namespace(testNamespace).Create(
					ctx, &unstructured.Unstructured{Object: rawVMEnvironment(name, spec)}, metav1.CreateOptions{})
				Expect(err).To(HaveOccurred())
				Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
				Expect(err.Error()).To(ContainSubstring(wantMessage))
			},
			Entry("empty pvcName on a shared disk",
				"vme-invalid-pvc-empty",
				func(s map[string]any) {
					// Presence alone would pass the CEL rules while naming no claim.
					s["dataDisks"] = []any{map[string]any{
						objName: testVMData, "type": "shared", "pvcName": "",
					}}
				},
				"spec.dataDisks"),
			Entry("ssh key selector with no Secret name",
				"vme-invalid-key-selector",
				func(s map[string]any) {
					s["ssh"] = map[string]any{
						"authorizedKeysSecret": map[string]any{"key": "authorized_keys"},
					}
				},
				"the Secret name and its data key must both be named"),
			Entry("ssh password selector with an empty data key",
				"vme-invalid-password-selector",
				func(s map[string]any) {
					// key is required, so only an empty value reaches the rule;
					// omitting it is refused as a required field first.
					s["ssh"] = map[string]any{
						"passwordAuth": map[string]any{
							"passwordSecret": map[string]any{objName: "vme-password", "key": ""},
						},
					}
				},
				"the Secret name and its data key must both be named"),
		)

		It("refuses a name that is not a DNS-1035 label", func() {
			// The name is the prefix of every object the platform derives, and
			// the godoc states the DNS-1035 rule the API server would otherwise
			// not apply (it admits a DNS-1123 subdomain).
			vme := validVMEnvironment("vme.not.a.label")
			err := k8sClient.Create(ctx, vme)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("DNS-1035"))
		})
	})
})

var _ = Describe("VMImage", func() {
	validVMImage := func(name string, source VMImageSource) *VMImage {
		return &VMImage{
			ObjectMeta: metav1.ObjectMeta{Name: name},
			Spec: VMImageSpec{
				DisplayName:   "Ubuntu 24.04 LTS",
				OS:            "ubuntu",
				OSVersion:     "24.04",
				Architecture:  "amd64",
				MinSystemDisk: resource.MustParse("20Gi"),
				GuestAgent:    true,
				Source:        source,
			},
		}
	}

	It("is cluster-scoped and round-trips its spec and status", func() {
		img := validVMImage("vmimage-ubuntu-24-04", VMImageSource{Registry: testVMImageRegistry})
		want := img.Spec.DeepCopy()

		Expect(k8sClient.Create(ctx, img)).To(Succeed())

		got := &VMImage{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: img.Name}, got)).To(Succeed())
		Expect(got.Spec).To(Equal(*want))

		now := metav1.Now()
		got.Status.DataVolume = "vmimage-ubuntu-24-04-golden"
		got.Status.Conditions = []metav1.Condition{{
			Type:               ConditionReady,
			Status:             metav1.ConditionTrue,
			Reason:             "Imported",
			Message:            "golden disk is usable",
			LastTransitionTime: now,
		}}
		Expect(k8sClient.Status().Update(ctx, got)).To(Succeed())

		// A fresh object, so the assertions prove the status was persisted rather
		// than read back out of the object that wrote it.
		persisted := &VMImage{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: img.Name}, persisted)).To(Succeed())
		Expect(persisted.Status.DataVolume).To(Equal("vmimage-ubuntu-24-04-golden"))
		Expect(persisted.Status.Conditions).To(HaveLen(1))
		Expect(persisted.Status.Conditions[0].Type).To(Equal(ConditionReady))
		Expect(persisted.Status.Conditions[0].Status).To(Equal(metav1.ConditionTrue))

		Expect(k8sClient.Delete(ctx, got)).To(Succeed())
	})

	It("accepts a PVC source", func() {
		img := validVMImage("vmimage-from-pvc", VMImageSource{
			PVC: &corev1.LocalObjectReference{Name: "golden-ubuntu"},
		})

		Expect(k8sClient.Create(ctx, img)).To(Succeed())
		Expect(k8sClient.Delete(ctx, img)).To(Succeed())
	})

	DescribeTable("requires exactly one source",
		func(name string, source VMImageSource, wantMessage string) {
			img := validVMImage(name, source)

			err := k8sClient.Create(ctx, img)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring(wantMessage))
		},
		Entry("no source",
			"vmimage-no-source",
			VMImageSource{},
			"exactly one of source.registry and source.pvc"),
		Entry("both sources",
			"vmimage-both-sources",
			VMImageSource{Registry: testVMImageRegistry, PVC: &corev1.LocalObjectReference{Name: "golden"}},
			"exactly one of source.registry and source.pvc"),
	)

	// The typed client omits an empty string, so an empty registry (or claim
	// name) is only expressible as a raw object.
	DescribeTable("rejects empty source values",
		func(name string, source map[string]any, wantMessage string) {
			dynClient := dynamic.NewForConfigOrDie(cfg)
			_, err := dynClient.Resource(vmImageGVR).Create(
				ctx, &unstructured.Unstructured{Object: rawVMImage(name, source)}, metav1.CreateOptions{})
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring(wantMessage))
		},
		Entry("empty registry",
			"vmimage-empty-registry",
			map[string]any{specRegistry: ""},
			"exactly one of source.registry and source.pvc"),
		Entry("empty PVC name",
			"vmimage-empty-pvc",
			map[string]any{"pvc": map[string]any{objName: ""}},
			"the claim name must be set"),
	)

	DescribeTable("requires a positive minSystemDisk",
		func(name, size string) {
			img := validVMImage(name, VMImageSource{Registry: testVMImageRegistry})
			img.Spec.MinSystemDisk = resource.MustParse(size)

			err := k8sClient.Create(ctx, img)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("minSystemDisk must be a positive quantity"))
		},
		Entry("zero", "vmimage-zero-min-disk", "0"),
		Entry("negative", "vmimage-negative-min-disk", "-1Gi"),
	)

	// minSystemDisk is an int-or-string quantity, and the schema admits the
	// integer form; the typed client always writes the string one, so the
	// integer representation is only expressible as a raw object.
	DescribeTable("accepts minSystemDisk in either representation",
		func(name string, size any) {
			dynClient := dynamic.NewForConfigOrDie(cfg)
			obj := rawVMImage(name, map[string]any{specRegistry: testVMImageRegistry})
			obj[objSpec].(map[string]any)[specMinSystemDisk] = size

			created, err := dynClient.Resource(vmImageGVR).Create(
				ctx, &unstructured.Unstructured{Object: obj}, metav1.CreateOptions{})
			Expect(err).NotTo(HaveOccurred())
			DeferCleanup(func() {
				_ = dynClient.Resource(vmImageGVR).Delete(ctx, name, metav1.DeleteOptions{})
			})

			stored, found, err := unstructured.NestedFieldNoCopy(created.Object, objSpec, specMinSystemDisk)
			Expect(err).NotTo(HaveOccurred())
			Expect(found).To(BeTrue())
			disk := resource.MustParse(fmt.Sprint(stored))
			Expect(disk.Cmp(resource.MustParse("20Gi"))).To(Equal(0))
		},
		Entry("string", "vmimage-disk-string", "20Gi"),
		Entry("integer", "vmimage-disk-integer", int64(21474836480)),
	)

	DescribeTable("rejects a non-positive integer minSystemDisk",
		func(name string, size int64) {
			dynClient := dynamic.NewForConfigOrDie(cfg)
			obj := rawVMImage(name, map[string]any{specRegistry: testVMImageRegistry})
			obj[objSpec].(map[string]any)[specMinSystemDisk] = size

			_, err := dynClient.Resource(vmImageGVR).Create(
				ctx, &unstructured.Unstructured{Object: obj}, metav1.CreateOptions{})
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("minSystemDisk must be a positive quantity"))
		},
		Entry("zero", "vmimage-zero-integer-min-disk", int64(0)),
		Entry("negative", "vmimage-negative-integer-min-disk", int64(-1)),
	)

	It("fixes the disk's source and minimum size once the entry exists", func() {
		name := "vmimage-immutable-disk"
		img := validVMImage(name, VMImageSource{Registry: testVMImageRegistry})
		Expect(k8sClient.Create(ctx, img)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, img) })

		// A different source or a different size is a different disk, and the
		// entry's golden copy is imported from the one it was created with.
		for _, change := range []func(*VMImage){
			func(v *VMImage) { v.Spec.Source = VMImageSource{PVC: &corev1.LocalObjectReference{Name: "other"}} },
			func(v *VMImage) { v.Spec.MinSystemDisk = resource.MustParse("40Gi") },
		} {
			edited := &VMImage{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name}, edited)).To(Succeed())
			change(edited)

			err := k8sClient.Update(ctx, edited)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("source and minSystemDisk cannot be changed"))
		}

		// The display fields and deprecation stay editable, and a size written
		// another way is the same size, not an edit of it.
		edited := &VMImage{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name}, edited)).To(Succeed())
		edited.Spec.DisplayName = "Ubuntu 24.04 LTS Server"
		edited.Spec.Deprecated = true
		edited.Spec.MinSystemDisk = resource.MustParse("20480Mi")
		Expect(k8sClient.Update(ctx, edited)).To(Succeed())
	})
})
