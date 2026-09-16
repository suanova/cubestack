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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

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
// resources mapping (cpu/memory → requests; gpuPerPod and extendedResources →
// the extended resources in requests AND limits), model volume composition
// (design §4.5), additional volumes mounted at their declared at path,
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
		for name, n := range pt.Resources.ExtendedResources {
			resourceName := corev1.ResourceName(name)
			q := *resource.NewQuantity(n, resource.DecimalSI)
			container.Resources.Requests[resourceName] = q
			container.Resources.Limits[resourceName] = q
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
			vol.EmptyDir = &corev1.EmptyDirVolumeSource{
				Medium:    corev1.StorageMedium(v.EmptyDir.Medium),
				SizeLimit: v.EmptyDir.SizeLimit,
			}
		case v.HostPath != nil:
			vol.HostPath = &corev1.HostPathVolumeSource{Path: v.HostPath.Path, Type: ptr(corev1.HostPathDirectory)}
		}
		spec.Volumes = append(spec.Volumes, vol)
		// Each additional volume is mounted at its declared at path. The mount
		// is writable (unlike the readOnly model and asset mounts): /dev/shm
		// tmpfs and hostPath device directories are write targets. An empty at
		// only occurs on profiles stored before at became required (the spec is
		// immutable, so a legacy volume keeps its pre-upgrade unmounted form).
		if v.At == "" {
			continue
		}
		spec.Containers[0].VolumeMounts = append(spec.Containers[0].VolumeMounts, corev1.VolumeMount{
			Name:      v.Name,
			MountPath: v.At,
		})
	}
	return spec
}

// attachServiceAntiAffinity adds the service-wide anti-affinity term to one
// role's pod spec (design §3.2 podAntiAffinity): no two pods of this service
// may share the declared topology domain. The label selector is fixed by the
// platform to the service label — it cannot be customized. desiredWorkload
// calls it for every role from the single profile-level declaration, so all
// role pods carry the same term and the guarantee is mutual.
func attachServiceAntiAffinity(spec *corev1.PodSpec, isvcName, topologyKey string) {
	if spec.Affinity == nil {
		spec.Affinity = &corev1.Affinity{}
	}
	if spec.Affinity.PodAntiAffinity == nil {
		spec.Affinity.PodAntiAffinity = &corev1.PodAntiAffinity{}
	}
	spec.Affinity.PodAntiAffinity.RequiredDuringSchedulingIgnoredDuringExecution = append(
		spec.Affinity.PodAntiAffinity.RequiredDuringSchedulingIgnoredDuringExecution,
		corev1.PodAffinityTerm{
			LabelSelector: &metav1.LabelSelector{MatchLabels: map[string]string{inferenceServiceLabelKey: isvcName}},
			TopologyKey:   topologyKey,
		},
	)
}

// attachModelNodeAffinity constrains scheduling to nodes offering one of the
// declared accelerator models when the profile declares several (design §3.2):
// a required nodeAffinity In term on the vendor product label, AND-combined
// with any existing affinity. Single-model profiles are injected as a
// nodeSelector instead and never reach this helper.
func attachModelNodeAffinity(spec *corev1.PodSpec, label string, models []string) {
	if spec.Affinity == nil {
		spec.Affinity = &corev1.Affinity{}
	}
	if spec.Affinity.NodeAffinity == nil {
		spec.Affinity.NodeAffinity = &corev1.NodeAffinity{}
	}
	requirement := corev1.NodeSelectorRequirement{Key: label, Operator: corev1.NodeSelectorOpIn, Values: models}
	required := spec.Affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution
	if required == nil {
		spec.Affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution = &corev1.NodeSelector{
			NodeSelectorTerms: []corev1.NodeSelectorTerm{{MatchExpressions: []corev1.NodeSelectorRequirement{requirement}}},
		}
		return
	}
	// NodeSelectorTerms are OR-combined, so the model constraint must be merged
	// into every existing term: a new alternative term would let a node that
	// matches another term schedule without the model label.
	for i := range required.NodeSelectorTerms {
		required.NodeSelectorTerms[i].MatchExpressions = append(required.NodeSelectorTerms[i].MatchExpressions, requirement)
	}
	if len(required.NodeSelectorTerms) == 0 {
		required.NodeSelectorTerms = append(required.NodeSelectorTerms, corev1.NodeSelectorTerm{MatchExpressions: []corev1.NodeSelectorRequirement{requirement}})
	}
}

// addMountAssetVolumes mounts every profile asset declared with assets[].mount
// as a read-only ConfigMap volume named asset-<name> backed by the rendered
// copy <isvc>-<name> (design §4.4: mount assets apply to every role, mounted
// with defaultMode set to the declared mode). asset- is a reserved volume-name
// prefix: a podTemplate.volumes entry colliding with it is rejected by the
// apiserver at workload create time and surfaces as a reconcile error.
func addMountAssetVolumes(spec *corev1.PodSpec, isvcName string, assets []aiv1alpha1.Asset) {
	for _, asset := range assets {
		if asset.Mount == nil {
			continue
		}
		volumeName := fmt.Sprintf("asset-%s", asset.Name)
		volume := corev1.Volume{
			Name: volumeName,
			VolumeSource: corev1.VolumeSource{
				ConfigMap: &corev1.ConfigMapVolumeSource{
					LocalObjectReference: corev1.LocalObjectReference{Name: fmt.Sprintf("%s-%s", isvcName, asset.Name)},
					DefaultMode:          ptr(asset.Mount.Mode),
				},
			},
		}
		spec.Volumes = append(spec.Volumes, volume)
		spec.Containers[0].VolumeMounts = append(spec.Containers[0].VolumeMounts, corev1.VolumeMount{
			Name:      volumeName,
			MountPath: asset.Mount.Path,
			ReadOnly:  true,
		})
	}
}

// modelVolumes builds the model volume of each mount (design §4.5): one
// volume per model key, named model-<key>; v1alpha1 only has main.
func modelVolumes(mounts []aiv1alpha1.ModelMount, isvcName string, model *aiv1alpha1.ModelVersion) []corev1.Volume {
	vols := make([]corev1.Volume, 0, len(mounts))
	for _, m := range mounts {
		vol := corev1.Volume{Name: fmt.Sprintf("model-%s", m.Model)}
		switch model.Spec.Storage.Strategy {
		case aiv1alpha1.StorageStrategyDynamic, aiv1alpha1.StorageStrategyStatic:
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
// comes from the mount (the API CEL rule requires true), subPath only for
// Dynamic storage (design §4.5). Static strategy mounts the entire storage
// unit at the mount path with no subPath.
func modelVolumeMounts(mounts []aiv1alpha1.ModelMount, model *aiv1alpha1.ModelVersion) []corev1.VolumeMount {
	mounts_ := make([]corev1.VolumeMount, 0, len(mounts))
	for _, m := range mounts {
		mount := corev1.VolumeMount{Name: fmt.Sprintf("model-%s", m.Model), MountPath: m.At, ReadOnly: m.ReadOnly}
		if model.Spec.Storage.Strategy == aiv1alpha1.StorageStrategyDynamic {
			mount.SubPath = model.Spec.Storage.Dynamic.SubPath
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
	case p.Exec != nil:
		probe.Exec = &corev1.ExecAction{Command: p.Exec.Command}
	}
	return probe
}
