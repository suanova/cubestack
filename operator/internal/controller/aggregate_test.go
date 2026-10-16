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

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

func roleStatusReady(name string, ready bool) aiv1alpha1.RoleStatus {
	return aiv1alpha1.RoleStatus{Name: name, Replicas: 1, ReadyReplicas: 1, Ready: ready}
}

var _ = Describe("aggregation", func() {
	It("sets Ready true when every role is ready", func() {
		conditions := []metav1.Condition{}
		setReadyCondition(&conditions, []aiv1alpha1.RoleStatus{roleStatusReady("router", true), roleStatusReady("prefill", true)})
		Expect(meta.FindStatusCondition(conditions, aiv1alpha1.ConditionReady).Status).To(Equal(metav1.ConditionTrue))
	})

	It("sets Ready false with RolesNotReady listing the unready roles", func() {
		conditions := []metav1.Condition{}
		setReadyCondition(&conditions, []aiv1alpha1.RoleStatus{roleStatusReady("router", true), roleStatusReady("decode", false)})
		cond := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionReady)
		Expect(cond.Status).To(Equal(metav1.ConditionFalse))
		Expect(cond.Reason).To(Equal("RolesNotReady"))
		Expect(cond.Message).To(ContainSubstring("decode"))
	})

	It("sets Progressing converged when every role is ready", func() {
		conditions := []metav1.Condition{}
		setProgressingCondition(&conditions, []aiv1alpha1.RoleStatus{roleStatusReady("router", true)}, ProgressingReconciling)
		Expect(meta.FindStatusCondition(conditions, aiv1alpha1.ConditionProgressing).Status).To(Equal(metav1.ConditionFalse))
		Expect(meta.FindStatusCondition(conditions, aiv1alpha1.ConditionProgressing).Reason).To(Equal("Converged"))
	})

	It("sets Progressing true with the apply reason when not converged", func() {
		conditions := []metav1.Condition{}
		setProgressingCondition(&conditions, []aiv1alpha1.RoleStatus{roleStatusReady("router", false)}, ProgressingRollout)
		cond := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionProgressing)
		Expect(cond.Status).To(Equal(metav1.ConditionTrue))
		Expect(cond.Reason).To(Equal("Rollout"))
	})

	It("leaves a converged Progressing untouched when nothing was applied and roles are not ready", func() {
		conditions := []metav1.Condition{{
			Type: aiv1alpha1.ConditionProgressing, Status: metav1.ConditionFalse, Reason: "Converged",
		}}
		setProgressingCondition(&conditions, []aiv1alpha1.RoleStatus{roleStatusReady("router", false)}, "")
		cond := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionProgressing)
		Expect(cond.Status).To(Equal(metav1.ConditionFalse))
		Expect(cond.Reason).To(Equal("Converged"))
	})

	It("keeps the existing Progressing reason when nothing was applied", func() {
		conditions := []metav1.Condition{{
			Type: aiv1alpha1.ConditionProgressing, Status: metav1.ConditionTrue, Reason: "Rollout",
		}}
		setProgressingCondition(&conditions, []aiv1alpha1.RoleStatus{roleStatusReady("router", false)}, "")
		cond := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionProgressing)
		Expect(cond.Status).To(Equal(metav1.ConditionTrue))
		Expect(cond.Reason).To(Equal("Rollout"))
	})
})

