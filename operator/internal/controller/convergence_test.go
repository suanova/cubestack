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

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// convergenceReconciler returns a reconciler with the gateway flags set.
func convergenceReconciler() *InferenceServiceReconciler {
	return &InferenceServiceReconciler{Client: k8sClient, Scheme: testScheme, GatewayDomain: testGatewayDomain, GatewayName: testGatewayName, GatewayNamespace: testGatewayNamespace}
}

// reconcileConvergence reconciles the isvc directly, retrying the conflict the
// suite's manager can cause on the status write it runs concurrently.
func reconcileConvergence(name string) error {
	r := convergenceReconciler()
	var err error
	for range 3 {
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: name, Namespace: testNamespace}})
		if err == nil || !apierrors.IsConflict(err) {
			return err
		}
	}
	return err
}

// convergenceISVC creates the fully resolvable fixture — model version, render
// profile with an endpoint-role Service, asset ConfigMap and isvc — shared by
// the convergence specs.
func convergenceISVC(name string, publish bool) {
	mv := validModelVersion(name + "-mv")
	Expect(k8sClient.Create(ctx, mv)).To(Succeed())
	irp := validRenderProfile(name + "-prof")
	irp.Spec.Roles[0].PodTemplate.Env = nil
	irp.Spec.Roles[0].PodTemplate.Mounts = nil
	irp.Spec.Roles[0].Service = &aiv1alpha1.RoleService{
		Ports: []aiv1alpha1.ServicePort{{Name: testPortName, Port: 8001, TargetPort: ptrTo(intstr.FromString(testPortName))}},
	}
	irp.Spec.Endpoint = aiv1alpha1.EndpointSpec{Role: testApplyRouterRole, PortName: testPortName}
	Expect(k8sClient.Create(ctx, irp)).To(Succeed())
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: name + "-prof-cm", Namespace: systemNamespace},
		Immutable:  ptrTo(true),
		Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
	}
	Expect(k8sClient.Create(ctx, cm)).To(Succeed())
	isvc := isvcRefs(name)
	if publish {
		isvc.Spec.Route = &aiv1alpha1.RouteSpec{Publish: true, ModelName: "conv-flash", TimeoutSeconds: ptrTo[int64](30)}
	}
	Expect(k8sClient.Create(ctx, isvc)).To(Succeed())
}

// readyEndpoints creates the ready Endpoints object of the endpoint role's
// Service — envtest runs no endpoint controller, so the specs create it
// directly.
func readyEndpoints(name string) {
	//nolint:staticcheck // Endpoints is deprecated in v1.33+ but still served; the check reads ready backends from it (design §3.3).
	ep := &corev1.Endpoints{
		ObjectMeta: metav1.ObjectMeta{Name: name + "-router", Namespace: testNamespace},
		Subsets:    []corev1.EndpointSubset{{Addresses: []corev1.EndpointAddress{{IP: testEndpointIP}}}},
	}
	Expect(k8sClient.Create(ctx, ep)).To(Succeed())
}

