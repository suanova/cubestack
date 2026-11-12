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
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/events"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// testFailedMountMessage is the kubelet Event message of the specs: the real
// cause of a Pod stuck in ContainerCreating, which never appears in the Pod's
// own status.
const testFailedMountMessage = "hostPath type check failed: /mnt/cephfs/models/DeepSeek-V4-Flash-0731-W8A8 is not a directory"

// stuckWorkloadPod creates the endpoint role's Pod stuck in ContainerCreating,
// plus the kubelet Warning Event carrying the mount failure.
func stuckWorkloadPod(name string) {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name + "-router-0",
			Namespace: testNamespace,
			Labels: map[string]string{
				inferenceServiceLabelKey: name,
				roleLabelKey:             testApplyRouterRole,
			},
		},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "engine", Image: "engine:test"}}},
	}
	Expect(k8sClient.Create(ctx, pod)).To(Succeed())
	pod.Status.Phase = corev1.PodPending
	pod.Status.ContainerStatuses = []corev1.ContainerStatus{{
		Name:  "engine",
		State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "ContainerCreating"}},
	}}
	Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())

	now := metav1.Now()
	evt := &corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Name: name + "-failedmount", Namespace: testNamespace},
		InvolvedObject: corev1.ObjectReference{Kind: "Pod", Name: pod.Name, Namespace: testNamespace},
		Reason:         "FailedMount",
		Message:        testFailedMountMessage,
		Type:           corev1.EventTypeWarning,
		Source:         corev1.EventSource{Component: "kubelet"},
		FirstTimestamp: now,
		LastTimestamp:  now,
		Count:          1,
	}
	Expect(k8sClient.Create(ctx, evt)).To(Succeed())
}

// reconcileConvergenceResult reconciles through r, retrying the status-write
// conflict the suite's manager can cause, and returns the result so a spec can
// assert the requeue decision.
func reconcileConvergenceResult(name string, r *InferenceServiceReconciler) (ctrl.Result, error) {
	var res ctrl.Result
	var err error
	for range 3 {
		res, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: name, Namespace: testNamespace}})
		if err == nil || !apierrors.IsConflict(err) {
			return res, err
		}
	}
	return res, err
}

var _ = Describe("workload Pod failures", func() {
	BeforeEach(func() { ensureSystemNamespace() })

	It("surfaces the Pod's FailedMount Event on the Ready and EndpointReady conditions", func() {
		name := "pod-failedmount"
		convergenceISVC(name, false)
		Expect(reconcileConvergence(name)).To(Succeed())
		stuckWorkloadPod(name)

		Expect(reconcileConvergence(name)).To(Succeed())

		got := &aiv1alpha1.InferenceService{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name, Namespace: testNamespace}, got)).To(Succeed())

		ready := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionReady)
		Expect(ready).NotTo(BeNil())
		Expect(ready.Status).To(Equal(metav1.ConditionFalse))
		Expect(ready.Message).To(ContainSubstring(name + "-router-0"))
		Expect(ready.Message).To(ContainSubstring("FailedMount"))
		Expect(ready.Message).To(ContainSubstring(testFailedMountMessage))

		endpoint := meta.FindStatusCondition(got.Status.Conditions, aiv1alpha1.ConditionEndpointReady)
		Expect(endpoint).NotTo(BeNil())
		Expect(endpoint.Message).To(ContainSubstring("FailedMount"))
		Expect(endpoint.Message).To(ContainSubstring(testFailedMountMessage))
	})

	It("emits a Warning Event naming the stuck Pod and its cause", func() {
		name := "pod-event"
		convergenceISVC(name, false)
		Expect(reconcileConvergence(name)).To(Succeed())
		stuckWorkloadPod(name)

		r := convergenceReconciler()
		recorder := events.NewFakeRecorder(10)
		r.Recorder = recorder
		_, err := reconcileConvergenceResult(name, r)
		Expect(err).NotTo(HaveOccurred())
		Eventually(recorder.Events, "5s").Should(Receive(And(
			ContainSubstring("Warning"),
			ContainSubstring("FailedMount"),
			ContainSubstring(testFailedMountMessage),
		)))
	})

	It("requeues while a role is not ready and stops once every role is ready", func() {
		name := "pod-requeue"
		convergenceISVC(name, false)

		res, err := reconcileConvergenceResult(name, convergenceReconciler())
		Expect(err).NotTo(HaveOccurred())
		Expect(res.RequeueAfter).To(BeNumerically(">", 0))

		readyEndpoints(name)
		dep := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-router", Namespace: testNamespace}, dep)).To(Succeed())
		dep.Status.Replicas = 1 // the status validation requires readyReplicas <= replicas
		dep.Status.ReadyReplicas = 1
		Expect(k8sClient.Status().Update(ctx, dep)).To(Succeed())

		res, err = reconcileConvergenceResult(name, convergenceReconciler())
		Expect(err).NotTo(HaveOccurred())
		Expect(res.RequeueAfter).To(BeZero())
	})

	It("does not poll a permanent endpoint configuration error", func() {
		name := "pod-endpointrole"
		convergenceISVC(name, false)

		// The endpoint names a role the profile does not declare: the endpoint
		// can never become reachable, so there is nothing to poll. The update
		// retries the resourceVersion conflict the profile controller's status
		// writes can cause.
		irp := &aiv1alpha1.InferenceRuntimeProfile{}
		var updateErr error
		for range 3 {
			Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-prof"}, irp)).To(Succeed())
			irp.Spec.Endpoint.Role = "ghost"
			updateErr = k8sClient.Update(ctx, irp)
			if updateErr == nil || !apierrors.IsConflict(updateErr) {
				break
			}
		}
		Expect(updateErr).NotTo(HaveOccurred())

		_, err := reconcileConvergenceResult(name, convergenceReconciler())
		Expect(err).NotTo(HaveOccurred())

		dep := &appsv1.Deployment{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Name: name + "-router", Namespace: testNamespace}, dep)).To(Succeed())
		dep.Status.Replicas = 1 // the status validation requires readyReplicas <= replicas
		dep.Status.ReadyReplicas = 1
		Expect(k8sClient.Status().Update(ctx, dep)).To(Succeed())

		res, err := reconcileConvergenceResult(name, convergenceReconciler())
		Expect(err).NotTo(HaveOccurred())
		Expect(res.RequeueAfter).To(BeZero())
	})
})
