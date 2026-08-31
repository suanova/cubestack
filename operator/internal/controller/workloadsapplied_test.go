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
	leaderworkersetv1 "sigs.k8s.io/lws/api/leaderworkerset/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

func reconcileISVC(ctx context.Context, name string) (reconcile.Result, error) {
	return reconcileISVCInNamespace(ctx, name, testNamespace)
}

func reconcileISVCInNamespace(ctx context.Context, name, ns string) (reconcile.Result, error) {
	r := &InferenceServiceReconciler{Client: k8sClient, Scheme: testScheme}
	var res reconcile.Result
	var err error
	for range 3 {
		res, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: name, Namespace: ns}})
		if err == nil || !apierrors.IsConflict(err) {
			return res, err
		}
		// The suite's manager reconciles the same isvc concurrently and can
		// win the status write, bumping the resourceVersion mid-reconcile —
		// the only conflict source these direct-call specs expect. Retry on
		// a fresh object so the direct call's apply decision still lands.
	}
	return res, err
}

// isvcRefs returns an isvc referencing the fixture model version <name>-mv and
// profile <name>-prof created by the WorkloadsApplied specs.
func isvcRefs(name string) *aiv1alpha1.InferenceService {
	return &aiv1alpha1.InferenceService{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		Spec:       aiv1alpha1.InferenceServiceSpec{ModelRef: name + "-mv", ProfileRef: name + "-prof"},
	}
}

