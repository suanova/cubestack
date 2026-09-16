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
	"path/filepath"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// irpVAPPath is the L1 ValidatingAdmissionPolicy manifest for
// InferenceRuntimeProfile, loaded from config/vap so the tests exercise the
// deployed artifact rather than a duplicate definition.
var irpVAPPath = filepath.Join("..", "..", "config", "vap", "inferenceruntimeprofile_policy.yaml")

// irpVAPProbeName is an InferenceRuntimeProfile whose name intentionally does
// not carry the <vendor>-<engine>- prefix, used to detect whether the IRP VAP
// is currently enforcing.
const irpVAPProbeName = "vap-probe-irp"

const (
	testPrefillReplicasName   = "prefillReplicas"
	testMaintenanceAnnotation = "maintenance"
	testAnnotationKey         = "note"
)

// probeIRPVAPRejects reports whether the InferenceRuntimeProfile VAP is
// currently enforcing: it creates an IRP with a name that violates the
// <vendor>-<engine>- prefix rule, which the VAP must reject. Returns false
// (and cleans up) while the VAP is not yet active or already removed, since
// VAP enforcement is registered asynchronously by the apiserver.
func probeIRPVAPRejects() bool {
	probe := validInferenceRuntimeProfile(irpVAPProbeName)
	err := k8sClient.Create(ctx, probe)
	if err == nil {
		Expect(k8sClient.Delete(ctx, probe)).To(Succeed())
		return false
	}
	if apierrors.IsAlreadyExists(err) {
		Expect(k8sClient.Delete(ctx, probe)).To(Succeed())
		return false
	}
	return true
}

// setupIRPVAP creates the InferenceRuntimeProfile VAP and its binding from the
// manifest, deleting any leftover from a previous run first, and waits until
// the VAP is actually enforced.
func setupIRPVAP() {
	objs, err := loadVAPObjects(irpVAPPath)
	Expect(err).NotTo(HaveOccurred())
	Expect(objs).To(HaveLen(2), "expected VAP and binding in %s", irpVAPPath)

	for _, obj := range objs {
		_ = k8sClient.Delete(ctx, obj)
	}
	for _, obj := range objs {
		Expect(k8sClient.Create(ctx, obj)).To(Succeed())
	}

	Eventually(probeIRPVAPRejects, "15s", "200ms").Should(BeTrue(), "InferenceRuntimeProfile VAP did not become enforcing")
}

// cleanupIRPVAP deletes the InferenceRuntimeProfile VAP and its binding and
// waits until enforcement stops, so the L0 tests (which use arbitrary object
// names) are unaffected regardless of spec order.
func cleanupIRPVAP() {
	objs, err := loadVAPObjects(irpVAPPath)
	Expect(err).NotTo(HaveOccurred())
	for _, obj := range objs {
		_ = k8sClient.Delete(ctx, obj)
	}

	Eventually(probeIRPVAPRejects, "15s", "200ms").Should(BeFalse(), "InferenceRuntimeProfile VAP is still enforcing after removal")
}

// validIRPWithMatchingName returns a valid InferenceRuntimeProfile whose name
// carries the <vendor>-<engine>- prefix required by the VAP.
func validIRPWithMatchingName() *InferenceRuntimeProfile {
	return validInferenceRuntimeProfile("metax-sglang-dsv4-pd")
}

