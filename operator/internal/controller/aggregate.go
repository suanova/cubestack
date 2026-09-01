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
	"fmt"
	"strings"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// ProgressingReason describes what the apply phase did this reconcile.
type ProgressingReason string

const (
	// ProgressingReconciling marks first-time creation or waiting for
	// dependencies (design §3.3: Reconciling).
	ProgressingReconciling ProgressingReason = "Reconciling"
	// ProgressingRollout marks a pod template change.
	ProgressingRollout ProgressingReason = "Rollout"
	// ProgressingScaling marks a replicas-only change.
	ProgressingScaling ProgressingReason = "Scaling"
)

// allRolesReady reports whether every role's workload is ready
// (readinessPolicy.requireAllRoles is fixed to true in v1alpha1).
func allRolesReady(roles []aiv1alpha1.RoleStatus) bool {
	for _, r := range roles {
		if !r.Ready {
			return false
		}
	}
	return true
}

// setReadyCondition sets the Ready condition (design §3.3): True when every
// role is ready, False/RolesNotReady with a message listing the unready ones.
func setReadyCondition(conditions *[]metav1.Condition, roles []aiv1alpha1.RoleStatus) {
	if allRolesReady(roles) {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionReady,
			Status:  metav1.ConditionTrue,
			Reason:  "Ready",
			Message: "All roles are ready",
		})
		return
	}
	var unready []string
	for _, r := range roles {
		if !r.Ready {
			unready = append(unready, fmt.Sprintf("%s not ready (%d/%d)", r.Name, r.ReadyReplicas, r.Replicas))
		}
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type:    aiv1alpha1.ConditionReady,
		Status:  metav1.ConditionFalse,
		Reason:  "RolesNotReady",
		Message: strings.Join(unready, "; "),
	})
}

// setProgressingCondition sets the Progressing condition from the roles and
// the apply result: Converged when every role is ready; otherwise True with
// the reason from the apply result — leaving the existing condition untouched
// when nothing was applied this reconcile (a mid-rollout service keeps
// True/Rollout, a converged-but-crashed one keeps False/Converged).
func setProgressingCondition(conditions *[]metav1.Condition, roles []aiv1alpha1.RoleStatus, applyProgressing ProgressingReason) {
	if allRolesReady(roles) {
		meta.SetStatusCondition(conditions, metav1.Condition{
			Type:    aiv1alpha1.ConditionProgressing,
			Status:  metav1.ConditionFalse,
			Reason:  "Converged",
			Message: "Desired configuration is fully applied and ready",
		})
		return
	}
	reason := string(applyProgressing)
	if reason == "" {
		// Nothing applied this reconcile: keep the existing Progressing state
		// as it is — only a first observation with no prior state falls back
		// to Reconciling.
		if existing := meta.FindStatusCondition(*conditions, aiv1alpha1.ConditionProgressing); existing != nil {
			return
		}
		reason = "Reconciling"
	}
	meta.SetStatusCondition(conditions, metav1.Condition{
		Type:    aiv1alpha1.ConditionProgressing,
		Status:  metav1.ConditionTrue,
		Reason:  reason,
		Message: "Applying the desired configuration",
	})
}
