package controller

import (
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	leaderworkersetv1 "sigs.k8s.io/lws/api/leaderworkerset/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

var _ = Describe("LeaderWorkerSet CRD", func() {
	It("creates and reads a LeaderWorkerSet", func() {
		lws := &leaderworkersetv1.LeaderWorkerSet{
			ObjectMeta: metav1.ObjectMeta{Name: "lws-smoke", Namespace: testNamespace},
			Spec: leaderworkersetv1.LeaderWorkerSetSpec{
				StartupPolicy: leaderworkersetv1.LeaderCreatedStartupPolicy,
				Replicas:      ptrTo(int32(1)),
				LeaderWorkerTemplate: leaderworkersetv1.LeaderWorkerTemplate{
					Size: ptrTo(int32(1)),
					WorkerTemplate: corev1.PodTemplateSpec{
						Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: mainContainerName, Image: "registry.local/smoke:v1"}}},
					},
				},
				RolloutStrategy: leaderworkersetv1.RolloutStrategy{
					Type: leaderworkersetv1.RollingUpdateStrategyType,
					RollingUpdateConfiguration: &leaderworkersetv1.RollingUpdateConfiguration{
						MaxSurge:       intstr.FromInt(0),
						MaxUnavailable: intstr.FromInt(1),
					},
				},
			},
		}
		Expect(k8sClient.Create(ctx, lws)).To(Succeed())
		got := &leaderworkersetv1.LeaderWorkerSet{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: lws.Name, Namespace: testNamespace}, got)).To(Succeed())
		Expect(got.Spec.LeaderWorkerTemplate.WorkerTemplate.Spec.Containers[0].Image).To(Equal("registry.local/smoke:v1"))
		Expect(k8sClient.Delete(ctx, lws)).To(Succeed())
	})
})

var _ = Describe("enqueueForOwnedLWS", func() {
	It("maps an owned LeaderWorkerSet to its InferenceService", func() {
		owner := &aiv1alpha1.InferenceService{
			ObjectMeta: metav1.ObjectMeta{Name: "svc-watch", Namespace: testNamespace},
			Spec:       aiv1alpha1.InferenceServiceSpec{ModelRef: "model-ref", ProfileRef: "watch-prof"},
		}
		Expect(k8sClient.Create(ctx, owner)).To(Succeed())
		lws := &leaderworkersetv1.LeaderWorkerSet{
			ObjectMeta: metav1.ObjectMeta{
				Name:      "svc-watch-role",
				Namespace: testNamespace,
				OwnerReferences: []metav1.OwnerReference{{
					APIVersion: "ai.cubestack.io/v1alpha1", Kind: "InferenceService",
					Name: owner.Name, UID: owner.UID, Controller: ptrTo(true),
				}},
			},
		}
		r := applyReconciler()
		reqs := r.enqueueForOwnedLWS(ctx, lws)
		Expect(reqs).To(Equal([]reconcile.Request{{NamespacedName: types.NamespacedName{Namespace: testNamespace, Name: "svc-watch"}}}))
		// A foreign LWS produces nothing.
		foreign := lws.DeepCopy()
		foreign.Name = "other-role"
		foreign.OwnerReferences = nil
		Expect(r.enqueueForOwnedLWS(ctx, foreign)).To(BeEmpty())
	})
})
