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
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// mainContainerName is the name of the single container of every workload.
const mainContainerName = "main"

// ptr returns a pointer to v.
func ptr[T any](v T) *T { return &v }

// vendorResource maps an AcceleratorVendor to the GPU extended resource name.
func vendorResource(vendor aiv1alpha1.AcceleratorVendor) string {
	switch vendor {
	case aiv1alpha1.AcceleratorVendorNvidia:
		return "nvidia.com/gpu"
	default:
		return "metax-tech.com/gpu"
	}
}

// buildPodSpec converts the rendered platform pod template into a corev1.PodSpec:
// resources mapping (cpu/memory → requests; gpuPerPod → the vendor's extended
// resource in requests AND limits), model volume composition (design §4.5),
// envFromAssets → envFrom ConfigMap refs (<isvc>-<asset>), hostPort backfill
// when hostNetwork is enabled. The container is named main.
func buildPodSpec(pt aiv1alpha1.PodTemplate, isvcName string, model *aiv1alpha1.ModelVersion, vendor aiv1alpha1.AcceleratorVendor) corev1.PodSpec {
	container := corev1.Container{
		Name:            mainContainerName,
		Image:           pt.Image,
		ImagePullPolicy: pt.ImagePullPolicy,
		WorkingDir:      pt.WorkingDir,
		Command:         pt.Command,
		Args:            pt.Args,
	}
	for _, e := range pt.Env {
		env := corev1.EnvVar{Name: e.Name}
		switch {
		case e.Value != nil:
			env.Value = *e.Value
		case e.FieldRef != nil:
			env.ValueFrom = &corev1.EnvVarSource{FieldRef: &corev1.ObjectFieldSelector{FieldPath: e.FieldRef.FieldPath}}
		}
		container.Env = append(container.Env, env)
	}
	for _, asset := range pt.EnvFromAssets {
		container.EnvFrom = append(container.EnvFrom, corev1.EnvFromSource{
			ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: fmt.Sprintf("%s-%s", isvcName, asset)}},
		})
	}
	if pt.Resources != nil {
		container.Resources = corev1.ResourceRequirements{Requests: corev1.ResourceList{}, Limits: corev1.ResourceList{}}
		if pt.Resources.CPU != nil {
			container.Resources.Requests[corev1.ResourceCPU] = *pt.Resources.CPU
		}
		if pt.Resources.Memory != nil {
			container.Resources.Requests[corev1.ResourceMemory] = *pt.Resources.Memory
		}
		if pt.Resources.GPUPerPod != nil {
			resourceName := corev1.ResourceName(vendorResource(vendor))
			gpu := *resource.NewQuantity(*pt.Resources.GPUPerPod, resource.DecimalSI)
			container.Resources.Requests[resourceName] = gpu
			container.Resources.Limits[resourceName] = gpu
		}
	}
	if pt.SecurityContext != nil {
		container.SecurityContext = &corev1.SecurityContext{
			Privileged: pt.SecurityContext.Privileged,
			RunAsUser:  pt.SecurityContext.RunAsUser,
			RunAsGroup: pt.SecurityContext.RunAsGroup,
		}
	}
	for _, p := range pt.Ports {
		port := corev1.ContainerPort{Name: p.Name, ContainerPort: p.ContainerPort}
		if pt.HostNetwork != nil && *pt.HostNetwork {
			// Backfill hostPort so the scheduler accounts for the host ports
			// (design §3.2 podTemplate.hostNetwork).
			port.HostPort = p.ContainerPort
		}
		container.Ports = append(container.Ports, port)
	}
	container.VolumeMounts = modelVolumeMounts(pt.Mounts, model)
	if pt.Probes != nil {
		container.StartupProbe = probeToK8s(pt.Probes.Startup)
		container.ReadinessProbe = probeToK8s(pt.Probes.Readiness)
		container.LivenessProbe = probeToK8s(pt.Probes.Liveness)
	}

	spec := corev1.PodSpec{
		Containers:                    []corev1.Container{container},
		ImagePullSecrets:              pt.ImagePullSecrets,
		TerminationGracePeriodSeconds: pt.TerminationGracePeriodSeconds,
		NodeSelector:                  pt.NodeSelector,
		HostNetwork:                   pt.HostNetwork != nil && *pt.HostNetwork,
		DNSPolicy:                     pt.DNSPolicy,
	}
	spec.Volumes = append(spec.Volumes, modelVolumes(pt.Mounts, isvcName, model)...)
	for _, v := range pt.Volumes {
		vol := corev1.Volume{Name: v.Name}
		switch {
		case v.EmptyDir != nil:
			vol.EmptyDir = &corev1.EmptyDirVolumeSource{}
		case v.HostPath != nil:
			vol.HostPath = &corev1.HostPathVolumeSource{Path: v.HostPath.Path, Type: ptr(corev1.HostPathDirectory)}
		}
		spec.Volumes = append(spec.Volumes, vol)
	}
	return spec
}

