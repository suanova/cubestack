package devenv

import (
	"context"
	"fmt"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// The pods this file starts are instruments rather than environments. What a
// case asks with them is a question the platform's own API cannot answer — what
// the cluster's network does between two namespaces — so the only way to ask it
// is from a pod that lives on one side and dials the other.

const (
	// probePodNamePrefix and serverPodNamePrefix name the generated pods, so a
	// leftover in a namespace someone is looking at says what made it.
	probePodNamePrefix  = "e2e-probe-"
	serverPodNamePrefix = "e2e-server-"
)

// RunToCompletion runs one pod to its exit and reports how it ended.
//
// RestartPolicy Never, because a nonzero exit is an answer here: the caller
// gives the command its own exit codes, and a container that restarted would
// replace that answer with a wait. The exit code and the container's termination
// message are returned even when the pod failed, which is why this is not an
// error in that case.
//
// The container runs as root for one reason: the message is written to the
// kubelet's termination-log file, and that file belongs to root inside the
// container. Nothing else in this pod depends on the identity.
//
// The image is the caller's, and the callers pass the environment's own — a node
// is already running it, so the pod pulls only where it finds nothing, which is
// what a preloaded cluster with no registry credential can serve.
func (s *Suite) RunToCompletion(
	ctx context.Context, namespace, image string, command []string, timeout time.Duration,
) (int32, string, error) {
	zero := int64(0)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{GenerateName: probePodNamePrefix, Namespace: namespace},
		Spec: corev1.PodSpec{
			RestartPolicy: corev1.RestartPolicyNever,
			Containers: []corev1.Container{{
				Name:            "probe",
				Image:           image,
				Command:         command,
				ImagePullPolicy: corev1.PullIfNotPresent,
				SecurityContext: &corev1.SecurityContext{RunAsUser: &zero},
			}},
		},
	}
	if err := s.Client.Create(ctx, pod); err != nil {
		return 0, "", fmt.Errorf("creating a probe in %s: %w", namespace, err)
	}

	deadline := time.Now().Add(timeout)
	for {
		var got corev1.Pod
		if err := s.Client.Get(ctx, client.ObjectKeyFromObject(pod), &got); err != nil {
			return 0, "", fmt.Errorf("reading %s back: %w", pod.Name, err)
		}
		switch got.Status.Phase {
		case corev1.PodSucceeded, corev1.PodFailed:
			for _, cs := range got.Status.ContainerStatuses {
				if cs.Name != "probe" || cs.State.Terminated == nil {
					continue
				}
				return cs.State.Terminated.ExitCode, cs.State.Terminated.Message, nil
			}
			return 0, "", fmt.Errorf("%s is %s and records no terminated container: %s",
				pod.Name, got.Status.Phase, podEvents(ctx, s.Client, namespace, pod.Name))
		}
		if time.Now().After(deadline) {
			return 0, "", fmt.Errorf("%s is still %s after %s: %s",
				pod.Name, got.Status.Phase, timeout, podEvents(ctx, s.Client, namespace, pod.Name))
		}
		select {
		case <-ctx.Done():
			return 0, "", ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// RunServer starts a pod that is expected to stay up, and waits until its
// container is ready to answer on port.
//
// The counterpart of RunToCompletion, and the half a probe needs to compare
// against: a connection the network refused and a connection nothing was
// serving produce the same error, so the control has to be answering before the
// probe asks anything. The caller deletes the pod; it never exits on its own.
func (s *Suite) RunServer(
	ctx context.Context, namespace, image string, command []string, port int32, timeout time.Duration,
) (*corev1.Pod, error) {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{GenerateName: serverPodNamePrefix, Namespace: namespace},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{
				Name:            "server",
				Image:           image,
				Command:         command,
				ImagePullPolicy: corev1.PullIfNotPresent,
				Ports:           []corev1.ContainerPort{{ContainerPort: port, Protocol: corev1.ProtocolTCP}},
				ReadinessProbe: &corev1.Probe{
					ProbeHandler: corev1.ProbeHandler{
						TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromInt32(port)},
					},
				},
			}},
		},
	}
	if err := s.Client.Create(ctx, pod); err != nil {
		return nil, fmt.Errorf("creating a server in %s: %w", namespace, err)
	}

	deadline := time.Now().Add(timeout)
	for {
		var got corev1.Pod
		if err := s.Client.Get(ctx, client.ObjectKeyFromObject(pod), &got); err != nil {
			return nil, fmt.Errorf("reading %s back: %w", pod.Name, err)
		}
		if podReady(&got) {
			return &got, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("%s never became ready within %s: %s",
				pod.Name, timeout, podEvents(ctx, s.Client, namespace, pod.Name))
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// podReady is whether the pod's Ready condition is true.
func podReady(pod *corev1.Pod) bool {
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

// podEvents is what the namespace says about a pod that did not get where it was
// going — the pull failure, the scheduling refusal — so a timeout names a cause
// instead of only a wait.
func podEvents(ctx context.Context, c client.Client, namespace, name string) string {
	var events corev1.EventList
	if err := c.List(ctx, &events, client.InNamespace(namespace)); err != nil {
		return "the events could not be read: " + err.Error()
	}
	var b strings.Builder
	for i := range events.Items {
		e := &events.Items[i]
		if e.InvolvedObject.Kind != "Pod" || e.InvolvedObject.Name != name {
			continue
		}
		fmt.Fprintf(&b, "; %s: %s", e.Reason, e.Message)
	}
	if b.Len() == 0 {
		return "no events mention it"
	}
	return "events on " + name + b.String()
}
