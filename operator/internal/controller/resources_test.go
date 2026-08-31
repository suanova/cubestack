package controller

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	leaderworkersetv1 "sigs.k8s.io/lws/api/leaderworkerset/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/internal/renderer"
)

const (
	testIsvcName    = "svc"
	testRolePrefill = "prefill"
	testRoleImage   = "img:v1"
	testPortName    = "http"
)

func testSchemeForResources() *runtime.Scheme {
	s := runtime.NewScheme()
	utilruntime.Must(corev1.AddToScheme(s))
	utilruntime.Must(appsv1.AddToScheme(s))
	utilruntime.Must(aiv1alpha1.AddToScheme(s))
	utilruntime.Must(leaderworkersetv1.AddToScheme(s))
	return s
}

var _ = Describe("desired resources", func() {
	isvc := func() *aiv1alpha1.InferenceService {
		return &aiv1alpha1.InferenceService{
			ObjectMeta: metav1.ObjectMeta{Name: testIsvcName, Namespace: testNamespace, UID: "uid-1"},
			Spec:       aiv1alpha1.InferenceServiceSpec{ProfileRef: "prof"},
		}
	}
	role := func() *aiv1alpha1.Role {
		return &aiv1alpha1.Role{
			Name:        testRolePrefill,
			Workload:    aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindLeaderWorkerSet},
			PodTemplate: aiv1alpha1.PodTemplate{Image: testRoleImage},
			Service:     &aiv1alpha1.RoleService{Ports: []aiv1alpha1.ServicePort{{Name: testPortName, Port: 8001, TargetPort: ptrTo(intstr.FromString(testPortName))}}},
		}
	}
	rr := func() *renderer.RenderedRole {
		return &renderer.RenderedRole{Name: testRolePrefill, Replicas: 2, GroupSize: 1}
	}

	It("builds a role Service with selector, ports and ownerRef", func() {
		svc := desiredService(isvc(), role(), testSchemeForResources())
		Expect(svc.Name).To(Equal("svc-prefill"))
		Expect(svc.Namespace).To(Equal(testNamespace))
		Expect(svc.Spec.Selector).To(Equal(map[string]string{
			inferenceServiceLabelKey: testIsvcName, roleLabelKey: testRolePrefill,
		}))
		Expect(svc.Spec.Ports).To(Equal([]corev1.ServicePort{
			{Name: testPortName, Port: 8001, TargetPort: intstr.FromString(testPortName)},
		}))
		Expect(metav1.GetControllerOf(svc).Name).To(Equal(testIsvcName))
		Expect(svc.Labels[managedByLabelKey]).To(Equal(managedByValue))
		Expect(svc.Labels[profileLabelKey]).To(Equal("prof"))
	})

	It("builds a headless Service with ClusterIP None", func() {
		r := role()
		r.Service.Headless = ptrTo(true)
		svc := desiredHeadlessService(isvc(), r, testSchemeForResources())
		Expect(svc.Name).To(Equal("svc-prefill-hl"))
		Expect(svc.Spec.ClusterIP).To(Equal(corev1.ClusterIPNone))
	})

	It("builds a LeaderWorkerSet per the mapping table", func() {
		lws := desiredLWS(isvc(), role(), rr(), corev1.PodSpec{Containers: []corev1.Container{{Name: modelKeyMain, Image: testRoleImage}}}, nil, map[string]string{templateHashAnnotationKey: "h"}, testSchemeForResources())
		Expect(lws.Name).To(Equal("svc-prefill"))
		Expect(*lws.Spec.Replicas).To(Equal(int32(2)))
		Expect(*lws.Spec.LeaderWorkerTemplate.Size).To(Equal(int32(1)))
		Expect(lws.Spec.LeaderWorkerTemplate.RestartPolicy).To(Equal(leaderworkersetv1.RecreateGroupOnPodRestart))
		Expect(lws.Spec.LeaderWorkerTemplate.LeaderTemplate).To(BeNil())
		Expect(lws.Spec.StartupPolicy).To(Equal(leaderworkersetv1.LeaderCreatedStartupPolicy))
		Expect(lws.Spec.RolloutStrategy.Type).To(Equal(leaderworkersetv1.RollingUpdateStrategyType))
		Expect(lws.Spec.RolloutStrategy.RollingUpdateConfiguration.MaxSurge).To(Equal(intstr.FromInt(0)))
		Expect(lws.Spec.RolloutStrategy.RollingUpdateConfiguration.MaxUnavailable).To(Equal(intstr.FromInt(1)))
		Expect(lws.Spec.NetworkConfig.SubdomainPolicy).To(Equal(ptrTo(leaderworkersetv1.SubdomainUniquePerReplica)))
		Expect(lws.Spec.LeaderWorkerTemplate.WorkerTemplate.Annotations[templateHashAnnotationKey]).To(Equal("h"))
		Expect(metav1.GetControllerOf(lws).Name).To(Equal(testIsvcName))
	})

	It("builds a Deployment with selector and fixed strategy", func() {
		d := desiredDeployment(isvc(), role(), rr(), corev1.PodSpec{Containers: []corev1.Container{{Name: modelKeyMain, Image: testRoleImage}}}, nil, nil, testSchemeForResources())
		Expect(d.Name).To(Equal("svc-prefill"))
		Expect(*d.Spec.Replicas).To(Equal(int32(2)))
		Expect(d.Spec.Selector.MatchLabels).To(Equal(map[string]string{
			inferenceServiceLabelKey: testIsvcName, roleLabelKey: testRolePrefill,
		}))
		Expect(d.Spec.Strategy.Type).To(Equal(appsv1.RollingUpdateDeploymentStrategyType))
		Expect(d.Spec.Strategy.RollingUpdate.MaxSurge).To(Equal(ptrTo(intstr.FromInt(0))))
		Expect(d.Spec.Strategy.RollingUpdate.MaxUnavailable).To(Equal(ptrTo(intstr.FromInt(1))))
	})

	It("merges pod labels with the controller selector labels (controller wins)", func() {
		labels, _ := podObjectMeta(testIsvcName, testRolePrefill, aiv1alpha1.PodTemplate{
			Labels: map[string]string{inferenceServiceLabelKey: "foreign", "app": "x"},
		}, nil)
		Expect(labels[inferenceServiceLabelKey]).To(Equal(testIsvcName))
		Expect(labels[roleLabelKey]).To(Equal(testRolePrefill))
		Expect(labels["app"]).To(Equal("x"))
	})
})
