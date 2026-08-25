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

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func ptrTo[T any](v T) *T { return &v }

func intstrPtr(v intstr.IntOrString) *intstr.IntOrString { return &v }

const (
	testModelArchitecture = "deepseek_v4"
	testQuantization      = "w8a8"
	testEndpointPortName  = "http"
	testRefNamespace      = "project-a"
	testRefServiceName    = "dsv4-flash-pd"
)

func validInferenceRuntimeProfile(name string) *InferenceRuntimeProfile {
	return &InferenceRuntimeProfile{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: InferenceRuntimeProfileSpec{
			Accelerator: Accelerator{
				Vendor: AcceleratorVendorMetax,
				Models: []string{"MXC500"},
			},
			Engine: Engine{
				Name:    "sglang",
				Version: "vendor-0.5.12-rc1",
			},
			ModelRequirements: ModelRequirements{
				Architectures: []string{testModelArchitecture},
				Quantization:  []string{testQuantization},
			},
			Vars: map[string]string{"prefillHca": "mlx5_0,mlx5_1"},
			Assets: []Asset{
				{
					Name:         "bootstrap",
					ConfigMapRef: AssetConfigMapRef{Name: "metax-c500-bootstrap-v0.5.12-rc1"},
					Mount:        &AssetMount{Path: "/opt/cubestack-bootstrap", Mode: 0755},
				},
				{
					Name:         "runtime-config",
					ConfigMapRef: AssetConfigMapRef{Name: "metax-dsv4-runtime-v0.5.12-rc1"},
					EnvFrom:      ptrTo(true),
				},
			},
			Overrides: []Override{
				{
					Name:        "prefillReplicas",
					Type:        OverrideTypeInteger,
					Min:         ptrTo(int64(1)),
					Max:         ptrTo(int64(8)),
					Default:     &apiextensionsv1.JSON{Raw: []byte("1")},
					Description: "prefill LWS array",
				},
				{
					Name: "groupSize",
					Type: OverrideTypeInteger,
					Enum: []apiextensionsv1.JSON{
						{Raw: []byte("1")}, {Raw: []byte("2")}, {Raw: []byte("4")},
					},
					Default: &apiextensionsv1.JSON{Raw: []byte("1")},
				},
			},
			Roles: []Role{
				{
					Name:      "router",
					DependsOn: []string{"prefill", "decode"},
					Workload: Workload{
						Kind:     WorkloadKindDeployment,
						Replicas: intstrPtr(intstr.FromInt(1)),
					},
					PodTemplate: PodTemplate{Image: "registry.local/router:v1"},
					Service: &RoleService{
						Ports: []ServicePort{
							{Name: testEndpointPortName, Port: 8001, TargetPort: intstrPtr(intstr.FromString(testEndpointPortName))},
						},
					},
				},
				{
					Name: "prefill",
					Workload: Workload{
						Kind:     WorkloadKindLeaderWorkerSet,
						Replicas: intstrPtr(intstr.FromString("{{ overrides.prefillReplicas }}")),
						Group: &WorkloadGroup{
							Size:          intstr.FromString("{{ overrides.groupSize }}"),
							StartupPolicy: StartupPolicyLeaderCreated,
						},
					},
					PodTemplate: PodTemplate{
						Image: "registry.local/prefill:v1",
						Resources: &PodResources{
							GPUPerPod: ptrTo(int64(8)),
						},
						Mounts: []ModelMount{
							{Model: "main", At: "/workspace/model", ReadOnly: true},
						},
					},
					Service: &RoleService{
						Ports: []ServicePort{
							{Name: testEndpointPortName, Port: 30000, TargetPort: intstrPtr(intstr.FromString(testEndpointPortName))},
						},
					},
				},
				{
					Name: "decode",
					Workload: Workload{
						Kind:     WorkloadKindLeaderWorkerSet,
						Replicas: intstrPtr(intstr.FromString("{{ overrides.decodeReplicas }}")),
						Group: &WorkloadGroup{
							Size:          intstr.FromString("{{ overrides.groupSize }}"),
							StartupPolicy: StartupPolicyLeaderCreated,
						},
					},
					PodTemplate: PodTemplate{
						Image: "registry.local/decode:v1",
						Resources: &PodResources{
							GPUPerPod: ptrTo(int64(8)),
						},
						Mounts: []ModelMount{
							{Model: "main", At: "/workspace/model", ReadOnly: true},
						},
					},
					Service: &RoleService{
						Ports: []ServicePort{
							{Name: testEndpointPortName, Port: 30000, TargetPort: intstrPtr(intstr.FromString(testEndpointPortName))},
						},
					},
				},
			},
			Endpoint: EndpointSpec{
				Role:     "router",
				PortName: testEndpointPortName,
			},
			ReadinessPolicy: &ReadinessPolicy{RequireAllRoles: true},
		},
	}
}