var _ = Describe("InferenceRuntimeProfile L1 admission", func() {
	Context("name binding", func() {
		It("rejects an InferenceRuntimeProfile whose name does not start with <vendor>-<engine>-", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validInferenceRuntimeProfile("mismatched-name")
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("metadata.name must start with"))
		})

		It("accepts an InferenceRuntimeProfile whose name starts with <vendor>-<engine>-", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			Expect(k8sClient.Delete(ctx, irp)).To(Succeed())
		})
	})

	Context("spec immutability", func() {
		It("rejects updating spec", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			irp.Spec.Engine.Version = "vendor-0.6.0"
			err := k8sClient.Update(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("spec is immutable"))
		})

		It("allows updating annotations", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			irp.Annotations = map[string]string{testAnnotationKey: testMaintenanceAnnotation}
			Expect(k8sClient.Update(ctx, irp)).To(Succeed())
		})

		It("allows updating annotations on a pre-existing name-mismatched InferenceRuntimeProfile", func() {
			// The object is created before the VAP exists, simulating a
			// legacy object created under an older policy; the name binding
			// must not block metadata-only updates of it.
			irp := validInferenceRuntimeProfile("legacy-name")
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, irp) }()

			setupIRPVAP()
			defer cleanupIRPVAP()

			irp.Annotations = map[string]string{testAnnotationKey: testMaintenanceAnnotation}
			Expect(k8sClient.Update(ctx, irp)).To(Succeed())

			irp.Spec.Engine.Version = "vendor-0.6.0"
			err := k8sClient.Update(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("spec is immutable"))
		})

		It("allows deleting an InferenceRuntimeProfile", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			Expect(k8sClient.Delete(ctx, irp)).To(Succeed())
		})
	})

	Context("assets", func() {
		It("rejects duplicate asset names", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Assets = append(irp.Spec.Assets, Asset{
				Name:         "bootstrap",
				ConfigMapRef: AssetConfigMapRef{Name: "metax-c500-bootstrap-v0.5.12-rc1"},
				EnvFrom:      ptrTo(true),
			})
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("asset names must be unique"))
		})

		It("rejects an asset configMapRef name that is not versioned", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Assets[0].ConfigMapRef.Name = "metax-c500-bootstrap"
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("versioned name"))
		})
	})

	Context("overrides", func() {
		It("rejects duplicate override names", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Overrides = append(irp.Spec.Overrides, Override{
				Name: testPrefillReplicasName,
				Type: OverrideTypeInteger,
			})
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("override names must be unique"))
		})

		It("rejects an override combining enum with min", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Overrides = append(irp.Spec.Overrides, Override{
				Name: "conflicting",
				Type: OverrideTypeInteger,
				Enum: []apiextensionsv1.JSON{{Raw: []byte("1")}},
				Min:  ptrTo(int64(1)),
			})
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("enum must not be combined with min or max"))
		})

		It("rejects an override whose default is not in enum", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Overrides = append(irp.Spec.Overrides, Override{
				Name:    "out-of-range",
				Type:    OverrideTypeInteger,
				Enum:    []apiextensionsv1.JSON{{Raw: []byte("1")}, {Raw: []byte("2")}},
				Default: &apiextensionsv1.JSON{Raw: []byte("5")},
			})
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("default must be one of the enum values"))
		})
	})

	Context("roles", func() {
		It("rejects duplicate role names", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles = append(irp.Spec.Roles, irp.Spec.Roles[0])
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("role names must be unique"))
		})

		It("rejects a dependsOn reference to a nonexistent role", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[0].DependsOn = []string{"nonexistent"}
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("dependsOn must reference an existing role"))
		})
	})

	Context("workload", func() {
		It("rejects a LeaderWorkerSet role without group", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].Workload.Group = nil
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("workload.group"))
		})

		It("rejects a Deployment role with group", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[0].Workload.Group = &WorkloadGroup{
				Size:          intstr.FromInt(2),
				StartupPolicy: StartupPolicyLeaderCreated,
			}
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("workload.group"))
		})
	})

	Context("extendedResources", func() {
		It("rejects an extendedResources key colliding with the vendor GPU resource", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.Resources.ExtendedResources = map[string]int64{"metax-tech.com/gpu": 2}
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("must not collide with cpu, memory or vendor GPU resources"))
		})

		It("rejects an extendedResources key colliding with the other vendor's GPU resource", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.Resources.ExtendedResources = map[string]int64{"nvidia.com/gpu": 2}
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("must not collide with cpu, memory or vendor GPU resources"))
		})

		It("rejects an extendedResources key that is not domain-qualified", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.Resources.ExtendedResources = map[string]int64{"foo": 2}
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("must be domain-qualified extended resource names"))
		})

		It("rejects an extendedResources key with the reserved requests. prefix", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.Resources.ExtendedResources = map[string]int64{"requests.example.com/foo": 2}
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("must be domain-qualified extended resource names"))
		})

		It("accepts a domain-qualified extendedResources key while the VAP is enforcing", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.Resources.ExtendedResources = map[string]int64{"hpc.example.com/vendor_device": 1}
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			Expect(k8sClient.Delete(ctx, irp)).To(Succeed())
		})

		It("accepts an uppercase name part and a 63-byte name like Kubernetes does", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.Resources.ExtendedResources = map[string]int64{"rdma/HCA": 1, "example.com/" + strings.Repeat("a", 63): 1}
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			Expect(k8sClient.Delete(ctx, irp)).To(Succeed())
		})

		It("rejects an extendedResources name part longer than 63 bytes", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.Resources.ExtendedResources = map[string]int64{"example.com/" + strings.Repeat("a", 64): 1}
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("must be domain-qualified extended resource names"))
		})

		It("rejects an extendedResources key colliding with cpu", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.Resources.ExtendedResources = map[string]int64{"cpu": 2}
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("must not collide with cpu, memory or vendor GPU resources"))
		})

		It("rejects an extendedResources value below one", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.Resources.ExtendedResources = map[string]int64{testHCAResourceName: 0}
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("extendedResources values must be at least 1"))
		})

		It("accepts a legal extendedResources map while the VAP is enforcing", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.Resources.ExtendedResources = map[string]int64{testHCAResourceName: 2}
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			Expect(k8sClient.Delete(ctx, irp)).To(Succeed())
		})
	})

	Context("volumes", func() {
		It("rejects duplicate at mount paths within a role", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.Volumes = []Volume{
				{Name: "dshm-a", At: testShmMountPath, EmptyDir: &EmptyDirVolume{Medium: testMemoryMedium}},
				{Name: "dshm-b", At: testShmMountPath, EmptyDir: &EmptyDirVolume{Medium: testMemoryMedium}},
			}
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("must not declare duplicate at mount paths"))
		})

		It("accepts distinct at mount paths within a role while the VAP is enforcing", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.Volumes = []Volume{
				{Name: "dshm", At: testShmMountPath, EmptyDir: &EmptyDirVolume{Medium: testMemoryMedium, SizeLimit: ptrTo(resource.MustParse("8Gi"))}},
				{Name: "ib", At: testIBHostPath, HostPath: &HostPathVolume{Path: testIBHostPath}},
			}
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			Expect(k8sClient.Delete(ctx, irp)).To(Succeed())
		})

		It("rejects a volume at colliding with a model mount at", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			// Roles[1] mounts the model at testModelMountPath; a volume declaring
			// the same path would produce duplicate mountPaths in the pod.
			irp.Spec.Roles[1].PodTemplate.Volumes = []Volume{{
				Name: "overlay", At: testModelMountPath, HostPath: &HostPathVolume{Path: "/mnt/models"},
			}}
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("must not overlap at the same at mount path"))
		})
	})

	Context("endpoint", func() {
		It("rejects an endpoint role that does not exist", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Endpoint.Role = "nonexistent"
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("endpoint.role must reference a role that defines a service"))
		})

		It("rejects an endpoint role without a service", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].Service = nil
			irp.Spec.Endpoint.Role = testPrefillRole
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("endpoint.role must reference a role that defines a service"))
		})
	})

	Context("podTemplate", func() {
		It("rejects hostNetwork with a non-ClusterFirstWithHostNet dnsPolicy", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.HostNetwork = ptrTo(true)
			irp.Spec.Roles[1].PodTemplate.DNSPolicy = corev1.DNSClusterFirst
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("dnsPolicy must be ClusterFirstWithHostNet"))
		})

		It("rejects hostNetwork without dnsPolicy", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.HostNetwork = ptrTo(true)
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("dnsPolicy must be ClusterFirstWithHostNet"))
		})

		It("accepts hostNetwork with ClusterFirstWithHostNet dnsPolicy", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.HostNetwork = ptrTo(true)
			irp.Spec.Roles[1].PodTemplate.DNSPolicy = corev1.DNSClusterFirstWithHostNet
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			Expect(k8sClient.Delete(ctx, irp)).To(Succeed())
		})

		It("rejects labels with the ai.cubestack.io/ prefix", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.Labels = map[string]string{"ai.cubestack.io/accelerator-model": "MXC500"}
			err := k8sClient.Create(ctx, irp)
			Expect(err).To(HaveOccurred())
			Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
			Expect(err.Error()).To(ContainSubstring("must not use the ai.cubestack.io/ prefix"))
		})

		It("accepts labels without the ai.cubestack.io/ prefix", func() {
			setupIRPVAP()
			defer cleanupIRPVAP()

			irp := validIRPWithMatchingName()
			irp.Spec.Roles[1].PodTemplate.Labels = map[string]string{"app": testPrefillRole}
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			Expect(k8sClient.Delete(ctx, irp)).To(Succeed())
		})
	})
})
