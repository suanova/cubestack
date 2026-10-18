package renderer

import (
	"maps"
	"strconv"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

const (
	overridePrefillReplicas  = "prefillReplicas"
	overrideReplicaPlacement = "replicaPlacement"
	overrideNodeSelector     = "nodeSelector"
	bootstrapAsset           = "bootstrap"
	// nodePoolLabel and nodePoolValue are the node-pool label pair the
	// nodeSelector table entries pin a service to.
	nodePoolLabel = "node-pool"
	nodePoolValue = "inference"
	// assetDataKey is the single asset data key of the render specs.
	assetDataKey = "key"
	// assetDataValue is the single asset data value of the render specs.
	assetDataValue = "value"
)

const (
	metaxModelC500  = "MXC500"
	metaxModelC550  = "MXC550"
	nvidiaModelH200 = "H200"
	nvidiaModelH20  = "H20"
	// metaxModelC900 is a model outside the declared model lists of the specs.
	metaxModelC900 = "MXC900"
	hostnameLabel  = "kubernetes.io/hostname"
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
				{Name: overrideReplicaPlacement, Type: aiv1alpha1.OverrideTypeString, Default: &apiextensionsv1.JSON{Raw: []byte(`"preferred"`)}},
				{Name: overrideNodeSelector, Type: aiv1alpha1.OverrideTypeString, Default: &apiextensionsv1.JSON{Raw: []byte(`""`)}},
			},
			// The templated declaration the shipped bundles use, so the fixture
			// exercises a policy that comes from an override rather than a literal.
			PodAntiAffinity: &aiv1alpha1.PodAntiAffinity{Policy: "{{ overrides.replicaPlacement }}", TopologyKey: hostnameLabel},
			// Likewise the shipped nodeSelector declaration, whose empty default
			// adds no selector to any role.
			NodeSelector: "{{ overrides.nodeSelector }}",
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
		res := Render(renderISVC(), renderProfile(), renderModel(), map[string]map[string]string{bootstrapAsset: {assetDataKey: assetDataValue}})
		Expect(res.Errors).To(BeEmpty())
		Expect(res.Overrides).To(Equal(map[string]string{overridePrefillReplicas: "3", overrideMode: "pd", overrideReplicaPlacement: "preferred", overrideNodeSelector: ""}))
		Expect(res.PodAntiAffinityPolicy).To(Equal("preferred"), "the profile default resolves through the templated declaration")

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

		Expect(res.Assets).To(Equal(map[string]map[string]string{bootstrapAsset: {assetDataKey: assetDataValue}}))
	})

	It("resolves a templated gpuPerPod to a concrete Int without mutating the input", func() {
		p := renderProfile()
		tpl := intstr.FromString("{{ overrides.prefillReplicas }}")
		p.Spec.Roles[1].PodTemplate.Resources = &aiv1alpha1.PodResources{GPUPerPod: &tpl}
		res := Render(renderISVC(), p, renderModel(), map[string]map[string]string{bootstrapAsset: {assetDataKey: assetDataValue}})
		Expect(res.Errors).To(BeEmpty())
		// prefillReplicas resolves to "3" in renderISVC.
		Expect(res.Roles[1].PodTemplate.Resources.GPUPerPod.Type).To(Equal(intstr.Int))
		Expect(res.Roles[1].PodTemplate.Resources.GPUPerPod.IntValue()).To(Equal(3))
		// The input profile is not mutated: its template stays a string.
		Expect(p.Spec.Roles[1].PodTemplate.Resources.GPUPerPod.Type).To(Equal(intstr.String))
	})

	It("rejects a templated gpuPerPod that does not resolve to a positive integer", func() {
		p := renderProfile()
		// mode resolves to "pd" (a string), which is not a positive integer.
		tpl := intstr.FromString("{{ overrides.mode }}")
		p.Spec.Roles[1].PodTemplate.Resources = &aiv1alpha1.PodResources{GPUPerPod: &tpl}
		res := Render(renderISVC(), p, renderModel(), map[string]map[string]string{bootstrapAsset: {assetDataKey: assetDataValue}})
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Reason).To(Equal(ReasonInvalidOverride))
	})

	// gpuPrefill marks the prefill role as the GPU role of the fixture profile.
	gpuPrefill := func(p *aiv1alpha1.InferenceRuntimeProfile) {
		p.Spec.Roles[1].PodTemplate.Resources = &aiv1alpha1.PodResources{GPUPerPod: ptrTo(intstr.FromInt32(8))}
	}

	It("injects a single accelerator model as a nodeSelector on the GPU role only", func() {
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		Expect(res.Roles[0].PodTemplate.NodeSelector).To(BeEmpty(), "the CPU-only router role is not constrained to GPU nodes")
		Expect(res.Roles[1].PodTemplate.NodeSelector).To(HaveKeyWithValue(metaxProductLabel, metaxModelC500))
		Expect(res.Roles[1].ModelNodeAffinity).To(BeNil())
	})

	It("injects several accelerator models as a required nodeAffinity term on the GPU role only", func() {
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500, metaxModelC550}}
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		Expect(res.Roles[0].ModelNodeAffinity).To(BeNil())
		Expect(res.Roles[1].PodTemplate.NodeSelector).To(BeEmpty())
		Expect(res.Roles[1].ModelNodeAffinity).NotTo(BeNil())
		Expect(res.Roles[1].ModelNodeAffinity.Label).To(Equal(metaxProductLabel))
		Expect(res.Roles[1].ModelNodeAffinity.Models).To(Equal([]string{metaxModelC500, metaxModelC550}))
	})

	It("reports a nodeSelector that pins the vendor label to a model outside the declared models", func() {
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
		p.Spec.Roles[1].PodTemplate.NodeSelector = map[string]string{metaxProductLabel: metaxModelC900}
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(HaveLen(1))
		Expect(string(res.Errors[0].Reason)).To(Equal("ModelSchedulingConflict"))
		Expect(res.Errors[0].Msg).To(ContainSubstring("contradicts"))
		// The contradictory role is not mutated into an unsatisfiable merge.
		Expect(res.Roles[1].PodTemplate.NodeSelector).To(Equal(map[string]string{metaxProductLabel: metaxModelC900}))
	})

	It("accepts an identical nodeSelector pin and merges the selector", func() {
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorNvidia, Models: []string{nvidiaModelH200}}
		p.Spec.Roles[1].PodTemplate.NodeSelector = map[string]string{nvidiaProductLabel: nvidiaModelH200, "pool": "gpu"}
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		Expect(res.Roles[1].PodTemplate.NodeSelector).To(Equal(map[string]string{nvidiaProductLabel: nvidiaModelH200, "pool": "gpu"}))
	})

	It("reports a multi-model pin outside the declared models", func() {
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500, metaxModelC550}}
		p.Spec.Roles[1].PodTemplate.NodeSelector = map[string]string{metaxProductLabel: metaxModelC500}
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		// MXC500 is among the declared models: the pin is consistent.
		p.Spec.Roles[1].PodTemplate.NodeSelector = map[string]string{metaxProductLabel: "C500"}
		res = Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(HaveLen(1))
		Expect(string(res.Errors[0].Reason)).To(Equal("ModelSchedulingConflict"))
	})

	It("ignores the vendor label pin on a CPU-only role", func() {
		// A role without gpuPerPod runs anywhere and is never constrained to
		// GPU-model nodes (design §3.2: the constraint guards model placement).
		p := renderProfile()
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
		p.Spec.Roles[0].PodTemplate.NodeSelector = map[string]string{metaxProductLabel: metaxModelC900}
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		Expect(res.Roles[0].PodTemplate.NodeSelector).To(Equal(map[string]string{metaxProductLabel: metaxModelC900}))
	})

	It("lets a GPU role override the profile accelerator with a different vendor", func() {
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
		p.Spec.Roles[1].Accelerator = &aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorNvidia, Models: []string{nvidiaModelH200}}
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		// The role's own declaration replaces the profile-level one wholesale:
		// the label the profile would inject must not appear on this role.
		Expect(res.Roles[1].PodTemplate.NodeSelector).To(HaveKeyWithValue(nvidiaProductLabel, nvidiaModelH200))
		Expect(res.Roles[1].PodTemplate.NodeSelector).NotTo(HaveKey(metaxProductLabel))
		Expect(res.Roles[1].ModelNodeAffinity).To(BeNil())
	})

	It("uses the role-level models for the multi-model nodeAffinity", func() {
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
		p.Spec.Roles[1].Accelerator = &aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorNvidia, Models: []string{nvidiaModelH200, nvidiaModelH20}}
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		Expect(res.Roles[1].PodTemplate.NodeSelector).To(BeEmpty())
		Expect(res.Roles[1].ModelNodeAffinity).NotTo(BeNil())
		Expect(res.Roles[1].ModelNodeAffinity.Label).To(Equal(nvidiaProductLabel))
		Expect(res.Roles[1].ModelNodeAffinity.Models).To(Equal([]string{nvidiaModelH200, nvidiaModelH20}))
	})

	It("judges the nodeSelector conflict against the role's own models", func() {
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
		p.Spec.Roles[1].Accelerator = &aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorNvidia, Models: []string{nvidiaModelH200}}
		// A pin equal to the role's own model is consistent…
		p.Spec.Roles[1].PodTemplate.NodeSelector = map[string]string{nvidiaProductLabel: nvidiaModelH200}
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		// …and one outside the role's models is the reported conflict, even
		// though it is inside the profile-level models.
		p.Spec.Roles[1].PodTemplate.NodeSelector = map[string]string{nvidiaProductLabel: metaxModelC500}
		res = Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(HaveLen(1))
		Expect(string(res.Errors[0].Reason)).To(Equal("ModelSchedulingConflict"))
	})

	It("injects nothing for a CPU-only role's accelerator declaration", func() {
		// L1 rejects this shape at admission; the renderer must still not
		// constrain a role without gpuPerPod (defense for legacy objects).
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
		p.Spec.Roles[0].Accelerator = &aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorNvidia, Models: []string{nvidiaModelH200}}
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		Expect(res.Roles[0].PodTemplate.NodeSelector).To(BeEmpty())
		Expect(res.Roles[0].ModelNodeAffinity).To(BeNil())
		// The GPU role still gets the profile-level constraint.
		Expect(res.Roles[1].PodTemplate.NodeSelector).To(HaveKeyWithValue(metaxProductLabel, metaxModelC500))
	})

	It("defaults replicas to 1 when unset", func() {
		p := renderProfile()
		p.Spec.Roles[0].Workload.Replicas = nil
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		Expect(res.Roles[0].Replicas).To(Equal(int64(1)))
	})

	// userPlacement sets the user's value for the replicaPlacement override.
	userPlacement := func(v string) func(*aiv1alpha1.InferenceRuntimeProfile, *aiv1alpha1.InferenceService) {
		return func(_ *aiv1alpha1.InferenceRuntimeProfile, isvc *aiv1alpha1.InferenceService) {
			isvc.Spec.Overrides[overrideReplicaPlacement] = apiextensionsv1.JSON{Raw: []byte(strconv.Quote(v))}
		}
	}
	// dropUserPlacement unsets it, so the profile's default applies.
	dropUserPlacement := func(_ *aiv1alpha1.InferenceRuntimeProfile, isvc *aiv1alpha1.InferenceService) {
		delete(isvc.Spec.Overrides, overrideReplicaPlacement)
	}
	// policyTemplate writes a raw policy template in place of the fixture's.
	policyTemplate := func(tmpl string) func(*aiv1alpha1.InferenceRuntimeProfile, *aiv1alpha1.InferenceService) {
		return func(p *aiv1alpha1.InferenceRuntimeProfile, _ *aiv1alpha1.InferenceService) {
			p.Spec.PodAntiAffinity.Policy = aiv1alpha1.PodAntiAffinityPolicy(tmpl)
		}
	}

	// noError is the wantReason of the entries that render without an error.
	noError := ErrorReason("")

	DescribeTable("resolves the podAntiAffinity policy",
		func(mutate func(*aiv1alpha1.InferenceRuntimeProfile, *aiv1alpha1.InferenceService), wantPolicy string, wantReason ErrorReason) {
			p := renderProfile()
			isvc := renderISVC()
			mutate(p, isvc)
			res := Render(isvc, p, renderModel(), nil)
			if wantReason == noError {
				Expect(res.Errors).To(BeEmpty())
				Expect(res.PodAntiAffinityPolicy).To(Equal(wantPolicy))
				return
			}
			Expect(res.Errors).To(HaveLen(1))
			Expect(res.Errors[0].Reason).To(Equal(wantReason))
			Expect(res.PodAntiAffinityPolicy).To(BeEmpty(), "a policy that does not resolve is no policy, never a half-resolved one")
		},
		Entry("the user's value wins over the default", userPlacement("preferred"), "preferred", noError),
		Entry("required", userPlacement("required"), "required", noError),
		Entry("none", userPlacement("none"), "none", noError),
		Entry("the profile default applies when the user sets nothing", dropUserPlacement, "preferred", noError),
		Entry("an undeclared policy is required, as it was before the field existed", policyTemplate(""), "required", noError),
		Entry("a literal policy needs no override", policyTemplate("preferred"), "preferred", noError),
		Entry("surrounding whitespace is tolerated", policyTemplate("required\n"), "required", noError),
		Entry("a token outside the three policies is rejected", policyTemplate("{{ overrides.mode }}"), "", ReasonInvalidOverride),
		Entry("an undeclared override is rejected", policyTemplate("{{ overrides.undeclared }}"), "", ReasonUnknownPlaceholder),
		Entry("a namespace outside overrides is rejected", policyTemplate("{{ service.name }}"), "", ReasonPhaseViolation),
	)

	It("reports no policy when the profile declares no podAntiAffinity", func() {
		p := renderProfile()
		p.Spec.PodAntiAffinity = nil
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		Expect(res.PodAntiAffinityPolicy).To(BeEmpty(), "the controller injects only what the profile declares")
	})

	// userNodeSelector sets the user's value for the nodeSelector override.
	userNodeSelector := func(v string) func(*aiv1alpha1.InferenceRuntimeProfile, *aiv1alpha1.InferenceService) {
		return func(_ *aiv1alpha1.InferenceRuntimeProfile, isvc *aiv1alpha1.InferenceService) {
			isvc.Spec.Overrides[overrideNodeSelector] = apiextensionsv1.JSON{Raw: []byte(strconv.Quote(v))}
		}
	}
	// dropUserNodeSelector unsets it, so the profile's empty default applies.
	dropUserNodeSelector := func(_ *aiv1alpha1.InferenceRuntimeProfile, isvc *aiv1alpha1.InferenceService) {
		delete(isvc.Spec.Overrides, overrideNodeSelector)
	}
	// nodeSelectorTemplate writes a raw template in place of the fixture's.
	nodeSelectorTemplate := func(tmpl string) func(*aiv1alpha1.InferenceRuntimeProfile, *aiv1alpha1.InferenceService) {
		return func(p *aiv1alpha1.InferenceRuntimeProfile, _ *aiv1alpha1.InferenceService) {
			p.Spec.NodeSelector = tmpl
		}
	}

	// The GPU role carries the model pin as well, so each entry states the two
	// selectors apart: what the pair adds, and what the accelerator declaration
	// adds on top of it.
	DescribeTable("merges the service-level node selector",
		func(mutate func(*aiv1alpha1.InferenceRuntimeProfile, *aiv1alpha1.InferenceService), want map[string]string, wantReason ErrorReason) {
			p := renderProfile()
			isvc := renderISVC()
			gpuPrefill(p)
			p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
			mutate(p, isvc)
			res := Render(isvc, p, renderModel(), nil)
			if wantReason != noError {
				Expect(res.Errors).To(HaveLen(1))
				Expect(res.Errors[0].Reason).To(Equal(wantReason))
				return
			}
			Expect(res.Errors).To(BeEmpty())
			router := map[string]string{}
			maps.Copy(router, want)
			gpu := map[string]string{metaxProductLabel: metaxModelC500}
			maps.Copy(gpu, want)
			// One selector covers the service: the CPU-only router is pinned to
			// the same nodes as the GPU roles.
			Expect(res.Roles[0].PodTemplate.NodeSelector).To(Equal(router))
			Expect(res.Roles[1].PodTemplate.NodeSelector).To(Equal(gpu))
		},
		Entry("the user's pair reaches every role", userNodeSelector("node-pool=inference"), map[string]string{nodePoolLabel: nodePoolValue}, noError),
		Entry("the empty default adds no selector", dropUserNodeSelector, nil, noError),
		Entry("an empty user value adds no selector", userNodeSelector(""), nil, noError),
		Entry("surrounding whitespace is tolerated", userNodeSelector(" node-pool=inference "), map[string]string{nodePoolLabel: nodePoolValue}, noError),
		Entry("a literal pair needs no override", nodeSelectorTemplate("node-pool=inference"), map[string]string{nodePoolLabel: nodePoolValue}, noError),
		Entry("a pair repeating the model pin is consistent", userNodeSelector(metaxProductLabel+"="+metaxModelC500), map[string]string{metaxProductLabel: metaxModelC500}, noError),
		Entry("an empty literal adds no selector", nodeSelectorTemplate(""), nil, noError),
		Entry("a key without a value is rejected", userNodeSelector("node-pool"), nil, ReasonInvalidOverride),
		Entry("a missing value is rejected", userNodeSelector("node-pool="), nil, ReasonInvalidOverride),
		Entry("a missing key is rejected", userNodeSelector("=inference"), nil, ReasonInvalidOverride),
		Entry("a value that is not a label value is rejected", userNodeSelector("node-pool=in ference"), nil, ReasonInvalidOverride),
		Entry("a key that is not a label key is rejected", userNodeSelector("node pool=inference"), nil, ReasonInvalidOverride),
		Entry("an item without a value is rejected", userNodeSelector("node-pool=inference,gpu"), nil, ReasonInvalidOverride),
		Entry("a template resolving to a bare key is rejected", nodeSelectorTemplate("{{ overrides.mode }}"), nil, ReasonInvalidOverride),
		Entry("a namespace outside overrides is rejected", nodeSelectorTemplate("{{ service.name }}"), nil, ReasonPhaseViolation),
		Entry("an undeclared override is rejected", nodeSelectorTemplate("{{ overrides.undeclared }}"), nil, ReasonUnknownPlaceholder),
		Entry("a pair contradicting the declared model is reported", userNodeSelector(metaxProductLabel+"="+metaxModelC550), nil, ReasonModelSchedulingConflict),
	)

	// stringListNodeSelector declares the fixture's nodeSelector override as a
	// stringList and sets the user's value to the given JSON array.
	stringListNodeSelector := func(p *aiv1alpha1.InferenceRuntimeProfile, isvc *aiv1alpha1.InferenceService, value string) {
		for i := range p.Spec.Overrides {
			if p.Spec.Overrides[i].Name == overrideNodeSelector {
				p.Spec.Overrides[i].Type = aiv1alpha1.OverrideTypeStringList
				p.Spec.Overrides[i].Default = &apiextensionsv1.JSON{Raw: []byte(`[]`)}
			}
		}
		isvc.Spec.Overrides[overrideNodeSelector] = apiextensionsv1.JSON{Raw: []byte(value)}
	}

	It("renders a stringList nodeSelector as a required nodeAffinity In term", func() {
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
		isvc := renderISVC()
		stringListNodeSelector(p, isvc, `["kubernetes.io/hostname=worker-a","kubernetes.io/hostname=worker-b"]`)
		res := Render(isvc, p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		want := []NodeAffinityRequirement{{Label: hostnameLabel, Values: []string{"worker-a", "worker-b"}}}
		Expect(res.Roles[0].NodeAffinityRequirements).To(Equal(want))
		Expect(res.Roles[1].NodeAffinityRequirements).To(Equal(want))
		Expect(res.Roles[0].PodTemplate.NodeSelector).To(BeEmpty(), "several values cannot be a nodeSelector entry")
		Expect(res.Roles[1].PodTemplate.NodeSelector).To(Equal(map[string]string{metaxProductLabel: metaxModelC500}))
	})

	It("lets a role's stringList node selector win a shared key", func() {
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
		p.Spec.NodeSelector = "kubernetes.io/hostname=worker-a,kubernetes.io/hostname=worker-b"
		p.Spec.Roles[1].NodeSelector = "{{ overrides.nodeSelector }}"
		isvc := renderISVC()
		stringListNodeSelector(p, isvc, `["kubernetes.io/hostname=worker-c"]`)
		res := Render(isvc, p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		Expect(res.Roles[0].NodeAffinityRequirements).To(Equal([]NodeAffinityRequirement{{Label: hostnameLabel, Values: []string{"worker-a", "worker-b"}}}))
		Expect(res.Roles[0].PodTemplate.NodeSelector).To(BeEmpty())
		Expect(res.Roles[1].NodeAffinityRequirements).To(BeEmpty(), "the role replaces the key with a single value")
		Expect(res.Roles[1].PodTemplate.NodeSelector).To(Equal(map[string]string{hostnameLabel: "worker-c", metaxProductLabel: metaxModelC500}))
	})

	It("drops a podTemplate entry shadowed by a multi-value selection", func() {
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
		p.Spec.Roles[1].PodTemplate.NodeSelector = map[string]string{nodePoolLabel: "cpu"}
		isvc := renderISVC()
		stringListNodeSelector(p, isvc, `["node-pool=gpu-a","node-pool=gpu-b"]`)
		res := Render(isvc, p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		// The fixed equality would AND with the In term and match no node.
		Expect(res.Roles[1].PodTemplate.NodeSelector).To(Equal(map[string]string{metaxProductLabel: metaxModelC500}))
		Expect(res.Roles[1].NodeAffinityRequirements).To(Equal([]NodeAffinityRequirement{{Label: nodePoolLabel, Values: []string{"gpu-a", "gpu-b"}}}))
	})

	It("keeps the single-model pin when a multi-value selection covers the product label", func() {
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
		isvc := renderISVC()
		stringListNodeSelector(p, isvc, `["`+metaxProductLabel+`=`+metaxModelC500+`","`+metaxProductLabel+`=`+metaxModelC550+`"]`)
		res := Render(isvc, p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		// Dropping the pin would let the role land on the other selected model.
		Expect(res.Roles[1].PodTemplate.NodeSelector).To(Equal(map[string]string{metaxProductLabel: metaxModelC500}))
		Expect(res.Roles[1].NodeAffinityRequirements).To(Equal([]NodeAffinityRequirement{{Label: metaxProductLabel, Values: []string{metaxModelC500, metaxModelC550}}}))
	})

	It("reports a multi-value product-label selection that excludes every model", func() {
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
		isvc := renderISVC()
		stringListNodeSelector(p, isvc, `["`+metaxProductLabel+`=`+metaxModelC550+`","`+metaxProductLabel+`=`+metaxModelC900+`"]`)
		res := Render(isvc, p, renderModel(), nil)
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Reason).To(Equal(ReasonModelSchedulingConflict))
	})

	It("merges no selector when the profile declares no nodeSelector", func() {
		p := renderProfile()
		gpuPrefill(p)
		p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
		p.Spec.NodeSelector = ""
		isvc := renderISVC()
		isvc.Spec.Overrides[overrideNodeSelector] = apiextensionsv1.JSON{Raw: []byte(`"node-pool=inference"`)}
		res := Render(isvc, p, renderModel(), nil)
		Expect(res.Errors).To(BeEmpty())
		Expect(res.Roles[0].PodTemplate.NodeSelector).To(BeEmpty(), "a profile that declares no nodeSelector merges nothing, whatever the user sets")
		Expect(res.Roles[1].PodTemplate.NodeSelector).To(Equal(map[string]string{metaxProductLabel: metaxModelC500}))
	})

	// The service-level selector is the fixture's templated pair, so every
	// entry states the role's own contribution against what the role would
	// carry without it: the service pair, plus the model pin on the GPU role.
	DescribeTable("merges a role's own node selector",
		func(rolePair string, wantPrefill map[string]string, wantReason ErrorReason) {
			p := renderProfile()
			gpuPrefill(p)
			p.Spec.Accelerator = aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{metaxModelC500}}
			p.Spec.NodeSelector = "node-pool=inference"
			p.Spec.Roles[1].NodeSelector = rolePair
			res := Render(renderISVC(), p, renderModel(), nil)
			if wantReason != noError {
				Expect(res.Errors).To(HaveLen(1))
				Expect(res.Errors[0].Reason).To(Equal(wantReason))
				return
			}
			Expect(res.Errors).To(BeEmpty())
			Expect(res.Roles[0].PodTemplate.NodeSelector).To(Equal(map[string]string{nodePoolLabel: nodePoolValue}), "a role's selector applies to that role alone")
			Expect(res.Roles[1].PodTemplate.NodeSelector).To(Equal(wantPrefill))
		},
		Entry("a role's pair merges with the service-level one", "gpu-pool=decode", map[string]string{nodePoolLabel: nodePoolValue, "gpu-pool": "decode", metaxProductLabel: metaxModelC500}, noError),
		Entry("a role's pair wins a shared key", "node-pool=decode", map[string]string{nodePoolLabel: "decode", metaxProductLabel: metaxModelC500}, noError),
		Entry("an empty role pair adds nothing", "", map[string]string{nodePoolLabel: nodePoolValue, metaxProductLabel: metaxModelC500}, noError),
		Entry("a role's pair repeating the model pin is consistent", metaxProductLabel+"="+metaxModelC500, map[string]string{nodePoolLabel: nodePoolValue, metaxProductLabel: metaxModelC500}, noError),
		Entry("a role's pair contradicting the declared model is reported", metaxProductLabel+"="+metaxModelC550, nil, ReasonModelSchedulingConflict),
		Entry("a role's bare key is rejected", "{{ overrides.mode }}", nil, ReasonInvalidOverride),
		Entry("a role's template outside overrides is rejected", "{{ service.name }}", nil, ReasonPhaseViolation),
	)

	It("names the role in a role-level node selector error", func() {
		p := renderProfile()
		p.Spec.Roles[1].NodeSelector = "{{ overrides.mode }}"
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Msg).To(ContainSubstring(`role "prefill" nodeSelector`))
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

	It("rejects replicas beyond the Kubernetes int32 range", func() {
		p := renderProfile()
		p.Spec.Roles[0].Workload.Replicas = ptrTo(intstr.FromString("2147483648"))
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Reason).To(Equal(ReasonInvalidOverride))
		Expect(res.Errors[0].Msg).To(ContainSubstring("int32"))
	})

	It("rejects a group size beyond the Kubernetes int32 range", func() {
		p := renderProfile()
		p.Spec.Roles[1].Workload.Group.Size = intstr.FromString("-2147483649")
		res := Render(renderISVC(), p, renderModel(), nil)
		Expect(res.Errors).To(HaveLen(1))
		Expect(res.Errors[0].Reason).To(Equal(ReasonInvalidOverride))
		Expect(res.Errors[0].Msg).To(ContainSubstring("int32"))
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

var _ = Describe("routeVars", func() {
	It("reports an unpublished route and the defaults when spec.route is unset", func() {
		vars := routeVars(nil)
		Expect(vars).To(HaveLen(4))
		Expect(vars).To(HaveKeyWithValue("publish", "false"))
		Expect(vars).To(HaveKeyWithValue("modelName", ""))
		Expect(vars).To(HaveKeyWithValue("timeoutSeconds", "0"))
		Expect(vars).To(HaveKeyWithValue("idleTimeoutSeconds", "300"))
	})

	It("defaults the timeouts of a route that declares none", func() {
		// 0 disables the total-duration cap; the idle cap keeps its 300s default.
		vars := routeVars(&aiv1alpha1.RouteSpec{Publish: true, ModelName: "flash"})
		Expect(vars).To(HaveLen(4))
		Expect(vars).To(HaveKeyWithValue("publish", "true"))
		Expect(vars).To(HaveKeyWithValue("modelName", "flash"))
		Expect(vars).To(HaveKeyWithValue("timeoutSeconds", "0"))
		Expect(vars).To(HaveKeyWithValue("idleTimeoutSeconds", "300"))
	})

	It("renders the declared route values", func() {
		route := &aiv1alpha1.RouteSpec{
			Publish:            true,
			ModelName:          "qwen38-27b",
			TimeoutSeconds:     ptrTo(int64(3600)),
			IdleTimeoutSeconds: ptrTo(int64(120)),
		}
		vars := routeVars(route)
		Expect(vars).To(HaveLen(4))
		Expect(vars).To(HaveKeyWithValue("publish", "true"))
		Expect(vars).To(HaveKeyWithValue("modelName", "qwen38-27b"))
		Expect(vars).To(HaveKeyWithValue("timeoutSeconds", "3600"))
		Expect(vars).To(HaveKeyWithValue("idleTimeoutSeconds", "120"))
	})
})
