package renderer

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

const (
	overridePrefillReplicas = "prefillReplicas"
	bootstrapAsset          = "bootstrap"
)

func envValue(name, value string) aiv1alpha1.EnvVar {
	return aiv1alpha1.EnvVar{Name: name, Value: &value}
}

func stringPtr(s string) *string { return &s }

func renderProfile() *aiv1alpha1.InferenceRuntimeProfile {
	return &aiv1alpha1.InferenceRuntimeProfile{
		Spec: aiv1alpha1.InferenceRuntimeProfileSpec{
			ModelRequirements: aiv1alpha1.ModelRequirements{Architectures: []string{"deepseek_v4"}, Quantization: []string{"w8a8"}},
			Vars:              map[string]string{"launcher": "sglang"},
			Assets: []aiv1alpha1.Asset{
				{Name: bootstrapAsset, ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: "cm-bootstrap"}, Mount: &aiv1alpha1.AssetMount{Path: "/opt/bootstrap", Mode: 0755}},
			},
			Overrides: []aiv1alpha1.Override{
				{Name: overridePrefillReplicas, Type: aiv1alpha1.OverrideTypeInteger, Default: &apiextensionsv1.JSON{Raw: []byte("1")}},
				{Name: overrideMode, Type: aiv1alpha1.OverrideTypeString, Default: &apiextensionsv1.JSON{Raw: []byte(`"pd"`)}},
			},
			Roles: []aiv1alpha1.Role{
				{
					Name:     "router",
					Workload: aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindDeployment, Replicas: ptrTo(intstr.FromString("{{ overrides.prefillReplicas }}"))},
					PodTemplate: aiv1alpha1.PodTemplate{
						Image: "registry.local/router:v1",
						Env: []aiv1alpha1.EnvVar{
							envValue("LAUNCHER", "{{ profile.vars.launcher }}"),
							envValue("MODEL_NAME", "{{ model.name }}"),
							envValue("SERVICE", "{{ service.name }}.{{ service.namespace }}"),
							envValue("PEER", "http://{{ roles.prefill.serviceName }}:30000"),
							envValue("PUBLISH", "{{ route.publish }}"),
							envValue("MODEL_PATH", "{{ model.path }}"),
						},
						Mounts: []aiv1alpha1.ModelMount{{Model: modelMain, At: "/workspace/model", ReadOnly: true}},
					},
				},
				{
					Name:     "prefill",
					Workload: aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindLeaderWorkerSet, Group: &aiv1alpha1.WorkloadGroup{Size: intstr.FromString("{{ overrides.prefillReplicas }}"), StartupPolicy: aiv1alpha1.StartupPolicyLeaderCreated}},
					PodTemplate: aiv1alpha1.PodTemplate{
						Image:  "registry.local/engine:v1",
						Env:    []aiv1alpha1.EnvVar{envValue("NNODES", "{{ role.group.size }}"), envValue("ROLE", "{{ role.name }}")},
						Mounts: []aiv1alpha1.ModelMount{{Model: modelMain, At: "/workspace/model", ReadOnly: true}},
					},
				},
			},
			Endpoint: aiv1alpha1.EndpointSpec{Role: "router"},
		},
	}
}

func renderISVC() *aiv1alpha1.InferenceService {
	return &aiv1alpha1.InferenceService{
		ObjectMeta: metav1.ObjectMeta{Name: "dsv4-flash-pd", Namespace: "project-a"},
		Spec: aiv1alpha1.InferenceServiceSpec{
			ModelRef:   "deepseek-v4-flash-w8a8-v1",
			ProfileRef: "metax-sglang-dsv4-pd",
			Overrides:  map[string]apiextensionsv1.JSON{overridePrefillReplicas: {Raw: []byte("3")}},
		},
	}
}

func renderModel() *aiv1alpha1.ModelVersion {
	return &aiv1alpha1.ModelVersion{
		Spec: aiv1alpha1.ModelVersionSpec{Model: "deepseek-v4-flash", Version: "w8a8-v1", Architecture: "deepseek_v4", Quantization: "w8a8"},
	}
}

