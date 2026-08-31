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
	"maps"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	leaderworkersetv1 "sigs.k8s.io/lws/api/leaderworkerset/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/internal/renderer"
)

// roleLabelKey is the controller-owned pod label selecting the role; it is
// injected into the pod template and used as the Service selector.
const roleLabelKey = "ai.cubestack.io/role"

// controllerSelectorLabels are the labels the controller injects into the pod
// template and uses as the Service selector (design §3.2: on conflict the
// controller's values win).
func controllerSelectorLabels(isvcName, roleName string) map[string]string {
	return map[string]string{inferenceServiceLabelKey: isvcName, roleLabelKey: roleName}
}

// managedLabels are the labels of every generated resource (design §4.3).
func managedLabels(isvcName, profileRef, roleName string) map[string]string {
	return map[string]string{
		inferenceServiceLabelKey: isvcName,
		roleLabelKey:             roleName,
		profileLabelKey:          profileRef,
		managedByLabelKey:        managedByValue,
	}
}

// podObjectMeta merges the profile pod labels and annotations with the
// controller selector labels (controller wins) and the template-hash
// annotations.
func podObjectMeta(isvcName, roleName string, pt aiv1alpha1.PodTemplate, hashAnnotations map[string]string) (map[string]string, map[string]string) {
	labels := make(map[string]string, len(pt.Labels)+2)
	maps.Copy(labels, pt.Labels)
	maps.Copy(labels, controllerSelectorLabels(isvcName, roleName))
	annotations := make(map[string]string, len(pt.Annotations)+len(hashAnnotations))
	maps.Copy(annotations, pt.Annotations)
	maps.Copy(annotations, hashAnnotations)
	return labels, annotations
}

// desiredService builds the cluster Service <isvc>-<role> of one role.
func desiredService(isvc *aiv1alpha1.InferenceService, role *aiv1alpha1.Role, scheme *runtime.Scheme) *corev1.Service {
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("%s-%s", isvc.Name, role.Name),
			Namespace: isvc.Namespace,
			Labels:    managedLabels(isvc.Name, isvc.Spec.ProfileRef, role.Name),
		},
		Spec: corev1.ServiceSpec{
			Selector: controllerSelectorLabels(isvc.Name, role.Name),
		},
	}
	if role.Service != nil {
		for _, p := range role.Service.Ports {
			port := corev1.ServicePort{Name: p.Name, Port: p.Port}
			if p.TargetPort != nil {
				port.TargetPort = *p.TargetPort
			}
			svc.Spec.Ports = append(svc.Spec.Ports, port)
		}
	}
	_ = ctrl.SetControllerReference(isvc, svc, scheme)
	return svc
}

// desiredHeadlessService builds the headless Service <isvc>-<role>-hl
// (ClusterIP: None) for per-Pod discovery.
func desiredHeadlessService(isvc *aiv1alpha1.InferenceService, role *aiv1alpha1.Role, scheme *runtime.Scheme) *corev1.Service {
	svc := desiredService(isvc, role, scheme)
	svc.Name = fmt.Sprintf("%s-%s-hl", isvc.Name, role.Name)
	svc.Spec.ClusterIP = corev1.ClusterIPNone
	return svc
}

// desiredLWS builds the LeaderWorkerSet of a role (design §4.3 mapping table):
// replicas → spec.replicas, group.size → leaderWorkerTemplate.size, the pod
// template into leaderWorkerTemplate.workerTemplate (leaderTemplate left
// empty — LWS inherits it), fixed restartPolicy/networkConfig/rolloutStrategy.
func desiredLWS(isvc *aiv1alpha1.InferenceService, role *aiv1alpha1.Role, rr *renderer.RenderedRole, podSpec corev1.PodSpec, podLabels, podAnnotations map[string]string, scheme *runtime.Scheme) *leaderworkersetv1.LeaderWorkerSet {
	lws := &leaderworkersetv1.LeaderWorkerSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("%s-%s", isvc.Name, role.Name),
			Namespace: isvc.Namespace,
			Labels:    managedLabels(isvc.Name, isvc.Spec.ProfileRef, role.Name),
		},
		Spec: leaderworkersetv1.LeaderWorkerSetSpec{
			Replicas: ptr(int32(rr.Replicas)),
			LeaderWorkerTemplate: leaderworkersetv1.LeaderWorkerTemplate{
				Size:           ptr(int32(rr.GroupSize)),
				RestartPolicy:  leaderworkersetv1.RecreateGroupOnPodRestart,
				WorkerTemplate: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: podLabels, Annotations: podAnnotations}, Spec: podSpec},
			},
			StartupPolicy: leaderworkersetv1.LeaderCreatedStartupPolicy,
			RolloutStrategy: leaderworkersetv1.RolloutStrategy{
				Type: leaderworkersetv1.RollingUpdateStrategyType,
				RollingUpdateConfiguration: &leaderworkersetv1.RollingUpdateConfiguration{
					MaxSurge:       intstr.FromInt(0),
					MaxUnavailable: intstr.FromInt(1),
				},
			},
			NetworkConfig: &leaderworkersetv1.NetworkConfig{SubdomainPolicy: ptr(leaderworkersetv1.SubdomainUniquePerReplica)},
		},
	}
	_ = ctrl.SetControllerReference(isvc, lws, scheme)
	return lws
}

// desiredDeployment builds the Deployment of a role (design §4.3 mapping
// table): replicas → spec.replicas, pod template → spec.template, fixed
// RollingUpdate{maxSurge: 0, maxUnavailable: 1}.
func desiredDeployment(isvc *aiv1alpha1.InferenceService, role *aiv1alpha1.Role, rr *renderer.RenderedRole, podSpec corev1.PodSpec, podLabels, podAnnotations map[string]string, scheme *runtime.Scheme) *appsv1.Deployment {
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("%s-%s", isvc.Name, role.Name),
			Namespace: isvc.Namespace,
			Labels:    managedLabels(isvc.Name, isvc.Spec.ProfileRef, role.Name),
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: ptr(int32(rr.Replicas)),
			Selector: &metav1.LabelSelector{MatchLabels: controllerSelectorLabels(isvc.Name, role.Name)},
			Strategy: appsv1.DeploymentStrategy{
				Type: appsv1.RollingUpdateDeploymentStrategyType,
				RollingUpdate: &appsv1.RollingUpdateDeployment{
					MaxSurge:       ptr(intstr.FromInt(0)),
					MaxUnavailable: ptr(intstr.FromInt(1)),
				},
			},
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: podLabels, Annotations: podAnnotations}, Spec: podSpec},
		},
	}
	_ = ctrl.SetControllerReference(isvc, dep, scheme)
	return dep
}