var _ = Describe("InferenceRuntimeProfile", func() {
	Context("valid objects", func() {
		It("accepts a profile with template replicas and round-trips its spec", func() {
			irp := validInferenceRuntimeProfile("irp-template")

			Expect(k8sClient.Create(ctx, irp)).To(Succeed())

			got := &InferenceRuntimeProfile{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, got)).To(Succeed())
			Expect(got.Spec).To(Equal(irp.Spec))

			Expect(k8sClient.Delete(ctx, irp)).To(Succeed())
		})

		It("accepts a profile with integer replicas and group sizes", func() {
			irp := validInferenceRuntimeProfile("irp-integer")
			irp.Spec.Roles[1].Workload.Replicas = intstrPtr(intstr.FromInt(2))
			irp.Spec.Roles[1].Workload.Group.Size = intstr.FromInt(1)
			irp.Spec.Roles[2].Workload.Replicas = intstrPtr(intstr.FromInt(4))
			irp.Spec.Roles[2].Workload.Group.Size = intstr.FromInt(1)

			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			Expect(k8sClient.Delete(ctx, irp)).To(Succeed())
		})

		It("accepts a profile without assets, overrides or readinessPolicy", func() {
			irp := validInferenceRuntimeProfile("irp-minimal")
			irp.Spec.Assets = nil
			irp.Spec.Overrides = nil
			irp.Spec.ReadinessPolicy = nil

			Expect(k8sClient.Create(ctx, irp)).To(Succeed())
			Expect(k8sClient.Delete(ctx, irp)).To(Succeed())
		})

		//nolint:dupl // status subresource round-trip mirrors the ModelVersion test
		It("updates status through the status subresource", func() {
			irp := validInferenceRuntimeProfile("irp-status")
			Expect(k8sClient.Create(ctx, irp)).To(Succeed())

			irp.Status.UsedBy = []ObjectRef{{Namespace: testRefNamespace, Name: testRefServiceName}}
			irp.Status.Conditions = []metav1.Condition{{
				Type:               "AssetsResolved",
				Status:             metav1.ConditionTrue,
				Reason:             "AssetsFound",
				Message:            "all assets resolved",
				LastTransitionTime: metav1.Now(),
			}}
			Expect(k8sClient.Status().Update(ctx, irp)).To(Succeed())

			got := &InferenceRuntimeProfile{}
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: irp.Name}, got)).To(Succeed())
			Expect(got.Status.UsedBy).To(Equal([]ObjectRef{{Namespace: testRefNamespace, Name: testRefServiceName}}))
			Expect(got.Status.Conditions).To(HaveLen(1))
			Expect(got.Status.Conditions[0].Type).To(Equal("AssetsResolved"))

			Expect(k8sClient.Delete(ctx, irp)).To(Succeed())
		})
	})

	Context("L0 validation", func() {
		DescribeTable("rejects invalid objects",
			func(name string, mutate func(*InferenceRuntimeProfileSpec), wantMessage string) {
				irp := validInferenceRuntimeProfile(name)
				mutate(&irp.Spec)

				err := k8sClient.Create(ctx, irp)
				Expect(err).To(HaveOccurred())
				Expect(apierrors.IsInvalid(err)).To(BeTrue(), "expected Invalid error, got: %v", err)
				if wantMessage != "" {
					Expect(err.Error()).To(ContainSubstring(wantMessage))
				}
			},
			Entry("missing accelerator.vendor",
				"irp-invalid-missing-vendor",
				func(s *InferenceRuntimeProfileSpec) { s.Accelerator.Vendor = "" },
				"spec.accelerator.vendor"),
			Entry("unsupported accelerator.vendor",
				"irp-invalid-vendor",
				func(s *InferenceRuntimeProfileSpec) { s.Accelerator.Vendor = "amd" },
				"Unsupported value"),
			Entry("empty accelerator.models",
				"irp-invalid-empty-models",
				func(s *InferenceRuntimeProfileSpec) { s.Accelerator.Models = []string{} },
				"spec.accelerator.models"),
			Entry("missing engine.name",
				"irp-invalid-missing-engine-name",
				func(s *InferenceRuntimeProfileSpec) { s.Engine.Name = "" },
				"spec.engine.name"),
			Entry("missing engine.version",
				"irp-invalid-missing-engine-version",
				func(s *InferenceRuntimeProfileSpec) { s.Engine.Version = "" },
				"spec.engine.version"),
			Entry("empty modelRequirements.architectures",
				"irp-invalid-empty-architectures",
				func(s *InferenceRuntimeProfileSpec) { s.ModelRequirements.Architectures = []string{} },
				"spec.modelRequirements.architectures"),
			Entry("empty modelRequirements.quantization",
				"irp-invalid-empty-quantization",
				func(s *InferenceRuntimeProfileSpec) { s.ModelRequirements.Quantization = []string{} },
				"spec.modelRequirements.quantization"),
			Entry("empty roles",
				"irp-invalid-empty-roles",
				func(s *InferenceRuntimeProfileSpec) { s.Roles = []Role{} },
				"spec.roles"),
			Entry("role missing workload.kind",
				"irp-invalid-missing-kind",
				func(s *InferenceRuntimeProfileSpec) { s.Roles[0].Workload.Kind = "" },
				"spec.roles[0].workload.kind"),
			Entry("unsupported workload.kind",
				"irp-invalid-kind",
				func(s *InferenceRuntimeProfileSpec) { s.Roles[0].Workload.Kind = "StatefulSet" },
				"Unsupported value"),
			Entry("group missing startupPolicy",
				"irp-invalid-missing-startup-policy",
				func(s *InferenceRuntimeProfileSpec) { s.Roles[1].Workload.Group.StartupPolicy = "" },
				"spec.roles[1].workload.group.startupPolicy"),
			Entry("unsupported startupPolicy",
				"irp-invalid-startup-policy",
				func(s *InferenceRuntimeProfileSpec) { s.Roles[1].Workload.Group.StartupPolicy = "WorkerCreated" },
				"Unsupported value"),
			Entry("missing role name",
				"irp-invalid-missing-role-name",
				func(s *InferenceRuntimeProfileSpec) { s.Roles[0].Name = "" },
				"spec.roles[0].name"),
			Entry("missing podTemplate.image",
				"irp-invalid-missing-image",
				func(s *InferenceRuntimeProfileSpec) { s.Roles[0].PodTemplate.Image = "" },
				"spec.roles[0].podTemplate.image"),
			Entry("missing endpoint.role",
				"irp-invalid-missing-endpoint-role",
				func(s *InferenceRuntimeProfileSpec) { s.Endpoint.Role = "" },
				"spec.endpoint.role"),
			Entry("readinessPolicy.requireAllRoles false",
				"irp-invalid-require-all-roles",
				func(s *InferenceRuntimeProfileSpec) { s.ReadinessPolicy.RequireAllRoles = false },
				"requireAllRoles is fixed to true"),
			Entry("unsupported override type",
				"irp-invalid-override-type",
				func(s *InferenceRuntimeProfileSpec) { s.Overrides[0].Type = "float" },
				"Unsupported value"),
			Entry("asset without mount or envFrom",
				"irp-invalid-asset-no-form",
				func(s *InferenceRuntimeProfileSpec) { s.Assets[0].Mount = nil },
				"exactly one of mount or envFrom"),
			Entry("asset with both mount and envFrom",
				"irp-invalid-asset-both-forms",
				func(s *InferenceRuntimeProfileSpec) { s.Assets[0].EnvFrom = ptrTo(true) },
				"exactly one of mount or envFrom"),
			Entry("asset missing configMapRef.name",
				"irp-invalid-asset-no-cm",
				func(s *InferenceRuntimeProfileSpec) { s.Assets[0].ConfigMapRef.Name = "" },
				"spec.assets[0].configMapRef.name"),
			Entry("asset mount with relative path",
				"irp-invalid-asset-relative-path",
				func(s *InferenceRuntimeProfileSpec) { s.Assets[0].Mount.Path = "opt/cubestack-bootstrap" },
				"spec.assets[0].mount.path"),
			Entry("env without value or fieldRef",
				"irp-invalid-env-no-value",
				func(s *InferenceRuntimeProfileSpec) {
					s.Roles[1].PodTemplate.Env = []EnvVar{{Name: "RANK"}}
				},
				"exactly one of value or fieldRef"),
			Entry("env with both value and fieldRef",
				"irp-invalid-env-both-values",
				func(s *InferenceRuntimeProfileSpec) {
					s.Roles[1].PodTemplate.Env = []EnvVar{{
						Name:  "RANK",
						Value: ptrTo("0"),
						FieldRef: &ObjectFieldSelector{
							FieldPath: "status.hostIP",
						},
					}}
				},
				"exactly one of value or fieldRef"),
			Entry("mount with model other than main",
				"irp-invalid-mount-model",
				func(s *InferenceRuntimeProfileSpec) { s.Roles[1].PodTemplate.Mounts[0].Model = "aux" },
				"Unsupported value"),
			Entry("mount with readOnly false",
				"irp-invalid-mount-readonly",
				func(s *InferenceRuntimeProfileSpec) { s.Roles[1].PodTemplate.Mounts[0].ReadOnly = false },
				"model must be 'main' and readOnly must be true"),
			Entry("mount with relative at",
				"irp-invalid-mount-relative-path",
				func(s *InferenceRuntimeProfileSpec) { s.Roles[1].PodTemplate.Mounts[0].At = "workspace/model" },
				"spec.roles[1].podTemplate.mounts[0].at"),
			Entry("volume without emptyDir or hostPath",
				"irp-invalid-volume-no-source",
				func(s *InferenceRuntimeProfileSpec) {
					s.Roles[1].PodTemplate.Volumes = []Volume{{Name: "shm"}}
				},
				"exactly one of emptyDir or hostPath"),
			Entry("volume with both emptyDir and hostPath",
				"irp-invalid-volume-both-sources",
				func(s *InferenceRuntimeProfileSpec) {
					s.Roles[1].PodTemplate.Volumes = []Volume{{
						Name:     "shm",
						EmptyDir: &EmptyDirVolume{},
						HostPath: &HostPathVolume{Path: "/dev/infiniband"},
					}}
				},
				"exactly one of emptyDir or hostPath"),
			Entry("probe without httpGet or tcpSocket",
				"irp-invalid-probe-no-action",
				func(s *InferenceRuntimeProfileSpec) {
					s.Roles[1].PodTemplate.Probes = &Probes{Readiness: &Probe{FailureThreshold: ptrTo(int32(3))}}
				},
				"exactly one of httpGet or tcpSocket"),
			Entry("service port missing name",
				"irp-invalid-port-name",
				func(s *InferenceRuntimeProfileSpec) { s.Roles[0].Service.Ports[0].Name = "" },
				"spec.roles[0].service.ports[0].name"),
			Entry("service port out of range",
				"irp-invalid-port-range",
				func(s *InferenceRuntimeProfileSpec) { s.Roles[0].Service.Ports[0].Port = 70000 },
				"spec.roles[0].service.ports[0].port"),
		)
	})
})
