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
	"context"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// testEndpointIP is the backend address used by the endpoint specs.
const testEndpointIP = "10.0.0.1"

func endpointProfile(name string) *aiv1alpha1.InferenceRuntimeProfile {
	p := validRenderProfile(name)
	p.Spec.Roles[0].Service = &aiv1alpha1.RoleService{
		Ports: []aiv1alpha1.ServicePort{{Name: testPortName, Port: 8001, TargetPort: ptrTo(intstr.FromString(testPortName))}},
	}
	p.Spec.Endpoint = aiv1alpha1.EndpointSpec{Role: testApplyRouterRole, PortName: testPortName}
	return p
}

func createEndpointSvc(ctx context.Context, name string) {
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: name + "-router", Namespace: testNamespace},
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{testForeignLabelKey: testRoleRouter},
			Ports:    []corev1.ServicePort{{Name: testPortName, Port: 8001, TargetPort: intstr.FromString(testPortName)}},
		},
	}
	Expect(k8sClient.Create(ctx, svc)).To(Succeed())
}

var _ = Describe("checkEndpoint", func() {
	It("reports the internal endpoint when the Service has a ready backend", func() {
		name := "ep-ready"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		createEndpointSvc(ctx, name)
		//nolint:staticcheck // Endpoints is deprecated in v1.33+ but still served; no endpoint controller runs, so the specs create it directly.
		ep := &corev1.Endpoints{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-router", Namespace: testNamespace},
			Subsets:    []corev1.EndpointSubset{{Addresses: []corev1.EndpointAddress{{IP: testEndpointIP}}}},
		}
		Expect(k8sClient.Create(ctx, ep)).To(Succeed())
		r := applyReconciler()
		check, err := r.checkEndpoint(ctx, mustGetISVC(ctx, name), endpointProfile(name+"-prof"))
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Internal).To(Equal(name + "-router.default.svc:8001"))
		Expect(check.Reason).To(BeEmpty())

		conditions := []metav1.Condition{}
		setEndpointReadyCondition(&conditions, check)
		Expect(meta.FindStatusCondition(conditions, aiv1alpha1.ConditionEndpointReady).Status).To(Equal(metav1.ConditionTrue))
	})

	It("reports EndpointNotReady without ready backend endpoints", func() {
		name := "ep-notready"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		createEndpointSvc(ctx, name)
		//nolint:staticcheck // Endpoints is deprecated in v1.33+ but still served; no endpoint controller runs, so the specs create it directly.
		ep := &corev1.Endpoints{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-router", Namespace: testNamespace},
			//nolint:staticcheck // EndpointSubset is deprecated but still served; a subset without ready addresses is not ready.
			Subsets: []corev1.EndpointSubset{{NotReadyAddresses: []corev1.EndpointAddress{{IP: testEndpointIP}}}},
		}
		Expect(k8sClient.Create(ctx, ep)).To(Succeed())
		r := applyReconciler()
		check, err := r.checkEndpoint(ctx, mustGetISVC(ctx, name), endpointProfile(name+"-prof"))
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Internal).To(BeEmpty())
		Expect(check.Reason).To(Equal("EndpointNotReady"))
	})

	It("reports EndpointPortNotFound when the port name is missing", func() {
		name := "ep-noport"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		createEndpointSvc(ctx, name)
		p := endpointProfile(name + "-prof")
		p.Spec.Endpoint.PortName = "missing"
		r := applyReconciler()
		check, err := r.checkEndpoint(ctx, mustGetISVC(ctx, name), p)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal("EndpointPortNotFound"))
	})

	It("reports EndpointNotReady when the endpoint role has no Service", func() {
		name := "ep-nosvc"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		r := applyReconciler()
		check, err := r.checkEndpoint(ctx, mustGetISVC(ctx, name), endpointProfile(name+"-prof"))
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal("EndpointNotReady"))
	})

	It("reports EndpointRoleNotFound when the endpoint role does not exist", func() {
		name := "ep-norole"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		p := endpointProfile(name + "-prof")
		p.Spec.Endpoint.Role = "ghost"
		r := applyReconciler()
		check, err := r.checkEndpoint(ctx, mustGetISVC(ctx, name), p)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Reason).To(Equal("EndpointRoleNotFound"))
	})

	It("defaults the port name to http", func() {
		name := "ep-defport"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		createEndpointSvc(ctx, name)
		//nolint:staticcheck // Endpoints is deprecated in v1.33+ but still served; no endpoint controller runs, so the specs create it directly.
		ep := &corev1.Endpoints{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-router", Namespace: testNamespace},
			//nolint:staticcheck // EndpointSubset is deprecated but still served; a subset without ready addresses is not ready.
			Subsets: []corev1.EndpointSubset{{Addresses: []corev1.EndpointAddress{{IP: testEndpointIP}}}},
		}
		Expect(k8sClient.Create(ctx, ep)).To(Succeed())
		p := endpointProfile(name + "-prof")
		p.Spec.Endpoint.PortName = "" // defaults to http
		r := applyReconciler()
		check, err := r.checkEndpoint(ctx, mustGetISVC(ctx, name), p)
		Expect(err).NotTo(HaveOccurred())
		Expect(check.Internal).To(Equal(name + "-router.default.svc:8001"))
	})
})
