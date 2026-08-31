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
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	leaderworkersetv1 "sigs.k8s.io/lws/api/leaderworkerset/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/internal/renderer"
)

// Role names and resource-name suffixes shared by the apply specs.
const (
	testApplyRouterSuffix  = "-router"
	testApplyPrefillSuffix = "-prefill"
	testApplyRouterRole    = "router"
	testApplyPrefillRole   = "prefill"
	testApplyModelPath     = "/models/m"
	testForeignLabelKey    = "app"
)

func applyReconciler() *InferenceServiceReconciler {
	return &InferenceServiceReconciler{Client: k8sClient, Scheme: testScheme}
}

func isvcForApply(name string) *aiv1alpha1.InferenceService {
	return &aiv1alpha1.InferenceService{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: testNamespace},
		Spec:       aiv1alpha1.InferenceServiceSpec{ModelRef: "model-ref", ProfileRef: "prof"},
	}
}

// roleResult builds a RenderedRole from a profile role and rendered replicas.
func roleResult(role aiv1alpha1.Role, replicas int64) renderer.RenderedRole {
	return renderer.RenderedRole{Name: role.Name, Replicas: replicas, PodTemplate: role.PodTemplate}
}

func mustGetISVC(ctx context.Context, name string) *aiv1alpha1.InferenceService {
	isvc := &aiv1alpha1.InferenceService{}
	Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, isvc)).To(Succeed())
	return isvc
}

