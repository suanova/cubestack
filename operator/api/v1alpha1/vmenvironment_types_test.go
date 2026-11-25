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
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const (
	testVMImage = "ubuntu-24.04"
	testVMData  = "scratch"
)

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

			Expect(k8sClient.Create(ctx, vme)).To(Succeed())

			got := &VMEnvironment{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: vme.Name, Namespace: vme.Namespace}, got)).To(Succeed())
			Expect(got.Spec).To(Equal(vme.Spec))

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
			Entry("unsupported rdmaType",
				"vme-invalid-rdmatype",
				func(s *VMEnvironmentSpec) {
					s.Network = &VMNetworkSpec{RDMAEnabled: true, RDMAType: RDMAType("infinibandx")}
				},
				"Unsupported value"),
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
	})
})

var _ = Describe("VMImage", func() {
	It("is cluster-scoped and round-trips its spec", func() {
		img := &VMImage{
			ObjectMeta: metav1.ObjectMeta{Name: "vmimage-ubuntu-24-04"},
			Spec: VMImageSpec{
				DisplayName:   "Ubuntu 24.04 LTS",
				OS:            "ubuntu",
				OSVersion:     "24.04",
				Architecture:  "amd64",
				MinSystemDisk: resource.MustParse("20Gi"),
				GuestAgent:    true,
				Source:        VMImageSource{Registry: "harbor.isuanova.com/suanova/ubuntu:24.04"},
			},
		}

		Expect(k8sClient.Create(ctx, img)).To(Succeed())

		got := &VMImage{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: img.Name}, got)).To(Succeed())
		Expect(got.Spec).To(Equal(img.Spec))

		got.Status.Phase = "Ready"
		got.Status.DataVolume = "vmimage-ubuntu-24-04-golden"
		Expect(k8sClient.Status().Update(ctx, got)).To(Succeed())

		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: img.Name}, got)).To(Succeed())
		Expect(got.Status.Phase).To(Equal("Ready"))
		Expect(got.Status.DataVolume).To(Equal("vmimage-ubuntu-24-04-golden"))

		Expect(k8sClient.Delete(ctx, got)).To(Succeed())
	})
})