// modelVolumes builds the model volume of each mount (design §4.5): one
// volume per model key, named model-<key>; v1alpha1 only has main.
func modelVolumes(mounts []aiv1alpha1.ModelMount, isvcName string, model *aiv1alpha1.ModelVersion) []corev1.Volume {
	vols := make([]corev1.Volume, 0, len(mounts))
	for _, m := range mounts {
		vol := corev1.Volume{Name: fmt.Sprintf("model-%s", m.Model)}
		switch model.Spec.Storage.Strategy {
		case aiv1alpha1.StorageStrategyPVC:
			vol.PersistentVolumeClaim = &corev1.PersistentVolumeClaimVolumeSource{
				ClaimName: fmt.Sprintf("%s-model-%s", isvcName, m.Model),
				ReadOnly:  true,
			}
		default:
			vol.HostPath = &corev1.HostPathVolumeSource{Path: model.Spec.Storage.HostPath.Path, Type: ptr(corev1.HostPathDirectory)}
		}
		vols = append(vols, vol)
	}
	return vols
}

// modelVolumeMounts builds the model volume mount of each mount: readOnly
// comes from the mount (the API CEL rule requires true), subPath only for PVC
// storage (design §4.5).
func modelVolumeMounts(mounts []aiv1alpha1.ModelMount, model *aiv1alpha1.ModelVersion) []corev1.VolumeMount {
	mounts_ := make([]corev1.VolumeMount, 0, len(mounts))
	for _, m := range mounts {
		mount := corev1.VolumeMount{Name: fmt.Sprintf("model-%s", m.Model), MountPath: m.At, ReadOnly: m.ReadOnly}
		if model.Spec.Storage.Strategy == aiv1alpha1.StorageStrategyPVC {
			mount.SubPath = model.Spec.Storage.PVC.SubPath
		}
		mounts_ = append(mounts_, mount)
	}
	return mounts_
}

// probeToK8s converts a platform probe; port names pass through (K8s resolves
// them against the container ports).
func probeToK8s(p *aiv1alpha1.Probe) *corev1.Probe {
	if p == nil {
		return nil
	}
	probe := &corev1.Probe{}
	if p.InitialDelaySeconds != nil {
		probe.InitialDelaySeconds = *p.InitialDelaySeconds
	}
	if p.PeriodSeconds != nil {
		probe.PeriodSeconds = *p.PeriodSeconds
	}
	if p.TimeoutSeconds != nil {
		probe.TimeoutSeconds = *p.TimeoutSeconds
	}
	if p.FailureThreshold != nil {
		probe.FailureThreshold = *p.FailureThreshold
	}
	switch {
	case p.HTTPGet != nil:
		probe.HTTPGet = &corev1.HTTPGetAction{Path: p.HTTPGet.Path, Port: p.HTTPGet.Port}
	case p.TCPSocket != nil:
		probe.TCPSocket = &corev1.TCPSocketAction{Port: p.TCPSocket.Port}
	}
	return probe
}