var _ = Describe("WorkloadsApplied", func() {
	BeforeEach(func() { ensureSystemNamespace() })

	It("applies workloads and reports WorkloadsApplied true with full roles status", func() {
		name := "wa-full"
		mv := validModelVersion(name + "-mv") // HostPath storage
		Expect(k8sClient.Create(ctx, mv)).To(Succeed())
		irp := validRenderProfile(name + "-prof")
		irp.Spec.Roles[0].PodTemplate.Env = nil
		irp.Spec.Roles[0].PodTemplate.Mounts = nil
		Expect(k8sClient.Create(ctx, irp)).To(Succeed())
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-prof-cm", Namespace: systemNamespace},
			Immutable:  ptrTo(true),
			Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
		}
		Expect(k8sClient.Create(ctx, cm)).To(Succeed())
		Expect(k8sClient.Create(ctx, isvcRefs(name))).To(Succeed())

		_, err := reconcileISVC(ctx, name)
		Expect(err).NotTo(HaveOccurred())

		isvc := &aiv1alpha1.InferenceService{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, isvc)).To(Succeed())
		Expect(meta.FindStatusCondition(isvc.Status.Conditions, aiv1alpha1.ConditionWorkloadsApplied).Status).To(Equal(metav1.ConditionTrue))
		Expect(isvc.Status.Roles).To(HaveLen(1))
		Expect(isvc.Status.Roles[0].Name).To(Equal(testApplyRouterRole))
		Expect(isvc.Status.Roles[0].WorkloadName).To(Equal(name + "-router"))
		Expect(isvc.Status.Roles[0].ServiceName).To(Equal(name + "-router"))
		Expect(isvc.Status.Profile.Revision).NotTo(BeEmpty())

		dep := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-router", Namespace: testNamespace}, dep)).To(Succeed())
		Expect(dep.Spec.Template.Annotations[templateHashAnnotationKey]).NotTo(BeEmpty())
	})

	It("waits for dependencies with WorkloadsApplied false and WaitingForDependencies", func() {
		name := "wa-gate"
		mv := validModelVersion(name + "-mv")
		Expect(k8sClient.Create(ctx, mv)).To(Succeed())
		irp := validRenderProfile(name + "-prof")
		base := irp.Spec.Roles[0].PodTemplate
		base.Env = nil
		base.Mounts = nil
		irp.Spec.Roles = []aiv1alpha1.Role{
			{Name: testApplyPrefillRole, Workload: aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindLeaderWorkerSet, Group: &aiv1alpha1.WorkloadGroup{Size: intstr.FromInt(1), StartupPolicy: aiv1alpha1.StartupPolicyLeaderCreated}}, PodTemplate: base},
			{Name: testApplyRouterRole, DependsOn: []string{testApplyPrefillRole}, Workload: aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindDeployment}, PodTemplate: base},
		}
		irp.Spec.Endpoint.Role = testApplyRouterRole
		Expect(k8sClient.Create(ctx, irp)).To(Succeed())
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-prof-cm", Namespace: systemNamespace},
			Immutable:  ptrTo(true),
			Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
		}
		Expect(k8sClient.Create(ctx, cm)).To(Succeed())
		Expect(k8sClient.Create(ctx, isvcRefs(name))).To(Succeed())

		_, err := reconcileISVC(ctx, name)
		Expect(err).NotTo(HaveOccurred())

		isvc := &aiv1alpha1.InferenceService{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, isvc)).To(Succeed())
		cond := meta.FindStatusCondition(isvc.Status.Conditions, aiv1alpha1.ConditionWorkloadsApplied)
		Expect(cond.Status).To(Equal(metav1.ConditionFalse))
		Expect(cond.Reason).To(Equal("WaitingForDependencies"))

		// prefill exists with the group size from the profile, router does not
		lws := &leaderworkersetv1.LeaderWorkerSet{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-prefill", Namespace: testNamespace}, lws)).To(Succeed())
		Expect(*lws.Spec.LeaderWorkerTemplate.Size).To(Equal(int32(1)))
		dep := &appsv1.Deployment{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-router", Namespace: testNamespace}, dep))).To(BeTrue())

		// prefill becomes ready → next reconcile applies router
		lws.Status.ReadyReplicas = 1
		Expect(k8sClient.Status().Update(ctx, lws)).To(Succeed())
		_, err = reconcileISVC(ctx, name)
		Expect(err).NotTo(HaveOccurred())
		isvc2 := &aiv1alpha1.InferenceService{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, isvc2)).To(Succeed())
		Expect(meta.FindStatusCondition(isvc2.Status.Conditions, aiv1alpha1.ConditionWorkloadsApplied).Status).To(Equal(metav1.ConditionTrue))
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-router", Namespace: testNamespace}, dep)).To(Succeed())
	})

	It("scales instead of rolling out when only an override changes", func() {
		// The profile wires workload.replicas to {{ overrides.prefillReplicas }}
		// (validRenderProfile): an override change that only affects replicas
		// must keep the template-hash unchanged and scale (design §5.1 scale
		// row), not roll out.
		name := "wa-override-scale"
		mv := validModelVersion(name + "-mv")
		Expect(k8sClient.Create(ctx, mv)).To(Succeed())
		irp := validRenderProfile(name + "-prof")
		irp.Spec.Roles[0].PodTemplate.Env = nil
		irp.Spec.Roles[0].PodTemplate.Mounts = nil
		Expect(k8sClient.Create(ctx, irp)).To(Succeed())
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-prof-cm", Namespace: systemNamespace},
			Immutable:  ptrTo(true),
			Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
		}
		Expect(k8sClient.Create(ctx, cm)).To(Succeed())
		Expect(k8sClient.Create(ctx, isvcRefs(name))).To(Succeed()) // prefillReplicas defaults to 1

		_, err := reconcileISVC(ctx, name)
		Expect(err).NotTo(HaveOccurred())

		dep := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-router", Namespace: testNamespace}, dep)).To(Succeed())
		Expect(*dep.Spec.Replicas).To(Equal(int32(1)))
		hash := dep.Spec.Template.Annotations[templateHashAnnotationKey]
		Expect(hash).NotTo(BeEmpty())
		ovHash := dep.Spec.Template.Annotations[templateHashOverridesAnnotationKey]

		// prefillReplicas 1 → 2: replicas-only, the hash must not change.
		Eventually(func(g Gomega) {
			current := &aiv1alpha1.InferenceService{}
			g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, current)).To(Succeed())
			current.Spec.Overrides = map[string]apiextensionsv1.JSON{testOverridePrefillReplicas: {Raw: []byte("2")}}
			g.Expect(k8sClient.Update(ctx, current)).To(Succeed())
		}, "15s", "200ms").Should(Succeed())

		_, err = reconcileISVC(ctx, name)
		Expect(err).NotTo(HaveOccurred())

		after := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-router", Namespace: testNamespace}, after)).To(Succeed())
		Expect(after.Spec.Template.Annotations[templateHashAnnotationKey]).To(Equal(hash))
		// A scale does not rewrite the pod template, so the diagnostic
		// annotations are untouched as well: nothing rolled out.
		Expect(after.Spec.Template.Annotations[templateHashOverridesAnnotationKey]).To(Equal(ovHash))
		Expect(*after.Spec.Replicas).To(Equal(int32(2)))

		isvc := &aiv1alpha1.InferenceService{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, isvc)).To(Succeed())
		Expect(meta.FindStatusCondition(isvc.Status.Conditions, aiv1alpha1.ConditionWorkloadsApplied).Status).To(Equal(metav1.ConditionTrue))
	})

	It("applies an LWS group size override without a rollout", func() {
		// A group size driven by {{ overrides.* }} lives in the workload
		// structure (leaderWorkerTemplate.size), not the pod template: the
		// update decision must not skip it when the hash and replicas are
		// unchanged (design §3.2: size may be an override template).
		name := "wa-group-size"
		mv := validModelVersion(name + "-mv")
		Expect(k8sClient.Create(ctx, mv)).To(Succeed())
		irp := validRenderProfile(name + "-prof")
		irp.Spec.Overrides = append(irp.Spec.Overrides, aiv1alpha1.Override{
			Name: testOverrideGroupSize, Type: aiv1alpha1.OverrideTypeInteger,
			Min: ptrTo[int64](1), Max: ptrTo[int64](8),
			Default: &apiextensionsv1.JSON{Raw: []byte("1")},
		})
		base := irp.Spec.Roles[0].PodTemplate
		base.Env = nil
		base.Mounts = nil
		irp.Spec.Roles = []aiv1alpha1.Role{
			{
				Name: testApplyPrefillRole,
				Workload: aiv1alpha1.Workload{
					Kind:     aiv1alpha1.WorkloadKindLeaderWorkerSet,
					Replicas: ptrTo(intstr.FromInt(1)),
					Group: &aiv1alpha1.WorkloadGroup{
						Size:          intstr.FromString("{{ overrides." + testOverrideGroupSize + " }}"),
						StartupPolicy: aiv1alpha1.StartupPolicyLeaderCreated,
					},
				},
				PodTemplate: base,
			},
		}
		irp.Spec.Endpoint.Role = testApplyPrefillRole
		Expect(k8sClient.Create(ctx, irp)).To(Succeed())
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-prof-cm", Namespace: systemNamespace},
			Immutable:  ptrTo(true),
			Data:       map[string]string{testConfigMapDataKey: testConfigMapDataValue},
		}
		Expect(k8sClient.Create(ctx, cm)).To(Succeed())
		Expect(k8sClient.Create(ctx, isvcRefs(name))).To(Succeed()) // groupSize defaults to 1

		_, err := reconcileISVC(ctx, name)
		Expect(err).NotTo(HaveOccurred())

		lws := &leaderworkersetv1.LeaderWorkerSet{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-prefill", Namespace: testNamespace}, lws)).To(Succeed())
		Expect(*lws.Spec.LeaderWorkerTemplate.Size).To(Equal(int32(1)))
		hash := lws.Spec.LeaderWorkerTemplate.WorkerTemplate.Annotations[templateHashAnnotationKey]
		Expect(hash).NotTo(BeEmpty())
		beforeRV := lws.ResourceVersion

		// groupSize 1 → 2: structure-only change, the workload object must be
		// updated without a rollout.
		Eventually(func(g Gomega) {
			current := &aiv1alpha1.InferenceService{}
			g.Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, current)).To(Succeed())
			current.Spec.Overrides = map[string]apiextensionsv1.JSON{testOverrideGroupSize: {Raw: []byte("2")}}
			g.Expect(k8sClient.Update(ctx, current)).To(Succeed())
		}, "15s", "200ms").Should(Succeed())

		_, err = reconcileISVC(ctx, name)
		Expect(err).NotTo(HaveOccurred())

		after := &leaderworkersetv1.LeaderWorkerSet{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-prefill", Namespace: testNamespace}, after)).To(Succeed())
		Expect(*after.Spec.LeaderWorkerTemplate.Size).To(Equal(int32(2)))
		Expect(after.Spec.LeaderWorkerTemplate.WorkerTemplate.Annotations[templateHashAnnotationKey]).To(Equal(hash))
		Expect(after.ResourceVersion).NotTo(Equal(beforeRV))
	})
})
