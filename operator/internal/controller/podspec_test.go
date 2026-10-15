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

	"github.com/suanova/cubestack/internal/renderer"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

const (
	testEngineImage        = "registry.local/engine:v1"
	testModelPath          = "/workspace/model"
	testBootstrapMountPath = "/opt/bootstrap"
	testRuntimeConfig      = "runtime-config"

	testIBDevicePath = "/dev/infiniband"
	testShmMountPath = "/dev/shm"
	testMemoryMedium = "Memory"
	testShmVolName   = "dshm"
	testISVCName     = "svc-a"

	testGPUModelMXC500 = "MXC500"
	testGPUModelMXC550 = "MXC550"
	testGPUModelH200   = "H200"

	// The node labels the two device plugins write a model to, written out here
	// rather than read from vendorProductLabel: what these assertions are about
	// is the label being the plugin's own, and a mapping compared with itself
	// would prove nothing. goconst counts a package's literals across its test
	// files too, which is why they are named rather than repeated.
	testProductLabelNvidia = "nvidia.com/gpu.product"
	testProductLabelMetax  = "metax-tech.com/gpu.product"
)

// testExecProbeCommand is the command line of the exec-probe specs: the
// renderer only copies it into the container, it never runs here.
var testExecProbeCommand = []string{"/bin/bash", "-c", "curl -sf http://127.0.0.1:8000/health"}

