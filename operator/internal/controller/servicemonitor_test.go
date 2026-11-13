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

	monitoringv1 "github.com/prometheus-operator/prometheus-operator/pkg/apis/monitoring/v1"

	corev1 "k8s.io/api/core/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// The observability contract (observability/docs/dependencies.md §1) fixes the
// label keys the Prometheus side selects on; the specs below assert them as
// literals so a rename on either side fails here.
const (
	testObservabilityPartOfKey   = "app.kubernetes.io/part-of"
	testObservabilityPartOfValue = "cubestack-observability"
)

// smProfile returns a render profile whose single router role declares a
// Service with the shared test port name, so the controller creates both the
// role Service and the ServiceMonitor that selects it.
func smProfile(name string, headless bool) *aiv1alpha1.InferenceRuntimeProfile {
	irp := validRenderProfile(name)
	irp.Spec.Roles[0].PodTemplate.Env = nil
	irp.Spec.Roles[0].PodTemplate.Mounts = nil
	irp.Spec.Roles[0].Service = &aiv1alpha1.RoleService{
		Ports: []aiv1alpha1.ServicePort{{
			Name:       testPortName,
			Port:       8001,
			TargetPort: ptrTo(intstr.FromString(testPortName)),
		}},
	}
	if headless {
		irp.Spec.Roles[0].Service.Headless = ptrTo(true)
	}
	return irp
}

// rolePort names one role of a profileWithServices fixture and the Service
// port it declares; an empty port means the role declares no Service.
type rolePort struct{ name, port string }

// profileWithServices returns a profile whose roles are exactly the given
// ones, with endpoint.role set to endpointRole. It exercises the
// ServiceMonitor role selection without a cluster.
func profileWithServices(endpointRole string, roles ...rolePort) *aiv1alpha1.InferenceRuntimeProfile {
	irp := validInferenceRuntimeProfile("monitored-roles")
	irp.Spec.Endpoint.Role = endpointRole
	irp.Spec.Roles = nil
	for _, rp := range roles {
		role := aiv1alpha1.Role{Name: rp.name}
		if rp.port != "" {
			role.Service = &aiv1alpha1.RoleService{
				Ports: []aiv1alpha1.ServicePort{{Name: rp.port, Port: 8000}},
			}
		}
		irp.Spec.Roles = append(irp.Spec.Roles, role)
	}
	return irp
}

