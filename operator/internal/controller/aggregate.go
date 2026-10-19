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

// reasonWaitingForDependencies is the WorkloadsApplied reason for a role whose
// creation is gated on a not-yet-ready dependency (apply.go:
// applyResult.WaitingDependencies, design §3.3). It is the one WorkloadsApplied
// reason that is not a failure — see derivePhase, which has to read it back.
const reasonWaitingForDependencies = "WaitingForDependencies"

// setInferenceServicePhase derives the phase from the conditions and records
// it, bumping LastTransitionTime only when the phase name changes.
//
// The phase is a summary, not a further observation: everything it reads was
// written by the pass that calls it, so a client rendering the phase and a
// client reading the conditions alongside it cannot disagree about what state
// the service is in.
//
// Named after the service rather than merely setPhase, which is the
// DevEnvironment's recorder and takes a different status.
func setInferenceServicePhase(status *aiv1alpha1.InferenceServiceStatus) {
	name, reason := derivePhase(status.Conditions)
	if status.Phase == nil || status.Phase.Name != name {
		now := metav1.Now()
		status.Phase = &aiv1alpha1.InferenceServicePhase{Name: name, LastTransitionTime: &now}
	}
	status.Phase.Reason = reason
}

// derivePhase is the phase judgement as a pure function of the conditions.
//
// The four pipeline conditions come first because each of their False paths
// returns before setReadyCondition runs, leaving Ready and Progressing at
// whatever a previous pass wrote — or unset, on a service that has never
// converged. Judging such a service on Ready alone would read Pending for one
// whose first apply failed. The order Resolved → Rendered → Provisioned →
// WorkloadsApplied is the order the pipeline applies them in, so the reason
// names the earliest thing that went wrong (design §3.3).
//
// WorkloadsApplied=False is a failure only for the reasons that mean the apply
// itself failed. WaitingForDependencies is not one of them: a role gated on a
// not-yet-ready dependency is starting normally, and the Progressing condition
// this same pass writes says Reconciling (aggregate.go: ProgressingReconciling).
// Reading it as Failed would mark a healthy first deployment broken.
//
// EndpointReady and RouteReady are deliberately not consulted. A route that is
// not published is not a fault — no aigatewayRouter reports
// True/NotPublished — and an endpoint that is not yet reachable is already what
// Progressing says.
func derivePhase(conditions []metav1.Condition) (aiv1alpha1.InferenceServicePhaseName, string) {
	for _, t := range []string{
		aiv1alpha1.ConditionResolved,
		aiv1alpha1.ConditionRendered,
		aiv1alpha1.ConditionProvisioned,
		aiv1alpha1.ConditionWorkloadsApplied,
	} {
		c := meta.FindStatusCondition(conditions, t)
		if c == nil || c.Status != metav1.ConditionFalse {
			continue
		}
		if c.Reason == reasonWaitingForDependencies {
			continue
		}
		return aiv1alpha1.InferenceServicePhaseFailed, c.Reason
	}

	ready := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionReady)
	switch {
	case ready == nil:
		// No verdict yet: the first reconcile has not landed, or a read keeps
		// failing and the pass returns before it reaches the aggregation.
		return aiv1alpha1.InferenceServicePhasePending, "Pending"
	case ready.Status == metav1.ConditionTrue:
		return aiv1alpha1.InferenceServicePhaseReady, ready.Reason
	}
	// Ready is False, so Progressing is what says whether that is work in
	// flight or a workload that converged on one that never came up. A
	// converged service whose pod has since died keeps False/Converged
	// (setProgressingCondition leaves the condition alone when nothing was
	// applied), which is exactly the case that reads Failed here.
	progressing := meta.FindStatusCondition(conditions, aiv1alpha1.ConditionProgressing)
	if progressing != nil && progressing.Status == metav1.ConditionTrue {
		return aiv1alpha1.InferenceServicePhaseProgressing, progressing.Reason
	}
	return aiv1alpha1.InferenceServicePhaseFailed, ready.Reason
}
