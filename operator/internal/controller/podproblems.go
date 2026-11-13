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

// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=events,verbs=get;list;watch

package controller

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

const (
	// workloadNotReadyRequeueInterval is how often a service with an unready
	// role is re-checked. kubelet retries a failed mount in place, so neither
	// the Pod status nor any owned object necessarily changes: a watch cannot
	// refresh the conditions, a poll can.
	workloadNotReadyRequeueInterval = 30 * time.Second
	// eventReasonPodNotStarting is the reason of the Warning Event emitted on
	// a service whose workload Pod cannot start.
	eventReasonPodNotStarting = "PodNotStarting"
)

// workloadPodProblem is why a workload Pod is not starting. The Event's reason
// and message win over the Pod's own status: kubelet reports the actual cause
// of a failed mount only in the Event, while the Pod status stays a bare
// ContainerCreating.
type workloadPodProblem struct {
	Pod     string
	Reason  string
	Message string
}

// String formats the problem on one line for a condition message or Event note.
func (p *workloadPodProblem) String() string {
	if p.Message == "" {
		return fmt.Sprintf("pod %s: %s", p.Pod, p.Reason)
	}
	return fmt.Sprintf("pod %s: %s: %s", p.Pod, p.Reason, oneLine(p.Message))
}

// podProblems reports, per role, the first Pod that is not starting, with its
// most useful failure detail. Pods are matched by the service label. A Pod that
// is not ready and carries no status detail is still reported as Pending.
func (r *InferenceServiceReconciler) podProblems(ctx context.Context, isvc *aiv1alpha1.InferenceService) (map[string]*workloadPodProblem, error) {
	pods := &corev1.PodList{}
	if err := r.reader().List(ctx, pods, client.InNamespace(isvc.Namespace), client.MatchingLabels{inferenceServiceLabelKey: isvc.Name}); err != nil {
		return nil, err
	}
	problems := map[string]*workloadPodProblem{}
	for i := range pods.Items {
		pod := &pods.Items[i]
		role := pod.Labels[roleLabelKey]
		if role == "" || problems[role] != nil || podReady(pod) {
			continue
		}
		problems[role] = r.podProblem(ctx, pod)
	}
	return problems, nil
}

// podProblem returns the Pod's problem detail. The latest Warning Event is
// preferred; the Pod status is the fallback when no Event is readable.
func (r *InferenceServiceReconciler) podProblem(ctx context.Context, pod *corev1.Pod) *workloadPodProblem {
	problem := podStatusProblem(pod)
	if event := r.podEventProblem(ctx, pod); event != nil {
		problem.Reason, problem.Message = event.Reason, event.Message
	}
	return problem
}

// podStatusProblem derives the problem from the Pod's own status: the waiting
// state of the first container that has one, or the Pod phase when none does.
func podStatusProblem(pod *corev1.Pod) *workloadPodProblem {
	problem := &workloadPodProblem{Pod: pod.Name}
	statuses := make([]corev1.ContainerStatus, 0, len(pod.Status.InitContainerStatuses)+len(pod.Status.ContainerStatuses))
	statuses = append(statuses, pod.Status.InitContainerStatuses...)
	statuses = append(statuses, pod.Status.ContainerStatuses...)
	for _, status := range statuses {
		if waiting := status.State.Waiting; waiting != nil && waiting.Reason != "" {
			problem.Reason, problem.Message = waiting.Reason, waiting.Message
			return problem
		}
		if terminated := status.State.Terminated; terminated != nil && terminated.ExitCode != 0 {
			problem.Reason, problem.Message = terminated.Reason, terminated.Message
			if problem.Reason == "" {
				problem.Reason = "Terminated"
			}
			return problem
		}
	}
	if pod.Status.Phase == corev1.PodPending {
		problem.Reason = "Pending"
	} else {
		problem.Reason = "NotReady"
	}
	return problem
}

// podEventProblem returns the latest Warning Event about the Pod. The Event
// selector matches the Pod's UID as well as its name: a recreated Pod can
// leave the previous Pod's Events behind under the same name, and those must
// not be reported as the current Pod's failure. Event reads are best-effort: a
// failed read leaves the status fallback in place rather than failing the
// reconcile.
func (r *InferenceServiceReconciler) podEventProblem(ctx context.Context, pod *corev1.Pod) *workloadPodProblem {
	events := &corev1.EventList{}
	if err := r.reader().List(ctx, events, client.InNamespace(pod.Namespace), client.MatchingFields{
		"involvedObject.kind": "Pod",
		"involvedObject.name": pod.Name,
		"involvedObject.uid":  string(pod.UID),
		"type":                corev1.EventTypeWarning,
	}); err != nil {
		return nil
	}
	var latest *corev1.Event
	for i := range events.Items {
		event := &events.Items[i]
		if event.Message == "" {
			continue
		}
		if latest == nil || eventTimestamp(event).After(eventTimestamp(latest)) {
			latest = event
		}
	}
	if latest == nil {
		return nil
	}
	return &workloadPodProblem{Pod: pod.Name, Reason: latest.Reason, Message: latest.Message}
}

// eventTimestamp returns the most recent time an Event was observed. For an
// aggregated series that is Series.LastObservedTime: EventTime records the
// first observation, so ranking by it would put an older repeated warning
// ahead of a newer single one.
func eventTimestamp(event *corev1.Event) time.Time {
	switch {
	case event.Series != nil && !event.Series.LastObservedTime.IsZero():
		return event.Series.LastObservedTime.Time
	case !event.LastTimestamp.IsZero():
		return event.LastTimestamp.Time
	case !event.EventTime.IsZero():
		return event.EventTime.Time
	default:
		return event.FirstTimestamp.Time
	}
}

// recordPodProblems emits a Warning Event per role whose workload is stuck, so
// the cause is visible in the service's event stream too. The recorder
// aggregates repeats of the same cause, so the per-reconcile call does not
// flood the stream.
func (r *InferenceServiceReconciler) recordPodProblems(isvc *aiv1alpha1.InferenceService, problems map[string]*workloadPodProblem) {
	if r.Recorder == nil {
		return
	}
	roles := make([]string, 0, len(problems))
	for role := range problems {
		roles = append(roles, role)
	}
	slices.Sort(roles)
	for _, role := range roles {
		r.Recorder.Eventf(isvc, nil, corev1.EventTypeWarning, eventReasonPodNotStarting, eventReasonPodNotStarting, "%s", problems[role].String())
	}
}

// reader returns the direct API reader when available, falling back to the
// cached client (a direct client in the tests).
func (r *InferenceServiceReconciler) reader() client.Reader {
	if r.APIReader != nil {
		return r.APIReader
	}
	return r.Client
}

// oneLine collapses the whitespace of a message so it stays readable in a
// condition message, which is a single line.
func oneLine(message string) string {
	return strings.Join(strings.Fields(message), " ")
}