var _ = Describe("ServiceMonitor", func() {
	BeforeEach(func() { ensureSystemNamespace() })

	It("creates a ServiceMonitor selecting the role Service but not its headless sibling", func() {
		name := "sm-select"
		Expect(k8sClient.Create(ctx, validModelVersion(name+"-mv"))).To(Succeed())
		Expect(k8sClient.Create(ctx, smProfile(name+"-prof", true))).To(Succeed())
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-prof-cm", Namespace: systemNamespace},
			Immutable:  ptrTo(true),
			Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
		}
		Expect(k8sClient.Create(ctx, cm)).To(Succeed())
		Expect(k8sClient.Create(ctx, isvcRefs(name))).To(Succeed())

		_, err := reconcileISVC(ctx, name)
		Expect(err).NotTo(HaveOccurred())

		sm := &monitoringv1.ServiceMonitor{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, sm)).To(Succeed())

		// Locating labels: the IS label ties the object back to its CR, the
		// observability value is what the Prometheus serviceMonitorSelector
		// matches on (installer-requirements.md §1.2).
		Expect(sm.Labels).To(HaveKeyWithValue("ai.cubestack.io/inference-service", name))
		Expect(sm.Labels).To(HaveKeyWithValue(testObservabilityPartOfKey, testObservabilityPartOfValue))
		Expect(sm.Spec.NamespaceSelector.MatchNames).To(Equal([]string{testNamespace}))
		Expect(sm.Spec.Endpoints).To(HaveLen(1))
		Expect(sm.Spec.Endpoints[0].Port).To(Equal(testPortName))
		Expect(sm.Spec.Endpoints[0].Path).To(Equal("/metrics"))

		owner := metav1.GetControllerOf(sm)
		Expect(owner).NotTo(BeNil())
		Expect(owner.Name).To(Equal(name))

		// The headless sibling exists and carries the same IS label, so only
		// the selector's headless exclusion keeps it out of the scrape set:
		// its endpoints include the workers, which serve no role endpoint.
		hl := &corev1.Service{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-" + testApplyRouterRole + "-hl", Namespace: testNamespace}, hl)).To(Succeed())

		selector, err := metav1.LabelSelectorAsSelector(&sm.Spec.Selector)
		Expect(err).NotTo(HaveOccurred())
		svcs := &corev1.ServiceList{}
		Expect(k8sClient.List(ctx, svcs,
			client.InNamespace(testNamespace),
			client.MatchingLabelsSelector{Selector: selector})).To(Succeed())
		names := make([]string, 0, len(svcs.Items))
		for i := range svcs.Items {
			names = append(names, svcs.Items[i].Name)
		}
		Expect(names).To(ConsistOf(name + "-" + testApplyRouterRole))
	})

	It("creates no ServiceMonitor when the CRD is not installed, and still applies the workload", func() {
		name := "sm-unavailable"
		Expect(k8sClient.Create(ctx, validModelVersion(name+"-mv"))).To(Succeed())
		Expect(k8sClient.Create(ctx, smProfile(name+"-prof", false))).To(Succeed())
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-prof-cm", Namespace: systemNamespace},
			Immutable:  ptrTo(true),
			Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
		}
		Expect(k8sClient.Create(ctx, cm)).To(Succeed())
		Expect(k8sClient.Create(ctx, isvcRefs(name))).To(Succeed())

		// A cluster without the prometheus-operator CRDs: the reconciler must
		// skip the ServiceMonitor and leave the rest of the pipeline intact.
		r := &InferenceServiceReconciler{Client: k8sClient, Scheme: testScheme, RESTMapper: meta.NewDefaultRESTMapper(nil)}
		_, err := reconcileWith(ctx, r, name, testNamespace)
		Expect(err).NotTo(HaveOccurred())

		sm := &monitoringv1.ServiceMonitor{}
		Expect(apierrors.IsNotFound(
			k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, sm))).To(BeTrue())

		svc := &corev1.Service{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-" + testApplyRouterRole, Namespace: testNamespace}, svc)).To(Succeed())
	})

	It("creates the ServiceMonitor on a later pass when the CRD appears after startup", func() {
		name := "sm-late-crd"
		Expect(k8sClient.Create(ctx, validModelVersion(name+"-mv"))).To(Succeed())
		Expect(k8sClient.Create(ctx, smProfile(name+"-prof", false))).To(Succeed())
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-prof-cm", Namespace: systemNamespace},
			Immutable:  ptrTo(true),
			Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
		}
		Expect(k8sClient.Create(ctx, cm)).To(Succeed())
		Expect(k8sClient.Create(ctx, isvcRefs(name))).To(Succeed())

		// The controller started before prometheus, so its mapper has never seen
		// the ServiceMonitor kind.
		mapper := meta.NewDefaultRESTMapper(nil)
		r := &InferenceServiceReconciler{Client: k8sClient, Scheme: testScheme, RESTMapper: mapper}

		_, err := reconcileWith(ctx, r, name, testNamespace)
		Expect(err).NotTo(HaveOccurred())
		sm := &monitoringv1.ServiceMonitor{}
		Expect(apierrors.IsNotFound(
			k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, sm))).To(BeTrue())

		// The prometheus component lands later. The manager's mapper is dynamic
		// (it re-discovers a missing kind), so the probe on the next pass sees
		// the CRD and the monitor is created without an operator restart.
		mapper.Add(monitoringv1.SchemeGroupVersion.WithKind("ServiceMonitor"), meta.RESTScopeNamespace)
		_, err = reconcileWith(ctx, r, name, testNamespace)
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, sm)).To(Succeed())
	})

	It("repairs an externally edited selector", func() {
		name := "sm-repair"
		Expect(k8sClient.Create(ctx, validModelVersion(name+"-mv"))).To(Succeed())
		Expect(k8sClient.Create(ctx, smProfile(name+"-prof", false))).To(Succeed())
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-prof-cm", Namespace: systemNamespace},
			Immutable:  ptrTo(true),
			Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
		}
		Expect(k8sClient.Create(ctx, cm)).To(Succeed())
		Expect(k8sClient.Create(ctx, isvcRefs(name))).To(Succeed())

		_, err := reconcileISVC(ctx, name)
		Expect(err).NotTo(HaveOccurred())
		sm := &monitoringv1.ServiceMonitor{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, sm)).To(Succeed())

		// The selector is controller-owned: an edit that would point the scrape
		// at another service's Services must not survive the next reconcile.
		sm.Spec.Selector.MatchLabels["ai.cubestack.io/inference-service"] = "somebody-else"
		Expect(k8sClient.Update(ctx, sm)).To(Succeed())

		_, err = reconcileISVC(ctx, name)
		Expect(err).NotTo(HaveOccurred())
		repaired := &monitoringv1.ServiceMonitor{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, repaired)).To(Succeed())
		Expect(repaired.Spec.Selector.MatchLabels).To(HaveKeyWithValue("ai.cubestack.io/inference-service", name))
	})

	It("writes the endpoint exactly as authored, so no server default can make every reconcile a rewrite", func() {
		// serviceMonitorNeedsUpdate compares the authored endpoint against the
		// stored one with DeepEqual. A field the API server defaults on read
		// would differ from the desired object on every reconcile, so the
		// controller would rewrite the object forever and, through the Owns()
		// watch, re-enqueue the InferenceService in a self-perpetuating loop.
		// This spec pins the assumption that nothing in it is defaulted.
		name := "sm-no-defaults"
		Expect(k8sClient.Create(ctx, validModelVersion(name+"-mv"))).To(Succeed())
		Expect(k8sClient.Create(ctx, smProfile(name+"-prof", false))).To(Succeed())
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-prof-cm", Namespace: systemNamespace},
			Immutable:  ptrTo(true),
			Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
		}
		Expect(k8sClient.Create(ctx, cm)).To(Succeed())
		Expect(k8sClient.Create(ctx, isvcRefs(name))).To(Succeed())

		_, err := reconcileISVC(ctx, name)
		Expect(err).NotTo(HaveOccurred())

		sm := &monitoringv1.ServiceMonitor{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, sm)).To(Succeed())
		Expect(sm.Spec.Endpoints).To(Equal([]monitoringv1.Endpoint{{
			Port: testPortName,
			Path: "/metrics",
			// The scrape carries the Service name as a `service` label: the
			// SGLang PD Grafana dashboard's $service variable reads it, and
			// prometheus-operator injects only `job` on its own.
			RelabelConfigs: []monitoringv1.RelabelConfig{{
				SourceLabels: []monitoringv1.LabelName{"__meta_kubernetes_service_name"},
				TargetLabel:  "service",
				Action:       "replace",
			}},
		}}))
	})
})