var _ = Describe("phase", func() {
	// cond is a status-written condition; the transition time is not read by
	// the judgement but SetStatusCondition manages it, so it is set here too.
	cond := func(t string, s metav1.ConditionStatus, reason string) metav1.Condition {
		return metav1.Condition{Type: t, Status: s, Reason: reason, LastTransitionTime: metav1.Now()}
	}

	// phaseOf derives the phase the way Reconcile does: from the conditions a
	// pass wrote, and nothing else.
	phaseOf := func(conditions ...metav1.Condition) (aiv1alpha1.InferenceServicePhaseName, string) {
		status := &aiv1alpha1.InferenceServiceStatus{Conditions: conditions}
		setInferenceServicePhase(status)
		return status.Phase.Name, status.Phase.Reason
	}

	It("stays Pending until a pass has written a verdict", func() {
		name, reason := phaseOf()
		Expect(name).To(Equal(aiv1alpha1.InferenceServicePhasePending))
		Expect(reason).To(Equal("Pending"))
	})

	It("keeps the same LastTransitionTime while the phase name is unchanged, but rewrites the reason", func() {
		status := &aiv1alpha1.InferenceServiceStatus{Conditions: []metav1.Condition{
			cond(aiv1alpha1.ConditionReady, metav1.ConditionFalse, "RolesNotReady"),
			cond(aiv1alpha1.ConditionProgressing, metav1.ConditionTrue, "Reconciling"),
		}}
		setInferenceServicePhase(status)
		first := status.Phase.LastTransitionTime
		Expect(status.Phase.Name).To(Equal(aiv1alpha1.InferenceServicePhaseProgressing))

		// The same phase reached by a different route: the transition time is
		// when the service entered Progressing, not when it last changed the
		// kind of work it was doing.
		status.Conditions = []metav1.Condition{
			cond(aiv1alpha1.ConditionReady, metav1.ConditionFalse, "RolesNotReady"),
			cond(aiv1alpha1.ConditionProgressing, metav1.ConditionTrue, "Rollout"),
		}
		setInferenceServicePhase(status)
		Expect(status.Phase.LastTransitionTime).To(BeIdenticalTo(first))
		Expect(status.Phase.Reason).To(Equal("Rollout"))
	})

	It("bumps LastTransitionTime when the phase name changes", func() {
		status := &aiv1alpha1.InferenceServiceStatus{}
		setInferenceServicePhase(status)
		first := status.Phase.LastTransitionTime
		Expect(status.Phase.Name).To(Equal(aiv1alpha1.InferenceServicePhasePending))

		status.Conditions = []metav1.Condition{cond(aiv1alpha1.ConditionReady, metav1.ConditionTrue, "Ready")}
		setInferenceServicePhase(status)
		Expect(status.Phase.Name).To(Equal(aiv1alpha1.InferenceServicePhaseReady))
		Expect(status.Phase.LastTransitionTime).NotTo(BeIdenticalTo(first))
	})

	// The pipeline conditions are judged first because each of their False
	// paths returns from Reconcile before setReadyCondition runs — so on a
	// service that has never converged there is no Ready condition to judge it
	// by, and on one that had converged there is a stale one.
	DescribeTable("judges a pipeline failure as Failed, carrying that condition's reason",
		func(conditions []metav1.Condition, wantReason string) {
			name, reason := phaseOf(conditions...)
			Expect(name).To(Equal(aiv1alpha1.InferenceServicePhaseFailed))
			Expect(reason).To(Equal(wantReason))
		},
		Entry("Resolved", []metav1.Condition{
			cond(aiv1alpha1.ConditionResolved, metav1.ConditionFalse, "ProfileNotFound"),
		}, "ProfileNotFound"),
		Entry("Rendered", []metav1.Condition{
			cond(aiv1alpha1.ConditionRendered, metav1.ConditionFalse, "UnknownOverride"),
		}, "UnknownOverride"),
		Entry("Provisioned", []metav1.Condition{
			cond(aiv1alpha1.ConditionProvisioned, metav1.ConditionFalse, "PVCCreateFailed"),
		}, "PVCCreateFailed"),
		Entry("WorkloadsApplied", []metav1.Condition{
			cond(aiv1alpha1.ConditionWorkloadsApplied, metav1.ConditionFalse, "WorkloadApplyFailed"),
		}, "WorkloadApplyFailed"),
		Entry("the earliest failing step names the reason when several are false", []metav1.Condition{
			cond(aiv1alpha1.ConditionResolved, metav1.ConditionFalse, "ModelNotFound"),
			cond(aiv1alpha1.ConditionProvisioned, metav1.ConditionFalse, "PVCCreateFailed"),
		}, "ModelNotFound"),
		Entry("a failure outranks a Ready kept from the running deployment", []metav1.Condition{
			cond(aiv1alpha1.ConditionResolved, metav1.ConditionFalse, "AssetNotFound"),
			cond(aiv1alpha1.ConditionReady, metav1.ConditionTrue, "Ready"),
		}, "AssetNotFound"),
	)

	It("reads a role waiting on a dependency as Progressing, not Failed", func() {
		// WorkloadsApplied is False while a gated role waits, but that is the
		// normal first deployment, not a failure — the Progressing condition
		// this same pass writes says Reconciling. Judging the bare False as
		// Failed would mark every healthy service broken while it starts.
		name, reason := phaseOf(
			cond(aiv1alpha1.ConditionWorkloadsApplied, metav1.ConditionFalse, reasonWaitingForDependencies),
			cond(aiv1alpha1.ConditionReady, metav1.ConditionFalse, "RolesNotReady"),
			cond(aiv1alpha1.ConditionProgressing, metav1.ConditionTrue, "Reconciling"),
		)
		Expect(name).To(Equal(aiv1alpha1.InferenceServicePhaseProgressing))
		Expect(reason).To(Equal("Reconciling"))
	})

	DescribeTable("reads the Ready and Progressing quadrant",
		func(conditions []metav1.Condition, wantName aiv1alpha1.InferenceServicePhaseName, wantReason string) {
			name, reason := phaseOf(conditions...)
			Expect(name).To(Equal(wantName))
			Expect(reason).To(Equal(wantReason))
		},
		Entry("every role ready is Ready", []metav1.Condition{
			cond(aiv1alpha1.ConditionReady, metav1.ConditionTrue, "Ready"),
			cond(aiv1alpha1.ConditionProgressing, metav1.ConditionFalse, "Converged"),
		}, aiv1alpha1.InferenceServicePhaseReady, "Ready"),
		Entry("a rollout is Progressing, under the apply reason", []metav1.Condition{
			cond(aiv1alpha1.ConditionReady, metav1.ConditionFalse, "RolesNotReady"),
			cond(aiv1alpha1.ConditionProgressing, metav1.ConditionTrue, "Rollout"),
		}, aiv1alpha1.InferenceServicePhaseProgressing, "Rollout"),
		Entry("a scale is Progressing, under the apply reason", []metav1.Condition{
			cond(aiv1alpha1.ConditionReady, metav1.ConditionFalse, "RolesNotReady"),
			cond(aiv1alpha1.ConditionProgressing, metav1.ConditionTrue, "Scaling"),
		}, aiv1alpha1.InferenceServicePhaseProgressing, "Scaling"),
		Entry("converged but not ready is Failed — the workload came up broken", []metav1.Condition{
			cond(aiv1alpha1.ConditionReady, metav1.ConditionFalse, "RolesNotReady"),
			cond(aiv1alpha1.ConditionProgressing, metav1.ConditionFalse, "Converged"),
		}, aiv1alpha1.InferenceServicePhaseFailed, "RolesNotReady"),
		Entry("not ready with no Progressing condition at all is still Failed", []metav1.Condition{
			cond(aiv1alpha1.ConditionReady, metav1.ConditionFalse, "RolesNotReady"),
		}, aiv1alpha1.InferenceServicePhaseFailed, "RolesNotReady"),
	)

	DescribeTable("is not driven by the conditions below Ready",
		func(conditions []metav1.Condition, wantName aiv1alpha1.InferenceServicePhaseName) {
			name, _ := phaseOf(conditions...)
			Expect(name).To(Equal(wantName))
		},
		Entry("an unpublished or unaccepted route leaves a ready service Ready", []metav1.Condition{
			cond(aiv1alpha1.ConditionReady, metav1.ConditionTrue, "Ready"),
			cond(aiv1alpha1.ConditionRouteReady, metav1.ConditionFalse, "GatewayNotAccepted"),
		}, aiv1alpha1.InferenceServicePhaseReady),
		Entry("an endpoint that is not yet reachable leaves a ready service Ready", []metav1.Condition{
			cond(aiv1alpha1.ConditionReady, metav1.ConditionTrue, "Ready"),
			cond(aiv1alpha1.ConditionEndpointReady, metav1.ConditionFalse, "EndpointNotReady"),
		}, aiv1alpha1.InferenceServicePhaseReady),
		Entry("a route alone is not a verdict", []metav1.Condition{
			cond(aiv1alpha1.ConditionRouteReady, metav1.ConditionFalse, "GatewayNotAccepted"),
		}, aiv1alpha1.InferenceServicePhasePending),
	)
})
