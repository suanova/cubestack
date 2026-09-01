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