var _ = Describe("monitoredRoles", func() {
	It("keeps the endpoint role when it is the only role exposing the port", func() {
		// A standard profile: the single engine role is the endpoint role, so
		// excluding it (as the PD topology's router is excluded) would leave
		// the ServiceMonitor with no target at all.
		p := profileWithServices("engine", rolePort{"engine", testPortName})
		Expect(monitoredRoles(p)).To(Equal([]string{"engine"}))
	})

	It("drops the endpoint role when other roles expose the port", func() {
		// A PD profile: the endpoint role is the CPU-only router in front of
		// the engine roles; its port answers /metrics with 404, so only the
		// engine roles are scraped.
		p := profileWithServices(testApplyRouterRole,
			rolePort{testApplyPrefillRole, testPortName},
			rolePort{testApplyDecodeRole, testPortName},
			rolePort{testApplyRouterRole, testPortName},
		)
		Expect(monitoredRoles(p)).To(Equal([]string{testApplyDecodeRole, testApplyPrefillRole}))
	})

	It("skips roles without a service port of that name", func() {
		p := profileWithServices(testApplyRouterRole,
			rolePort{testApplyPrefillRole, testPortName},
			rolePort{testApplyRouterRole, testPortName},
			rolePort{"tools", "grpc"},
			rolePort{"sidecar", ""},
		)
		Expect(monitoredRoles(p)).To(Equal([]string{testApplyPrefillRole}))
	})
})

var _ = Describe("ServiceMonitorAvailable", func() {
	It("reports false when the mapper does not serve the ServiceMonitor kind", func() {
		mapper := meta.NewDefaultRESTMapper(nil)
		Expect(ServiceMonitorAvailable(mapper)).To(BeFalse())
	})

	It("reports true when the mapper serves the ServiceMonitor kind", func() {
		mapper := meta.NewDefaultRESTMapper(nil)
		mapper.Add(monitoringv1.SchemeGroupVersion.WithKind("ServiceMonitor"), meta.RESTScopeNamespace)
		Expect(ServiceMonitorAvailable(mapper)).To(BeTrue())
	})
})

var _ = Describe("enqueueForServiceMonitorCRD", func() {
	It("maps the ServiceMonitor CRD to every InferenceService and no other CRD", func() {
		names := []string{"crd-map-a", "crd-map-b"}
		for _, name := range names {
			Expect(k8sClient.Create(ctx, isvcRefs(name))).To(Succeed())
		}
		defer func() {
			for _, name := range names {
				_ = k8sClient.Delete(ctx, isvcRefs(name))
			}
		}()
		r := &InferenceServiceReconciler{Client: k8sClient, Scheme: testScheme}

		// The matching CRD's creation or deletion re-runs every service: no
		// service object changed, but the probe's answer did.
		matching := &apiextensionsv1.CustomResourceDefinition{
			ObjectMeta: metav1.ObjectMeta{Name: serviceMonitorCRDName},
		}
		requests := r.enqueueForServiceMonitorCRD(ctx, matching)
		got := make([]string, 0, len(requests))
		for _, req := range requests {
			got = append(got, req.Namespace+"/"+req.Name)
		}
		Expect(got).To(ContainElements(testNamespace+"/crd-map-a", testNamespace+"/crd-map-b"))

		// Any other CRD churn must not enqueue the inference controller.
		other := &apiextensionsv1.CustomResourceDefinition{
			ObjectMeta: metav1.ObjectMeta{Name: "widgets.example.com"},
		}
		Expect(r.enqueueForServiceMonitorCRD(ctx, other)).To(BeEmpty())
	})
})