var _ = Describe("convergence", func() {
	BeforeEach(func() { ensureSystemNamespace() })

	It("reports EndpointReady, Ready, Converged and RouteReady NotPublished for an internal service", func() {
		name := "conv-internal"
		convergenceISVC(name, false)

		Expect(reconcileConvergence(name)).To(Succeed())

		// The endpoint Service and ready Endpoints exist → EndpointReady.
		readyEndpoints(name)

		Expect(reconcileConvergence(name)).To(Succeed())

		got := &aiv1alpha1.InferenceService{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, got)).To(Succeed())
		Expect(meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionEndpointReady).Status).To(Equal(metav1.ConditionTrue))
		Expect(got.Status.Endpoint.Internal).To(Equal(name + "-router.default.svc:8001"))
		// publish=false → RouteReady True/NotPublished, no route, no public.
		Expect(meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRouteReady).Reason).To(Equal("NotPublished"))
		Expect(got.Status.Endpoint.Public).To(BeEmpty())
		route := &gatewayv1.HTTPRoute{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-route", Namespace: testNamespace}, route))).To(BeTrue())
		// The workload has no ready replicas yet (envtest runs no pod
		// controller) → Ready false, Progressing true (Reconciling).
		Expect(meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionReady).Status).To(Equal(metav1.ConditionFalse))
		Expect(meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionProgressing).Status).To(Equal(metav1.ConditionTrue))
	})

	It("publishes an HTTPRoute for a published service with a ready endpoint", func() {
		name := "conv-publish"
		convergenceISVC(name, true)

		Expect(reconcileConvergence(name)).To(Succeed())
		readyEndpoints(name)

		// The suite's manager reconciles the same isvc without the gateway
		// flags, so the route it publishes (empty hostname) can race this
		// spec's — poll the reconcile + assertions until they win.
		Eventually(func(g Gomega) {
			g.Expect(reconcileConvergence(name)).To(Succeed())
			route := &gatewayv1.HTTPRoute{}
			g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-route", Namespace: testNamespace}, route)).To(Succeed())
			g.Expect(route.Spec.Hostnames).To(Equal([]gatewayv1.Hostname{"conv-flash.example.com"}))
			got := &aiv1alpha1.InferenceService{}
			g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, got)).To(Succeed())
			g.Expect(meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionRouteReady).Status).To(Equal(metav1.ConditionTrue))
			g.Expect(got.Status.Endpoint.Public).To(Equal("https://conv-flash.example.com"))
		}, "15s", "200ms").Should(Succeed())
	})

	It("keeps Ready and reports Progressing converged when the render fails", func() {
		// Design §3.3: on a failed render the desired config is not written, so
		// Progressing is False (nothing in flight) while Ready keeps reflecting
		// the running deployment.
		name := "conv-renderfail"
		convergenceISVC(name, false)

		// First successful apply creates the workload; the ready Endpoints and
		// a ready Deployment converge Ready to true.
		Expect(reconcileConvergence(name)).To(Succeed())
		readyEndpoints(name)
		dep := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-router", Namespace: testNamespace}, dep)).To(Succeed())
		dep.Status.Replicas = 1 // the status validation requires readyReplicas <= replicas
		dep.Status.ReadyReplicas = 1
		Expect(k8sClient.Status().Update(ctx, dep)).To(Succeed())
		Expect(reconcileConvergence(name)).To(Succeed())

		got := &aiv1alpha1.InferenceService{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, got)).To(Succeed())
		Expect(meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionReady).Status).To(Equal(metav1.ConditionTrue))
		Expect(meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionProgressing).Reason).To(Equal("Converged"))

		// A bad override breaks the render: the applied-result conditions go,
		// Ready survives, Progressing reports nothing in flight.
		current := &aiv1alpha1.InferenceService{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, current)).To(Succeed())
		current.Spec.Overrides = map[string]apiextensionsv1.JSON{testOverrideMode: {Raw: []byte(`"invalid"`)}}
		Expect(k8sClient.Update(ctx, current)).To(Succeed())
		Expect(reconcileConvergence(name)).To(Succeed())

		got2 := &aiv1alpha1.InferenceService{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, got2)).To(Succeed())
		Expect(meta.FindStatusCondition(got2.Status.Conditions, aiv1alpha1.ConditionRendered).Status).To(Equal(metav1.ConditionFalse))
		Expect(meta.FindStatusCondition(got2.Status.Conditions, aiv1alpha1.ConditionWorkloadsApplied)).To(BeNil())
		Expect(meta.FindStatusCondition(got2.Status.Conditions, aiv1alpha1.ConditionEndpointReady)).To(BeNil())
		Expect(meta.FindStatusCondition(got2.Status.Conditions, aiv1alpha1.ConditionRouteReady)).To(BeNil())
		Expect(meta.FindStatusCondition(got2.Status.Conditions, aiv1alpha1.ConditionReady).Status).To(Equal(metav1.ConditionTrue))
		Expect(meta.FindStatusCondition(got2.Status.Conditions, aiv1alpha1.ConditionProgressing).Status).To(Equal(metav1.ConditionFalse))
		Expect(got2.Status.Roles).To(BeEmpty())
	})
})