var _ = Describe("applyWorkloads", func() {
	model := func() *aiv1alpha1.ModelVersion {
		return &aiv1alpha1.ModelVersion{Spec: aiv1alpha1.ModelVersionSpec{
			Model: "m", Version: "v1",
			Storage: aiv1alpha1.ModelStorage{
				Strategy: aiv1alpha1.StorageStrategyHostPath,
				HostPath: &aiv1alpha1.HostPathStorage{Path: testApplyModelPath},
			},
		}}
	}

	// pvcModel is the PVC-storage variant of model(): the readiness of
	// model-mounting roles is gated on the model PVC being bound (design §4.3).
	pvcModel := func() *aiv1alpha1.ModelVersion {
		return &aiv1alpha1.ModelVersion{Spec: aiv1alpha1.ModelVersionSpec{
			Model: "m", Version: "v1",
			Storage: aiv1alpha1.ModelStorage{
				Strategy: aiv1alpha1.StorageStrategyPVC,
				PVC: &aiv1alpha1.PVCStorage{
					StorageClassName: "standard", SubPath: "m/v2",
					Capacity: resource.MustParse("1Gi"),
				},
			},
		}}
	}

	It("creates Services and workloads of all roles with ownerRef and labels", func() {
		name := "apply-create"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		prof := validRenderProfile("apply-create-prof") // Deployment role "router"
		prof.Spec.Roles[0].Service = &aiv1alpha1.RoleService{
			Ports: []aiv1alpha1.ServicePort{{Name: testPortName, Port: 8001, TargetPort: ptrTo(intstr.FromString(testPortName))}},
		}
		roles := []aiv1alpha1.Role{
			prof.Spec.Roles[0],
			{Name: testApplyPrefillRole, Workload: aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindLeaderWorkerSet}, PodTemplate: prof.Spec.Roles[0].PodTemplate},
		}
		prof.Spec.Roles = roles
		rr := []renderer.RenderedRole{
			roleResult(roles[0], 1),
			roleResult(roles[1], 2), // group size not needed for LWS? set GroupSize: 1
		}
		rr[1].GroupSize = 1
		r := applyReconciler()
		statuses, res, err := r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr, Overrides: map[string]string{}}, model())
		Expect(err).NotTo(HaveOccurred())
		Expect(statuses).To(HaveLen(2))
		Expect(res.WaitingDependencies).To(BeEmpty())

		dep := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, dep)).To(Succeed())
		Expect(dep.Labels[managedByLabelKey]).To(Equal(managedByValue))
		Expect(metav1.GetControllerOf(dep).Name).To(Equal(name))
		Expect(dep.Spec.Template.Annotations[templateHashAnnotationKey]).NotTo(BeEmpty())

		lws := &leaderworkersetv1.LeaderWorkerSet{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyPrefillSuffix, Namespace: testNamespace}, lws)).To(Succeed())
		Expect(*lws.Spec.Replicas).To(Equal(int32(2)))

		svc := &corev1.Service{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, svc)).To(Succeed())
		Expect(svc.Spec.Ports).To(Equal([]corev1.ServicePort{
			{Name: testPortName, Port: 8001, Protocol: corev1.ProtocolTCP, TargetPort: intstr.FromString(testPortName)},
		}))
	})

	It("scales replicas without changing the template when only replicas change", func() {
		name := "apply-scale"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		prof := validRenderProfile("apply-scale-prof")
		roles := prof.Spec.Roles
		r := applyReconciler()
		rr := []renderer.RenderedRole{roleResult(roles[0], 1)}
		_, _, err := r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr, Overrides: map[string]string{}}, model())
		Expect(err).NotTo(HaveOccurred())

		before := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, before)).To(Succeed())
		beforeRV := before.ResourceVersion
		hash := before.Spec.Template.Annotations[templateHashAnnotationKey]

		rr2 := []renderer.RenderedRole{roleResult(roles[0], 3)}
		_, _, err = r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr2, Overrides: map[string]string{}}, model())
		Expect(err).NotTo(HaveOccurred())

		after := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, after)).To(Succeed())
		Expect(*after.Spec.Replicas).To(Equal(int32(3)))
		Expect(after.Spec.Template.Annotations[templateHashAnnotationKey]).To(Equal(hash))
		Expect(after.ResourceVersion).NotTo(Equal(beforeRV))
	})

	It("rolls out when the template hash changes", func() {
		name := "apply-rollout"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		prof := validRenderProfile("apply-rollout-prof")
		roles := prof.Spec.Roles
		r := applyReconciler()
		rr := []renderer.RenderedRole{roleResult(roles[0], 1)}
		_, _, err := r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr, Overrides: map[string]string{}}, model())
		Expect(err).NotTo(HaveOccurred())

		before := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, before)).To(Succeed())
		beforeRV := before.ResourceVersion

		roles[0].PodTemplate.Image = "registry.local/engine:v2" // template change
		rr2 := []renderer.RenderedRole{roleResult(roles[0], 1)}
		_, _, err = r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr2, Overrides: map[string]string{}}, model())
		Expect(err).NotTo(HaveOccurred())

		after := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, after)).To(Succeed())
		Expect(after.Spec.Template.Spec.Containers[0].Image).To(Equal("registry.local/engine:v2"))
		Expect(after.ResourceVersion).NotTo(Equal(beforeRV))
	})

	It("skips an unchanged workload (no update)", func() {
		name := "apply-skip"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		prof := validRenderProfile("apply-skip-prof")
		roles := prof.Spec.Roles
		r := applyReconciler()
		rr := []renderer.RenderedRole{roleResult(roles[0], 1)}
		_, _, err := r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr, Overrides: map[string]string{}}, model())
		Expect(err).NotTo(HaveOccurred())

		before := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, before)).To(Succeed())
		beforeRV := before.ResourceVersion

		_, _, err = r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr, Overrides: map[string]string{}}, model())
		Expect(err).NotTo(HaveOccurred())
		after := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, after)).To(Succeed())
		Expect(after.ResourceVersion).To(Equal(beforeRV))
	})

	It("skips an unchanged Service (no update)", func() {
		name := "apply-svc-skip"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		prof := validRenderProfile("apply-svc-skip-prof")
		prof.Spec.Roles[0].Service = &aiv1alpha1.RoleService{
			Ports: []aiv1alpha1.ServicePort{{Name: testPortName, Port: 8001, TargetPort: ptrTo(intstr.FromString(testPortName))}},
		}
		r := applyReconciler()
		rr := []renderer.RenderedRole{roleResult(prof.Spec.Roles[0], 1)}
		_, _, err := r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr, Overrides: map[string]string{}}, model())
		Expect(err).NotTo(HaveOccurred())

		before := &corev1.Service{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, before)).To(Succeed())
		beforeRV := before.ResourceVersion

		// A second apply with identical content must not update the Service:
		// bumping its resourceVersion would re-enqueue this service through
		// the Owns(Service) watch into an unbounded reconcile loop.
		_, _, err = r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr, Overrides: map[string]string{}}, model())
		Expect(err).NotTo(HaveOccurred())
		after := &corev1.Service{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, after)).To(Succeed())
		Expect(after.ResourceVersion).To(Equal(beforeRV))
	})

	It("gates creation on dependency readiness", func() {
		name := "apply-gate"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		prof := validRenderProfile("apply-gate-prof")
		roles := []aiv1alpha1.Role{
			{Name: testApplyPrefillRole, Workload: aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindLeaderWorkerSet}, PodTemplate: validRenderProfile("x").Spec.Roles[0].PodTemplate},
			{Name: testApplyRouterRole, DependsOn: []string{testApplyPrefillRole}, Workload: aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindDeployment}, PodTemplate: validRenderProfile("y").Spec.Roles[0].PodTemplate},
		}
		prof.Spec.Roles = roles
		prof.Spec.Endpoint.Role = testApplyRouterRole
		r := applyReconciler()
		rr := []renderer.RenderedRole{
			roleResult(roles[0], 1),
			roleResult(roles[1], 1),
		}
		_, res, err := r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr, Overrides: map[string]string{}}, model())
		Expect(err).NotTo(HaveOccurred())
		Expect(res.WaitingDependencies).To(Equal([]string{testApplyRouterRole}))

		// prefill created, router not
		lws := &leaderworkersetv1.LeaderWorkerSet{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyPrefillSuffix, Namespace: testNamespace}, lws)).To(Succeed())
		dep := &appsv1.Deployment{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, dep))).To(BeTrue())

		// Mark prefill ready; the next apply creates router.
		lws.Status.ReadyReplicas = 1
		Expect(k8sClient.Status().Update(ctx, lws)).To(Succeed())
		_, res, err = r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr, Overrides: map[string]string{}}, model())
		Expect(err).NotTo(HaveOccurred())
		Expect(res.WaitingDependencies).To(BeEmpty())
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, dep)).To(Succeed())
	})

	It("gates creation on the model PVC being bound", func() {
		name := "apply-pvc-gate"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		prof := validRenderProfile("apply-pvc-gate-prof")
		base := prof.Spec.Roles[0].PodTemplate // includes the model mounts
		roles := []aiv1alpha1.Role{
			{Name: testApplyPrefillRole, Workload: aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindLeaderWorkerSet}, PodTemplate: base},
			{Name: testApplyRouterRole, DependsOn: []string{testApplyPrefillRole}, Workload: aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindDeployment}, PodTemplate: base},
		}
		prof.Spec.Roles = roles
		prof.Spec.Endpoint.Role = testApplyRouterRole
		r := applyReconciler()
		rr := []renderer.RenderedRole{
			roleResult(roles[0], 1),
			roleResult(roles[1], 1),
		}
		mv := pvcModel()

		// The model PVC exists (the Provisioned step creates it on the
		// reconcile path; here it is created by hand) but is not yet bound:
		// prefill's readiness — and with it router's creation — is gated on
		// the PVC being bound (design §4.3).
		sc := "standard"
		pvc := &corev1.PersistentVolumeClaim{
			ObjectMeta: metav1.ObjectMeta{Name: name + "-model-main", Namespace: testNamespace},
			Spec: corev1.PersistentVolumeClaimSpec{
				AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadOnlyMany},
				StorageClassName: &sc,
				Resources: corev1.VolumeResourceRequirements{
					Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("1Gi")},
				},
			},
		}
		Expect(k8sClient.Create(ctx, pvc)).To(Succeed())

		_, res, err := r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr, Overrides: map[string]string{}}, mv)
		Expect(err).NotTo(HaveOccurred())
		Expect(res.WaitingDependencies).To(Equal([]string{testApplyRouterRole}))

		// prefill created, router not
		lws := &leaderworkersetv1.LeaderWorkerSet{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyPrefillSuffix, Namespace: testNamespace}, lws)).To(Succeed())
		dep := &appsv1.Deployment{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, dep))).To(BeTrue())

		// Even with prefill's pods ready, the unbound PVC keeps the router
		// gated: this is the PVC readiness leg, not the replica readiness leg.
		lws.Status.ReadyReplicas = 1
		Expect(k8sClient.Status().Update(ctx, lws)).To(Succeed())
		_, res, err = r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr, Overrides: map[string]string{}}, mv)
		Expect(err).NotTo(HaveOccurred())
		Expect(res.WaitingDependencies).To(Equal([]string{testApplyRouterRole}))
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, dep))).To(BeTrue())

		// Bind the PVC: the next apply creates router.
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-model-main", Namespace: testNamespace}, pvc)).To(Succeed())
		pvc.Status.Phase = corev1.ClaimBound
		Expect(k8sClient.Status().Update(ctx, pvc)).To(Succeed())
		_, res, err = r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr, Overrides: map[string]string{}}, mv)
		Expect(err).NotTo(HaveOccurred())
		Expect(res.WaitingDependencies).To(BeEmpty())
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyRouterSuffix, Namespace: testNamespace}, dep)).To(Succeed())
	})

	It("rejects a same-name foreign workload (ensureOwned)", func() {
		name := "apply-foreign"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		prof := validRenderProfile("apply-foreign-prof")
		foreign := &appsv1.Deployment{
			ObjectMeta: metav1.ObjectMeta{Name: name + testApplyRouterSuffix, Namespace: testNamespace},
			Spec: appsv1.DeploymentSpec{
				Selector: &metav1.LabelSelector{MatchLabels: map[string]string{testForeignLabelKey: testForeignDataKey}},
				Template: corev1.PodTemplateSpec{
					ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{testForeignLabelKey: testForeignDataKey}},
					Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: modelKeyMain, Image: "img"}}},
				},
			},
		}
		Expect(k8sClient.Create(ctx, foreign)).To(Succeed())
		r := applyReconciler()
		rr := []renderer.RenderedRole{roleResult(prof.Spec.Roles[0], 1)}
		_, _, err := r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr, Overrides: map[string]string{}}, model())
		Expect(err).To(HaveOccurred())
		Expect(apierrors.IsConflict(err)).To(BeTrue())
	})

	It("deletes no-longer-desired resources on role removal", func() {
		name := "apply-cleanup"
		Expect(k8sClient.Create(ctx, isvcForApply(name))).To(Succeed())
		prof := validRenderProfile("apply-cleanup-prof")
		roles := []aiv1alpha1.Role{
			prof.Spec.Roles[0],
			{Name: testApplyPrefillRole, Workload: aiv1alpha1.Workload{Kind: aiv1alpha1.WorkloadKindLeaderWorkerSet}, PodTemplate: prof.Spec.Roles[0].PodTemplate},
		}
		prof.Spec.Roles = roles
		r := applyReconciler()
		rr := []renderer.RenderedRole{roleResult(roles[0], 1), roleResult(roles[1], 1)}
		_, _, err := r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr, Overrides: map[string]string{}}, model())
		Expect(err).NotTo(HaveOccurred())

		// Drop the prefill role; only router remains.
		prof.Spec.Roles = roles[:1]
		rr2 := []renderer.RenderedRole{roleResult(roles[0], 1)}
		_, _, err = r.applyWorkloads(ctx, mustGetISVC(ctx, name), prof, &renderer.Result{Roles: rr2, Overrides: map[string]string{}}, model())
		Expect(err).NotTo(HaveOccurred())
		lws := &leaderworkersetv1.LeaderWorkerSet{}
		Expect(apierrors.IsNotFound(k8sClient.Get(ctx, client.ObjectKey{Name: name + testApplyPrefillSuffix, Namespace: testNamespace}, lws))).To(BeTrue())
	})
})
