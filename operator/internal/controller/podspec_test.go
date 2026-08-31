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
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/util/intstr"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

const (
	testEngineImage   = "registry.local/engine:v1"
	testModelPath     = "/workspace/model"
	testRuntimeConfig = "runtime-config"
)

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
				GPUPerPod: ptrTo[int64](2),
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
			Resources: &aiv1alpha1.PodResources{GPUPerPod: ptrTo[int64](1)},
		}
		spec := buildPodSpec(pt, "svc", modelHostPath(), aiv1alpha1.AcceleratorVendorNvidia)
		c := spec.Containers[0]
		Expect(c.Resources.Requests.Name("nvidia.com/gpu", resource.DecimalSI).String()).To(Equal("1"))
		Expect(c.Resources.Limits.Name("nvidia.com/gpu", resource.DecimalSI).String()).To(Equal("1"))
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

	It("composes a PVC model volume with subPath", func() {
		mv := &aiv1alpha1.ModelVersion{Spec: aiv1alpha1.ModelVersionSpec{
			Model: "m", Version: "v1",
			Storage: aiv1alpha1.ModelStorage{
				Strategy: aiv1alpha1.StorageStrategyPVC,
				PVC: &aiv1alpha1.PVCStorage{
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
				{Name: "shm", EmptyDir: &aiv1alpha1.EmptyDirVolume{}},
				{Name: "ib", HostPath: &aiv1alpha1.HostPathVolume{Path: "/dev/infiniband"}},
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
		Expect(spec.Volumes[0].EmptyDir).NotTo(BeNil())
		Expect(spec.Volumes[1].HostPath.Path).To(Equal("/dev/infiniband"))
		c := spec.Containers[0]
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