var _ = Describe("buildPodSpec", func() {
	modelHostPath := func() *aiv1alpha1.ModelVersion {
		return &aiv1alpha1.ModelVersion{Spec: aiv1alpha1.ModelVersionSpec{
			Model: "m", Version: "v1",
			Storage: aiv1alpha1.ModelStorage{
				Strategy: aiv1alpha1.StorageStrategyHostPath,
				HostPath: &aiv1alpha1.HostPathStorage{Path: "/models/m"},
			},
		}}
	}

	It("maps cpu and memory to requests and gpuPerPod to the vendor resource in requests and limits", func() {
		pt := aiv1alpha1.PodTemplate{
			Image: testEngineImage,
			Resources: &aiv1alpha1.PodResources{
				CPU:       ptrTo(resource.MustParse("8")),
				Memory:    ptrTo(resource.MustParse("64Gi")),
				GPUPerPod: ptrTo(intstr.FromInt32(2)),
			},
		}
		spec := buildPodSpec(pt, "svc", modelHostPath(), aiv1alpha1.AcceleratorVendorMetax)
		c := spec.Containers[0]
		Expect(c.Resources.Requests.Cpu().String()).To(Equal("8"))
		Expect(c.Resources.Requests.Memory().String()).To(Equal("64Gi"))
		Expect(c.Resources.Requests.Name("metax-tech.com/gpu", resource.DecimalSI).String()).To(Equal("2"))
		Expect(c.Resources.Limits.Name("metax-tech.com/gpu", resource.DecimalSI).String()).To(Equal("2"))
	})

	It("maps nvidia vendor to nvidia.com/gpu", func() {
		pt := aiv1alpha1.PodTemplate{
			Image:     testEngineImage,
			Resources: &aiv1alpha1.PodResources{GPUPerPod: ptrTo(intstr.FromInt32(1))},
		}
		spec := buildPodSpec(pt, "svc", modelHostPath(), aiv1alpha1.AcceleratorVendorNvidia)
		c := spec.Containers[0]
		Expect(c.Resources.Requests.Name("nvidia.com/gpu", resource.DecimalSI).String()).To(Equal("1"))
		Expect(c.Resources.Limits.Name("nvidia.com/gpu", resource.DecimalSI).String()).To(Equal("1"))
	})

	It("renders an exec readiness probe", func() {
		pt := aiv1alpha1.PodTemplate{
			Image: testEngineImage,
			Probes: &aiv1alpha1.Probes{Readiness: &aiv1alpha1.Probe{
				Exec:             &aiv1alpha1.ExecAction{Command: testExecProbeCommand},
				PeriodSeconds:    ptrTo(int32(10)),
				FailureThreshold: ptrTo(int32(30)),
			}},
		}
		spec := buildPodSpec(pt, "svc", modelHostPath(), aiv1alpha1.AcceleratorVendorMetax)
		c := spec.Containers[0]
		Expect(c.ReadinessProbe.Exec).To(Equal(&corev1.ExecAction{Command: testExecProbeCommand}))
		Expect(c.ReadinessProbe.PeriodSeconds).To(Equal(int32(10)))
		Expect(c.ReadinessProbe.FailureThreshold).To(Equal(int32(30)))
	})

	// hostnameTerm is the term every policy derives from this topologyKey; what
	// the policy selects is only where the term is written.
	hostnameTerm := corev1.PodAffinityTerm{
		LabelSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"ai.cubestack.io/inference-service": testISVCName}},
		TopologyKey:   "kubernetes.io/hostname",
	}

	DescribeTable("attaches the service-wide podAntiAffinity term the policy selects",
		func(policy aiv1alpha1.PodAntiAffinityPolicy, wantRequired []corev1.PodAffinityTerm, wantPreferred []corev1.WeightedPodAffinityTerm) {
			spec := &corev1.PodSpec{}
			attachServiceAntiAffinity(spec, testISVCName, "kubernetes.io/hostname", policy)
			Expect(spec.Affinity.PodAntiAffinity.RequiredDuringSchedulingIgnoredDuringExecution).To(Equal(wantRequired))
			Expect(spec.Affinity.PodAntiAffinity.PreferredDuringSchedulingIgnoredDuringExecution).To(Equal(wantPreferred))
		},
		Entry("required writes the hard term", aiv1alpha1.PodAntiAffinityPolicyRequired,
			[]corev1.PodAffinityTerm{hostnameTerm}, nil),
		Entry("an unset policy is required, as it was before the policy existed", aiv1alpha1.PodAntiAffinityPolicy(""),
			[]corev1.PodAffinityTerm{hostnameTerm}, nil),
		Entry("preferred writes the same term at the maximum scheduler weight", aiv1alpha1.PodAntiAffinityPolicyPreferred,
			nil, []corev1.WeightedPodAffinityTerm{{Weight: antiAffinityPreferredWeight, PodAffinityTerm: hostnameTerm}}),
	)

	It("injects no anti-affinity at all when the policy is none", func() {
		// Not merely an empty term list: none must not allocate Affinity either,
		// so the pod spec stays equal to one written without any anti-affinity.
		spec := &corev1.PodSpec{}
		attachServiceAntiAffinity(spec, testISVCName, "kubernetes.io/hostname", aiv1alpha1.PodAntiAffinityPolicyNone)
		Expect(spec.Affinity).To(BeNil())
	})

	It("keeps a role's model node affinity when the policy is none", func() {
		// A multi-model role carries a nodeAffinity of its own; that constraint is
		// independent of the service-wide spread and has to survive.
		modelAffinity := &corev1.NodeAffinity{}
		spec := &corev1.PodSpec{Affinity: &corev1.Affinity{NodeAffinity: modelAffinity}}
		attachServiceAntiAffinity(spec, testISVCName, "kubernetes.io/hostname", aiv1alpha1.PodAntiAffinityPolicyNone)
		Expect(spec.Affinity.NodeAffinity).To(BeIdenticalTo(modelAffinity))
		Expect(spec.Affinity.PodAntiAffinity).To(BeNil())
	})

	// roleWorkloads builds both role workloads of a profile that declares the
	// given rendered placement policy, in role order.
	roleWorkloads := func(policy aiv1alpha1.PodAntiAffinityPolicy) []*appsv1.Deployment {
		r := &InferenceServiceReconciler{Scheme: testScheme}
		profile := &aiv1alpha1.InferenceRuntimeProfile{Spec: aiv1alpha1.InferenceRuntimeProfileSpec{
			PodAntiAffinity: &aiv1alpha1.PodAntiAffinity{TopologyKey: "topology.kubernetes.io/zone"},
			Roles: []aiv1alpha1.Role{
				{Name: testApplyRouterRole, Workload: aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindDeployment}},
				{Name: testApplyPrefillRole, Workload: aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindDeployment}},
			},
		}}
		isvc := &aiv1alpha1.InferenceService{ObjectMeta: metav1.ObjectMeta{Name: testISVCName, Namespace: testNamespace}}
		rendered := &renderer.Result{PodAntiAffinityPolicy: string(policy)}
		deps := make([]*appsv1.Deployment, 0, len(profile.Spec.Roles))
		for _, role := range profile.Spec.Roles {
			rr := &renderer.RenderedRole{Name: role.Name, Replicas: 1, PodTemplate: aiv1alpha1.PodTemplate{Image: testEngineImage}}
			obj := r.desiredWorkload(isvc, profile, &role, rr, rendered, modelHostPath())
			deps = append(deps, obj.(*appsv1.Deployment))
		}
		return deps
	}

	zoneTerm := corev1.PodAffinityTerm{
		LabelSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"ai.cubestack.io/inference-service": testISVCName}},
		TopologyKey:   "topology.kubernetes.io/zone",
	}

	DescribeTable("propagates the profile-level podAntiAffinity to every role workload",
		func(policy aiv1alpha1.PodAntiAffinityPolicy, wantRequired []corev1.PodAffinityTerm, wantPreferred []corev1.WeightedPodAffinityTerm) {
			// The declaration lives once at profile scope; desiredWorkload must put
			// the identical term on every role's pod spec — a role without the term
			// could co-locate with a constrained role and the spread would not hold.
			deps := roleWorkloads(policy)
			Expect(deps).To(HaveLen(2))
			for _, dep := range deps {
				Expect(dep.Spec.Template.Spec.Affinity.PodAntiAffinity.RequiredDuringSchedulingIgnoredDuringExecution).To(Equal(wantRequired))
				Expect(dep.Spec.Template.Spec.Affinity.PodAntiAffinity.PreferredDuringSchedulingIgnoredDuringExecution).To(Equal(wantPreferred))
			}
		},
		Entry("required", aiv1alpha1.PodAntiAffinityPolicyRequired, []corev1.PodAffinityTerm{zoneTerm}, nil),
		Entry("preferred", aiv1alpha1.PodAntiAffinityPolicyPreferred, nil,
			[]corev1.WeightedPodAffinityTerm{{Weight: antiAffinityPreferredWeight, PodAffinityTerm: zoneTerm}}),
	)

	It("leaves every role workload without affinity when the policy is none", func() {
		deps := roleWorkloads(aiv1alpha1.PodAntiAffinityPolicyNone)
		Expect(deps).To(HaveLen(2))
		for _, dep := range deps {
			Expect(dep.Spec.Template.Spec.Affinity).To(BeNil())
		}
	})

	It("rolls the workload when the policy changes", func() {
		// The policy is written to the pod spec before templateHashAnnotations
		// hashes it, so flipping it changes the pod hash and rolls the workload
		// with no rollout plumbing of its own.
		required := roleWorkloads(aiv1alpha1.PodAntiAffinityPolicyRequired)
		none := roleWorkloads(aiv1alpha1.PodAntiAffinityPolicyNone)
		Expect(none).To(HaveLen(len(required)))
		for i := range required {
			requiredHash := required[i].Spec.Template.Annotations[templateHashAnnotationKey]
			Expect(requiredHash).NotTo(BeEmpty())
			Expect(none[i].Spec.Template.Annotations[templateHashAnnotationKey]).NotTo(Equal(requiredHash))
		}
	})

	It("maps each role's GPU resource through its effective accelerator", func() {
		r := &InferenceServiceReconciler{Scheme: testScheme}
		profile := &aiv1alpha1.InferenceRuntimeProfile{Spec: aiv1alpha1.InferenceRuntimeProfileSpec{
			Accelerator: aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorMetax, Models: []string{testGPUModelMXC500}},
			Roles: []aiv1alpha1.Role{
				{
					Name:        "prefill",
					Workload:    aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindDeployment},
					Accelerator: &aiv1alpha1.Accelerator{Vendor: aiv1alpha1.AcceleratorVendorNvidia, Models: []string{testGPUModelH200}},
				},
				{Name: "decode", Workload: aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindDeployment}},
			},
		}}
		isvc := &aiv1alpha1.InferenceService{ObjectMeta: metav1.ObjectMeta{Name: testISVCName, Namespace: testNamespace}}
		gpu := intstr.FromInt32(2)
		rrFor := func(name string) *renderer.RenderedRole {
			return &renderer.RenderedRole{Name: name, Replicas: 1, PodTemplate: aiv1alpha1.PodTemplate{
				Image:     testEngineImage,
				Resources: &aiv1alpha1.PodResources{GPUPerPod: &gpu},
			}}
		}

		prefill := r.desiredWorkload(isvc, profile, &profile.Spec.Roles[0], rrFor("prefill"), &renderer.Result{}, modelHostPath())
		requests := prefill.(*appsv1.Deployment).Spec.Template.Spec.Containers[0].Resources.Requests
		Expect(requests).To(HaveKey(corev1.ResourceName("nvidia.com/gpu")))

		decode := r.desiredWorkload(isvc, profile, &profile.Spec.Roles[1], rrFor("decode"), &renderer.Result{}, modelHostPath())
		requests = decode.(*appsv1.Deployment).Spec.Template.Spec.Containers[0].Resources.Requests
		Expect(requests).To(HaveKey(corev1.ResourceName("metax-tech.com/gpu")))
	})

	It("attaches a required nodeAffinity In term for multi-model accelerators", func() {
		spec := &corev1.PodSpec{}
		attachModelNodeAffinity(spec, testProductLabelMetax, []string{testGPUModelMXC500, testGPUModelMXC550})
		Expect(spec.Affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution).To(Equal(&corev1.NodeSelector{
			NodeSelectorTerms: []corev1.NodeSelectorTerm{{
				MatchExpressions: []corev1.NodeSelectorRequirement{{
					Key:      testProductLabelMetax,
					Operator: corev1.NodeSelectorOpIn,
					Values:   []string{testGPUModelMXC500, testGPUModelMXC550},
				}},
			}},
		}))
		// NodeSelectorTerms are OR-combined: the model constraint must be merged
		// into every existing term, never appended as an alternative term — a
		// node matching another term alone would otherwise schedule without the
		// model label.
		spec2 := &corev1.PodSpec{}
		attachModelNodeAffinity(spec2, testProductLabelMetax, []string{testGPUModelMXC500})
		attachModelNodeAffinity(spec2, "example.com/extra", []string{"a"})
		Expect(spec2.Affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution).To(Equal(&corev1.NodeSelector{
			NodeSelectorTerms: []corev1.NodeSelectorTerm{{
				MatchExpressions: []corev1.NodeSelectorRequirement{
					{Key: testProductLabelMetax, Operator: corev1.NodeSelectorOpIn, Values: []string{testGPUModelMXC500}},
					{Key: "example.com/extra", Operator: corev1.NodeSelectorOpIn, Values: []string{"a"}},
				},
			}},
		}))
	})

	It("keeps a legacy volume without at as an unmounted volume", func() {
		// Profiles stored before at became required (upgrade case) carry volumes
		// without a mount path; the immutable spec cannot be fixed in place, so
		// the render keeps the volume but skips the empty-path volumeMount.
		pt := aiv1alpha1.PodTemplate{
			Image: testEngineImage,
			Volumes: []aiv1alpha1.Volume{
				{Name: "legacy-shm", EmptyDir: &aiv1alpha1.EmptyDirVolume{Medium: testMemoryMedium}},
				{Name: testShmVolName, At: testShmMountPath, EmptyDir: &aiv1alpha1.EmptyDirVolume{Medium: testMemoryMedium}},
			},
		}
		spec := buildPodSpec(pt, "svc", modelHostPath(), aiv1alpha1.AcceleratorVendorMetax)
		Expect(spec.Volumes).To(HaveLen(2))
		Expect(spec.Containers[0].VolumeMounts).To(Equal([]corev1.VolumeMount{
			{Name: testShmVolName, MountPath: testShmMountPath},
		}))
	})

	It("maps extendedResources to requests and limits", func() {
		pt := aiv1alpha1.PodTemplate{
			Image: testEngineImage,
			Resources: &aiv1alpha1.PodResources{
				GPUPerPod:         ptrTo(intstr.FromInt32(2)),
				ExtendedResources: map[string]int64{"rdma/ib_shared_devices": 2},
			},
		}
		spec := buildPodSpec(pt, "svc", modelHostPath(), aiv1alpha1.AcceleratorVendorMetax)
		c := spec.Containers[0]
		Expect(c.Resources.Requests.Name("rdma/ib_shared_devices", resource.DecimalSI).String()).To(Equal("2"))
		Expect(c.Resources.Limits.Name("rdma/ib_shared_devices", resource.DecimalSI).String()).To(Equal("2"))
		Expect(c.Resources.Limits.Name("metax-tech.com/gpu", resource.DecimalSI).String()).To(Equal("2"))
	})

	It("composes a HostPath model volume", func() {
		pt := aiv1alpha1.PodTemplate{
			Image:  testEngineImage,
			Mounts: []aiv1alpha1.ModelMount{{Model: modelKeyMain, At: testModelPath, ReadOnly: true}},
		}
		spec := buildPodSpec(pt, "svc", modelHostPath(), aiv1alpha1.AcceleratorVendorMetax)
		Expect(spec.Volumes).To(HaveLen(1))
		Expect(spec.Volumes[0].Name).To(Equal("model-main"))
		Expect(spec.Volumes[0].HostPath.Path).To(Equal("/models/m"))
		Expect(spec.Volumes[0].HostPath.Type).To(Equal(ptrTo(corev1.HostPathDirectory)))
		Expect(spec.Containers[0].VolumeMounts).To(Equal([]corev1.VolumeMount{
			{Name: "model-main", MountPath: testModelPath, ReadOnly: true},
		}))
	})

	It("composes a Dynamic model volume with subPath", func() {
		mv := &aiv1alpha1.ModelVersion{Spec: aiv1alpha1.ModelVersionSpec{
			Model: "m", Version: "v1",
			Storage: aiv1alpha1.ModelStorage{
				Strategy: aiv1alpha1.StorageStrategyDynamic,
				Dynamic: &aiv1alpha1.DynamicStorage{
					StorageClassName: "shared", SubPath: "m/v1",
					Capacity: resource.MustParse("1Ti"),
				},
			},
		}}
		pt := aiv1alpha1.PodTemplate{
			Image:  testEngineImage,
			Mounts: []aiv1alpha1.ModelMount{{Model: modelKeyMain, At: testModelPath, ReadOnly: true}},
		}
		spec := buildPodSpec(pt, "other", mv, aiv1alpha1.AcceleratorVendorMetax)
		Expect(spec.Volumes[0].PersistentVolumeClaim.ClaimName).To(Equal("other-model-main"))
		Expect(spec.Volumes[0].PersistentVolumeClaim.ReadOnly).To(BeTrue())
		Expect(spec.Containers[0].VolumeMounts[0].SubPath).To(Equal("m/v1"))
	})

	It("composes a Static model volume without subPath", func() {
		mv := &aiv1alpha1.ModelVersion{Spec: aiv1alpha1.ModelVersionSpec{
			Model: "m", Version: "v1",
			Storage: aiv1alpha1.ModelStorage{
				Strategy: aiv1alpha1.StorageStrategyStatic,
				Static: &aiv1alpha1.StaticStorage{
					StorageClassName: "cephfs-model-static",
					Capacity:         resource.MustParse("320Gi"),
				},
			},
		}}
		pt := aiv1alpha1.PodTemplate{
			Image:  testEngineImage,
			Mounts: []aiv1alpha1.ModelMount{{Model: modelKeyMain, At: testModelPath, ReadOnly: true}},
		}
		spec := buildPodSpec(pt, "other", mv, aiv1alpha1.AcceleratorVendorMetax)
		Expect(spec.Volumes[0].PersistentVolumeClaim.ClaimName).To(Equal("other-model-main"))
		Expect(spec.Volumes[0].PersistentVolumeClaim.ReadOnly).To(BeTrue())
		Expect(spec.Containers[0].VolumeMounts[0].SubPath).To(BeEmpty())
	})

	It("injects the S3 credentials volume as a single read-only file", func() {
		spec := &corev1.PodSpec{Containers: []corev1.Container{{Name: mainContainerName}}}
		addCredentialsVolume(spec, "svc-a")

		Expect(spec.Volumes).To(HaveLen(1))
		vol := spec.Volumes[0]
		Expect(vol.Name).To(Equal(aiv1alpha1.ModelCredentialsVolumeName))
		Expect(vol.Secret.SecretName).To(Equal("svc-a-model-main-credentials"))
		Expect(vol.Secret.Items).To(Equal([]corev1.KeyToPath{
			{Key: aiv1alpha1.ModelCredentialsKey, Path: aiv1alpha1.ModelCredentialsFile},
		}))
		Expect(vol.Secret.DefaultMode).To(Equal(ptrTo(int32(0444))))
		Expect(spec.Containers[0].VolumeMounts).To(Equal([]corev1.VolumeMount{{
			Name:      aiv1alpha1.ModelCredentialsVolumeName,
			MountPath: aiv1alpha1.ModelCredentialsDir,
			ReadOnly:  true,
		}}))
	})

	It("mounts mount-type assets as read-only ConfigMap volumes named asset-<name>", func() {
		spec := &corev1.PodSpec{Containers: []corev1.Container{{Name: mainContainerName}}}
		addMountAssetVolumes(spec, "svc-a", []aiv1alpha1.Asset{
			{Name: "bootstrap", ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: "src-bootstrap"}, Mount: &aiv1alpha1.AssetMount{Path: testBootstrapMountPath, Mode: 0755}},
			{Name: testRuntimeConfig, ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: "src-config"}, EnvFrom: ptrTo(true)},
			{Name: "certs", ConfigMapRef: aiv1alpha1.AssetConfigMapRef{Name: "src-certs"}, Mount: &aiv1alpha1.AssetMount{Path: "/etc/certs", Mode: 0444}},
		})

		Expect(spec.Volumes).To(Equal([]corev1.Volume{
			{Name: "asset-bootstrap", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{
				LocalObjectReference: corev1.LocalObjectReference{Name: "svc-a-bootstrap"},
				DefaultMode:          ptrTo(int32(0755)),
			}}},
			{Name: "asset-certs", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{
				LocalObjectReference: corev1.LocalObjectReference{Name: "svc-a-certs"},
				DefaultMode:          ptrTo(int32(0444)),
			}}},
		}))
		Expect(spec.Containers[0].VolumeMounts).To(Equal([]corev1.VolumeMount{
			{Name: "asset-bootstrap", MountPath: testBootstrapMountPath, ReadOnly: true},
			{Name: "asset-certs", MountPath: "/etc/certs", ReadOnly: true},
		}))
	})

	It("converts envFromAssets to envFrom ConfigMap refs named <isvc>-<asset>", func() {
		pt := aiv1alpha1.PodTemplate{
			Image:         testEngineImage,
			EnvFromAssets: []string{testRuntimeConfig, "bootstrap"},
		}
		spec := buildPodSpec(pt, "other", modelHostPath(), aiv1alpha1.AcceleratorVendorMetax)
		Expect(spec.Containers[0].EnvFrom).To(Equal([]corev1.EnvFromSource{
			{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "other-runtime-config"}}},
			{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "other-bootstrap"}}},
		}))
	})

	It("converts value and fieldRef env vars", func() {
		pt := aiv1alpha1.PodTemplate{
			Image: testEngineImage,
			Env: []aiv1alpha1.EnvVar{
				{Name: "STATIC", Value: ptrTo("v")},
				{Name: "HOST_IP", FieldRef: &aiv1alpha1.ObjectFieldSelector{FieldPath: "status.hostIP"}},
			},
		}
		spec := buildPodSpec(pt, "svc", modelHostPath(), aiv1alpha1.AcceleratorVendorMetax)
		Expect(spec.Containers[0].Env).To(Equal([]corev1.EnvVar{
			{Name: "STATIC", Value: "v"},
			{Name: "HOST_IP", ValueFrom: &corev1.EnvVarSource{FieldRef: &corev1.ObjectFieldSelector{FieldPath: "status.hostIP"}}},
		}))
	})

	It("backfills hostPort when hostNetwork is enabled", func() {
		pt := aiv1alpha1.PodTemplate{
			Image:       testEngineImage,
			HostNetwork: ptrTo(true),
			Ports:       []aiv1alpha1.ContainerPort{{Name: "http", ContainerPort: 8001}},
		}
		spec := buildPodSpec(pt, "svc", modelHostPath(), aiv1alpha1.AcceleratorVendorMetax)
		Expect(spec.HostNetwork).To(BeTrue())
		Expect(spec.Containers[0].Ports[0].HostPort).To(Equal(int32(8001)))
	})

	It("converts additional volumes, security context, probes and pod-level fields", func() {
		pt := aiv1alpha1.PodTemplate{
			Image: testEngineImage,
			Volumes: []aiv1alpha1.Volume{
				{Name: testShmVolName, At: testShmMountPath, EmptyDir: &aiv1alpha1.EmptyDirVolume{Medium: testMemoryMedium, SizeLimit: ptrTo(resource.MustParse("8Gi"))}},
				{Name: "ib", At: testIBDevicePath, HostPath: &aiv1alpha1.HostPathVolume{Path: testIBDevicePath}},
			},
			SecurityContext:               &aiv1alpha1.PodSecurityContext{Privileged: ptrTo(true), RunAsUser: ptrTo[int64](1000)},
			TerminationGracePeriodSeconds: ptrTo[int64](60),
			Probes: &aiv1alpha1.Probes{
				Startup: &aiv1alpha1.Probe{
					HTTPGet:          &aiv1alpha1.HTTPGetAction{Path: "/health", Port: intstr.FromString("http")},
					FailureThreshold: ptrTo[int32](180),
				},
			},
			NodeSelector: map[string]string{"pool": "gpu"},
			DNSPolicy:    corev1.DNSClusterFirstWithHostNet,
		}
		spec := buildPodSpec(pt, "svc", modelHostPath(), aiv1alpha1.AcceleratorVendorMetax)
		Expect(spec.Volumes).To(HaveLen(2))
		Expect(spec.Volumes[0].EmptyDir).To(Equal(&corev1.EmptyDirVolumeSource{
			Medium:    corev1.StorageMediumMemory,
			SizeLimit: ptrTo(resource.MustParse("8Gi")),
		}))
		Expect(spec.Volumes[1].HostPath.Path).To(Equal(testIBDevicePath))
		Expect(spec.Volumes[1].HostPath.Type).To(Equal(ptrTo(corev1.HostPathDirectory)))
		c := spec.Containers[0]
		Expect(c.VolumeMounts).To(Equal([]corev1.VolumeMount{
			{Name: testShmVolName, MountPath: testShmMountPath},
			{Name: "ib", MountPath: testIBDevicePath},
		}))
		Expect(c.SecurityContext.Privileged).To(Equal(ptrTo(true)))
		Expect(c.SecurityContext.RunAsUser).To(Equal(ptrTo[int64](1000)))
		Expect(spec.TerminationGracePeriodSeconds).To(Equal(ptrTo[int64](60)))
		Expect(c.StartupProbe.HTTPGet.Path).To(Equal("/health"))
		Expect(c.StartupProbe.HTTPGet.Port).To(Equal(intstr.FromString("http")))
		Expect(c.StartupProbe.FailureThreshold).To(Equal(int32(180)))
		Expect(spec.NodeSelector).To(Equal(map[string]string{"pool": "gpu"}))
		Expect(spec.DNSPolicy).To(Equal(corev1.DNSClusterFirstWithHostNet))
	})
})

var _ = Describe("vendorProductLabel", func() {
	It("maps nvidia to the label its device plugin writes", func() {
		Expect(vendorProductLabel(aiv1alpha1.AcceleratorVendorNvidia)).To(Equal(testProductLabelNvidia))
	})

	It("maps metax to the label its device plugin writes", func() {
		Expect(vendorProductLabel(aiv1alpha1.AcceleratorVendorMetax)).To(Equal(testProductLabelMetax))
	})

	// The mapping is total like vendorResource's, and defaults the same way: an
	// unrecognised vendor has to land on one of the two labels rather than on
	// none, or a half-filled spec would be pinned to a label no plugin writes.
	It("resolves an unrecognised vendor to the metax label", func() {
		Expect(vendorProductLabel(aiv1alpha1.AcceleratorVendor("amd"))).To(Equal(testProductLabelMetax))
		Expect(vendorProductLabel("")).To(Equal(testProductLabelMetax))
	})
})
