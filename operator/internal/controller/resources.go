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
	"slices"

	monitoringv1 "github.com/prometheus-operator/prometheus-operator/pkg/apis/monitoring/v1"

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

// headlessServiceLabelKey marks the headless role Service (<isvc>-<role>-hl).
// The headless Service carries the same locating labels as its cluster-IP
// sibling, so the ServiceMonitor's selector needs a discriminator to leave it
// out: its endpoints include every worker of a group, and only a group's
// leader serves the role's endpoint (see roleSelectorLabels).
const headlessServiceLabelKey = "ai.cubestack.io/headless"

// observabilityPartOfKey/Value label the ServiceMonitor that scrapes the role
// Services. Prometheus selects ServiceMonitors by this value
// (observability/docs/installer-requirements.md §1.2).
const (
	observabilityPartOfKey   = "app.kubernetes.io/part-of"
	observabilityPartOfValue = "cubestack-observability"
)

// leaderWorkerIndex is the LWS worker-index label value of a group's leader.
const leaderWorkerIndex = "0"

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

// roleSelectorLabels are the Service selector labels of one role: the
// controller selector labels, plus — for LeaderWorkerSet roles — the leader
// index. Only a group's leader serves the role's endpoint: its workers run the
// engine's headless side (design §4.3), so a Service balancing across the
// whole group would send requests to pods that cannot answer them.
func roleSelectorLabels(isvcName string, role *aiv1alpha1.Role) map[string]string {
	labels := controllerSelectorLabels(isvcName, role.Name)
	if role.Workload.Kind == aiv1alpha1.WorkloadKindLeaderWorkerSet {
		labels[leaderworkersetv1.WorkerIndexLabelKey] = leaderWorkerIndex
	}
	return labels
}

// desiredService builds the cluster Service <isvc>-<role> of one role.
func desiredService(isvc *aiv1alpha1.InferenceService, role *aiv1alpha1.Role, scheme *runtime.Scheme) *corev1.Service {
	return desiredServiceWithSelector(isvc, role, roleSelectorLabels(isvc.Name, role), scheme)
}

// desiredServiceWithSelector builds one role Service with the given selector.
func desiredServiceWithSelector(isvc *aiv1alpha1.InferenceService, role *aiv1alpha1.Role, selector map[string]string, scheme *runtime.Scheme) *corev1.Service {
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("%s-%s", isvc.Name, role.Name),
			Namespace: isvc.Namespace,
			Labels:    managedLabels(isvc.Name, isvc.Spec.ProfileRef, role.Name),
		},
		Spec: corev1.ServiceSpec{
			Selector: selector,
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
// (ClusterIP: None) for per-Pod discovery. Its selector deliberately stays
// unfiltered — selecting every pod of the group is the point of this Service.
func desiredHeadlessService(isvc *aiv1alpha1.InferenceService, role *aiv1alpha1.Role, scheme *runtime.Scheme) *corev1.Service {
	svc := desiredServiceWithSelector(isvc, role, controllerSelectorLabels(isvc.Name, role.Name), scheme)
	svc.Name = fmt.Sprintf("%s-%s-hl", isvc.Name, role.Name)
	svc.Spec.ClusterIP = corev1.ClusterIPNone
	// Mark the headless sibling so the ServiceMonitor's selector can leave it
	// out (see headlessServiceLabelKey).
	svc.Labels[headlessServiceLabelKey] = "true"
	return svc
}

// endpointPortName is the Service port name carrying the service's API — and,
// for the engines this platform runs, their /metrics endpoint. The profile
// names it (endpoint.portName, default http); every role Service declaring a
// port of that name is scraped.
func endpointPortName(profile *aiv1alpha1.InferenceRuntimeProfile) string {
	if profile.Spec.Endpoint.PortName != "" {
		return profile.Spec.Endpoint.PortName
	}
	return DefaultEndpointPortName
}

// monitoredRoles returns the role names whose Services the ServiceMonitor
// selects: every role declaring a Service port named endpointPortName. The
// endpoint role is dropped when another role declares the same port — an
// endpoint role sharing its API port with other roles is the topology's
// aggregation layer (the PD router), whose port answers /metrics with 404 —
// while a sole endpoint role (a standard profile's engine) stays scraped.
func monitoredRoles(profile *aiv1alpha1.InferenceRuntimeProfile) []string {
	portName := endpointPortName(profile)
	names := make([]string, 0, len(profile.Spec.Roles))
	for i := range profile.Spec.Roles {
		role := &profile.Spec.Roles[i]
		if role.Service == nil {
			continue
		}
		if slices.ContainsFunc(role.Service.Ports, func(p aiv1alpha1.ServicePort) bool { return p.Name == portName }) {
			names = append(names, role.Name)
		}
	}
	if len(names) > 1 {
		names = slices.DeleteFunc(names, func(name string) bool { return name == profile.Spec.Endpoint.Role })
	}
	slices.Sort(names)
	return names
}

// desiredServiceMonitor builds the ServiceMonitor scraping the role Services of
// this service. It lives in the service's own namespace and selects only from
// it, so one service's monitor can never reach another's Services.
func desiredServiceMonitor(isvc *aiv1alpha1.InferenceService, profile *aiv1alpha1.InferenceRuntimeProfile, scheme *runtime.Scheme) *monitoringv1.ServiceMonitor {
	matchExpressions := []metav1.LabelSelectorRequirement{{
		Key:      headlessServiceLabelKey,
		Operator: metav1.LabelSelectorOpDoesNotExist,
	}}
	// An empty In list is not a valid label requirement, so leave the
	// expression out when no role declares the port; nothing would be scraped
	// anyway.
	if roles := monitoredRoles(profile); len(roles) > 0 {
		matchExpressions = append(matchExpressions, metav1.LabelSelectorRequirement{
			Key:      roleLabelKey,
			Operator: metav1.LabelSelectorOpIn,
			Values:   roles,
		})
	}
	sm := &monitoringv1.ServiceMonitor{
		ObjectMeta: metav1.ObjectMeta{
			Name:      isvc.Name,
			Namespace: isvc.Namespace,
			Labels: map[string]string{
				inferenceServiceLabelKey: isvc.Name,
				managedByLabelKey:        managedByValue,
				observabilityPartOfKey:   observabilityPartOfValue,
			},
		},
		Spec: monitoringv1.ServiceMonitorSpec{
			NamespaceSelector: monitoringv1.NamespaceSelector{MatchNames: []string{isvc.Namespace}},
			Selector: metav1.LabelSelector{
				MatchLabels: map[string]string{
					inferenceServiceLabelKey: isvc.Name,
					managedByLabelKey:        managedByValue,
				},
				MatchExpressions: matchExpressions,
			},
			Endpoints: []monitoringv1.Endpoint{{
				Port: endpointPortName(profile),
				Path: "/metrics",
				// Prometheus-operator injects only `job` by default; the
				// SGLang PD dashboards' $service variable reads `service`.
				// The action is spelled out because the CRD defaults it to
				// "replace", and serviceMonitorNeedsUpdate compares endpoints
				// exactly — an omitted action would rewrite the object on
				// every reconcile.
				RelabelConfigs: []monitoringv1.RelabelConfig{{
					SourceLabels: []monitoringv1.LabelName{"__meta_kubernetes_service_name"},
					TargetLabel:  "service",
					Action:       "replace",
				}},
			}},
		},
	}
	_ = ctrl.SetControllerReference(isvc, sm, scheme)
	return sm
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