var _ = Describe("Render", func() {
	It("renders all variable namespaces and resolves workload structure", func() {
		res := Render(renderISVC(), renderProfile(), renderModel(), map[string]map[string]string{bootstrapAsset: {"key": "value"}})
		Expect(res.Errors).To(BeEmpty())
		Expect(res.Overrides).To(Equal(map[string]string{overridePrefillReplicas: "3", overrideMode: "pd"}))

		Expect(res.Roles).To(HaveLen(2))
		router := res.Roles[0]
		Expect(router.Name).To(Equal("router"))
		Expect(router.Replicas).To(Equal(int64(3)))
		Expect(router.GroupSize).To(Equal(int64(0)))
		Expect(router.PodTemplate.Env[0].Value).To(Equal(stringPtr("sglang")))
		Expect(router.PodTemplate.Env[1].Value).To(Equal(stringPtr("deepseek-v4-flash")))
		Expect(router.PodTemplate.Env[2].Value).To(Equal(stringPtr("dsv4-flash-pd.project-a")))
		Expect(router.PodTemplate.Env[3].Value).To(Equal(stringPtr("http://dsv4-flash-pd-prefill:30000")))
		Expect(router.PodTemplate.Env[4].Value).To(Equal(stringPtr("false")))
		Expect(router.PodTemplate.Env[5].Value).To(Equal(stringPtr("/workspace/model")))

		prefill := res.Roles[1]
		Expect(prefill.GroupSize).To(Equal(int64(3)))
		Expect(prefill.PodTemplate.Env[0].Value).To(Equal(stringPtr("3")))
		Expect(prefill.PodTemplate.Env[1].Value).To(Equal(stringPtr("prefill")))

		Expect(res.Assets).To(Equal(map[string]map[string]string{bootstrapAsset: {"key": "value"}}))
	})

	It("defaults replicas to 1 when unset", func() {
		p := renderProfile()
		p.Spec.Roles[0].Workload.Replicas = nil
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		Expect(res.Roles[0].Replicas).To(Equal(int64(1)))
	})

	It("fails with UnknownPlaceholder for unknown variables", func() {
		p := renderProfile()
		p.Spec.Roles[0].PodTemplate.Env = append(p.Spec.Roles[0].PodTemplate.Env, envValue("BAD", "{{ bogus.x }}"))
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Reason).To(Equal(ReasonUnknownPlaceholder))
	})

	It("fails with PhaseViolation for role-level variables in asset data", func() {
		p := renderProfile()
		p.Spec.Assets[0].ConfigMapRef = aiv1alpha1.AssetConfigMapRef{Name: "cm-bootstrap"}
		res := Render(renderISVC(), p, renderModel(), map[string]map[string]string{bootstrapAsset: {"script": "{{ role.group.size }}"}})
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Reason).To(Equal(ReasonPhaseViolation))
	})

	It("reports asset errors in deterministic key order", func() {
		// The asset data map iterates in unspecified order; the rendered
		// condition reason is Errors[0], so rendering must sort the keys.
		res := Render(renderISVC(), renderProfile(), renderModel(), map[string]map[string]string{
			bootstrapAsset: {
				"z": "{{ overrides.undeclared }}",
				"a": "{{ role.group.size }}",
			},
		})
		Expect(res.Errors).To(HaveLen(2))
		Expect(res.Errors[0].Reason).To(Equal(ReasonPhaseViolation)) // key "a" renders first
		Expect(res.Errors[1].Reason).To(Equal(ReasonUnknownPlaceholder))
	})

	It("fails with PhaseViolation for non-override variables in workload structure", func() {
		p := renderProfile()
		p.Spec.Roles[0].Workload.Replicas = ptrTo(intstr.FromString("{{ model.name }}"))
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Reason).To(Equal(ReasonPhaseViolation))
	})

	It("fails with ModelNotMounted when a role references model.path without a mount", func() {
		p := renderProfile()
		p.Spec.Roles[0].PodTemplate.Mounts = nil
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Reason).To(Equal(ReasonModelNotMounted))
	})

	It("fails with InvalidOverride when replicas do not resolve to an integer", func() {
		p := renderProfile()
		p.Spec.Roles[0].Workload.Replicas = ptrTo(intstr.FromString("{{ overrides.mode }}"))
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Reason).To(Equal(ReasonInvalidOverride))
	})

	It("fails with UnknownPlaceholder for role.group.size in a Deployment role", func() {
		p := renderProfile()
		p.Spec.Roles[0].PodTemplate.Env = append(p.Spec.Roles[0].PodTemplate.Env, envValue("BAD", "{{ role.group.size }}"))
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Reason).To(Equal(ReasonUnknownPlaceholder))
	})

	It("does not mutate the input profile", func() {
		p := renderProfile()
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		Expect(p.Spec.Roles[0].PodTemplate.Env[0].Value).To(Equal(stringPtr("{{ profile.vars.launcher }}")))
		Expect(p.Spec.Roles[1].PodTemplate.Env[0].Value).To(Equal(stringPtr("{{ role.group.size }}")))
	})

	It("fails with UnknownPlaceholder for overrides variables with extra segments", func() {
		p := renderProfile()
		p.Spec.Roles[0].PodTemplate.Env = append(p.Spec.Roles[0].PodTemplate.Env, envValue("BAD", "{{ overrides.prefillReplicas.extra }}"))
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Reason).To(Equal(ReasonUnknownPlaceholder))
	})
})
