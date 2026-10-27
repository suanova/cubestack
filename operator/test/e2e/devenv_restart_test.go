//go:build e2e
// +build e2e

package e2e

import (
	"context"
	"fmt"
	"slices"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/test/e2e/devenv"
)

// Family S: the controller's own restart (§4.7).
//
// Everything else in this suite is a question about an environment; this one is
// about the process that answers it. A controller is not durable state — its
// memory of what it has done goes away with it — so what a restart proves is
// that the cluster is: every change made while it was down is found again from
// the API server, by listing rather than by remembering, and the environment is
// not disturbed to make that true.
//
// The case is deliberately disruptive. It scales the platform's Deployment to
// zero for the length of the case, which stops the controller for the whole
// cluster and not just for this run's namespace, and it puts it back whether or
// not the case passes. Do not run it against a cluster somebody else is using.

func describeControllerRestart() {
	draftCase{
		Name:     "controller-restart",
		Image:    devenv.MustImage("cpu-pytorch-jupyter"),
		Identity: devenv.NonRoot,
		Cases: func(open func() *devenv.Environment) {
			It("S1 converges the changes it could not see while it was down",
				Label(devenv.TierP1, devenv.LabelShard(devenv.ShardP2), devenv.LabelFamily("S")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					podUID, err := env.PodUID(ctx)
					Expect(err).NotTo(HaveOccurred())

					manager, err := managerDeployment(ctx)
					Expect(err).NotTo(HaveOccurred())
					// Restored to what the cluster had rather than to 1: an
					// installation that runs more than one replica gets its own
					// count back.
					replicas := int32(1)
					if manager.Spec.Replicas != nil {
						replicas = *manager.Spec.Replicas
					}
					before, err := managerPodUIDs(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(before).NotTo(BeEmpty(),
						"the manager's Deployment (%s/%s) selects no running pod, so there is nothing "+
							"to restart", manager.Namespace, manager.Name)

					// Registered before anything is scaled, so a failure anywhere
					// below cannot leave the platform's controller down for the
					// rest of the run. LIFO ordering runs it before the case's own
					// cleanup.
					DeferCleanup(func() {
						cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
						defer cancel()
						Expect(scaleManager(cleanup, replicas)).To(Succeed(),
							"restoring %s/%s to %d replicas", manager.Namespace, manager.Name, replicas)
						Expect(waitManagerReady(cleanup, before...)).To(Succeed(),
							"the manager coming back after this case")
					})

					// Take the controller away, and wait until it is really gone
					// rather than merely asked to stop: a pod that is terminating
					// still runs a manager that can reconcile what follows.
					Expect(scaleManager(ctx, 0)).To(Succeed())
					Eventually(func() (int, error) { return managerPodCount(ctx) }).
						WithTimeout(2*time.Minute).WithPolling(2*time.Second).
						Should(BeZero(), "the manager after it was scaled to zero")

					// One change it can only find by listing the specs — a spec
					// edit, which no watch was there to deliver.
					Expect(env.Patch(ctx, func(want *aiv1alpha1.DevEnvironment) {
						want.Spec.Network = &aiv1alpha1.NetworkSpec{
							Egress: &aiv1alpha1.EgressSpec{Unrestricted: true},
						}
					})).To(Succeed())

					// And one it can only find by looking: an object it owns that
					// is no longer there. A resync of what the controller knew
					// would not restore this — only a reconcile that renders what
					// the spec asks for does.
					var policy networkingv1.NetworkPolicy
					Expect(conformance.Client.Get(ctx,
						client.ObjectKey{Namespace: env.Namespace, Name: env.Name}, &policy)).To(Succeed())
					Expect(conformance.Client.Delete(ctx, &policy)).To(Succeed())
					// And really gone, so the policy the assertions below find
					// afterwards can only be the new process's work.
					Eventually(func() bool {
						var gone networkingv1.NetworkPolicy
						err := conformance.Client.Get(ctx,
							client.ObjectKey{Namespace: env.Namespace, Name: env.Name}, &gone)
						return apierrors.IsNotFound(err)
					}).WithTimeout(time.Minute).WithPolling(2*time.Second).
						Should(BeTrue(), "the environment's NetworkPolicy after it was deleted")

					// And back. The pod that answers must be a different one: the
					// old one is gone, and a manager that failed to start would
					// otherwise be indistinguishable from one that converged.
					Expect(scaleManager(ctx, replicas)).To(Succeed())
					Expect(waitManagerReady(ctx, before...)).To(Succeed())

					// The policy, restored from the spec as edited rather than as
					// the previous process last saw it: the unrestricted form is a
					// rule that restricts nothing, and it is the field this case
					// changed while nothing was listening.
					Eventually(func() error {
						var got networkingv1.NetworkPolicy
						if err := conformance.Client.Get(ctx,
							client.ObjectKey{Namespace: env.Namespace, Name: env.Name}, &got); err != nil {
							return err
						}
						if len(got.Spec.Egress) != 1 {
							return fmt.Errorf("the re-created policy carries %d egress rules, not the one "+
								"unrestricted rule", len(got.Spec.Egress))
						}
						if len(got.Spec.Egress[0].To) != 0 || len(got.Spec.Egress[0].Ports) != 0 {
							return fmt.Errorf("the re-created policy's egress still restricts something: %v",
								got.Spec.Egress[0])
						}
						return nil
					}).WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(Succeed(), "the NetworkPolicy the restart had to restore")

					// The status the new process wrote is a statement about the
					// spec as it is now, which observedGeneration is how the
					// platform says out loud.
					Eventually(func() error {
						if err := env.Refresh(ctx); err != nil {
							return err
						}
						obj := env.Object()
						if obj.Status.ObservedGeneration != obj.Generation {
							return fmt.Errorf("observedGeneration is %d and the generation is %d",
								obj.Status.ObservedGeneration, obj.Generation)
						}
						return nil
					}).WithTimeout(2*time.Minute).WithPolling(3*time.Second).
						Should(Succeed(), "the status catching up with the edit made while the controller was down")

					// Nothing the restart did reached the workload. The edit it
					// converged is about the NetworkPolicy, so a new pod would be
					// the environment disturbed to reconcile a field that does not
					// describe it.
					nowUID, err := env.PodUID(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(nowUID).To(Equal(podUID),
						"the restart replaced the environment's pod for a change that does not touch its "+
							"template")

					// And the environment stayed usable throughout. Consistently
					// rather than Eventually: it was already Ready, and a poll for
					// a state that already holds proves nothing.
					Consistently(func() error { return env.Ready(ctx) }, 30*time.Second, 5*time.Second).
						Should(Succeed(), "%s did not stay running through the controller's restart", env.Name)
				})
		},
	}.declare()
}

// managerDeployment is the DevEnvironment controller's Deployment, found by
// preflight from the flag it carries rather than assumed by release name.
func managerDeployment(ctx context.Context) (*appsv1.Deployment, error) {
	var d appsv1.Deployment
	key := client.ObjectKey{Namespace: cluster.ManagerNamespace, Name: cluster.ManagerName}
	if err := conformance.Client.Get(ctx, key, &d); err != nil {
		return nil, fmt.Errorf("reading the manager Deployment %s/%s: %w", key.Namespace, key.Name, err)
	}
	return &d, nil
}

// managerPods are the pods the manager's Deployment selects.
func managerPods(ctx context.Context) ([]corev1.Pod, error) {
	d, err := managerDeployment(ctx)
	if err != nil {
		return nil, err
	}
	selector, err := metav1.LabelSelectorAsSelector(d.Spec.Selector)
	if err != nil {
		return nil, fmt.Errorf("reading the manager's pod selector: %w", err)
	}
	var pods corev1.PodList
	if err := conformance.Client.List(ctx, &pods, client.InNamespace(d.Namespace),
		client.MatchingLabelsSelector{Selector: selector}); err != nil {
		return nil, fmt.Errorf("listing the manager's pods: %w", err)
	}
	// Terminating pods count. The case waits for this list to be empty before it
	// edits anything, and a pod with a deletion stamp is a process that may still
	// be reconciling — "gone" has to mean the manager is gone, not that it has
	// been asked to leave.
	return pods.Items, nil
}

func managerPodCount(ctx context.Context) (int, error) {
	pods, err := managerPods(ctx)
	return len(pods), err
}

func managerPodUIDs(ctx context.Context) ([]types.UID, error) {
	pods, err := managerPods(ctx)
	if err != nil {
		return nil, err
	}
	uids := make([]types.UID, 0, len(pods))
	for _, pod := range pods {
		uids = append(uids, pod.UID)
	}
	return uids, nil
}

// scaleManager sets the manager Deployment's replica count.
func scaleManager(ctx context.Context, replicas int32) error {
	d, err := managerDeployment(ctx)
	if err != nil {
		return err
	}
	patch := client.MergeFrom(d.DeepCopy())
	d.Spec.Replicas = &replicas
	if err := conformance.Client.Patch(ctx, d, patch); err != nil {
		return fmt.Errorf("scaling the manager to %d: %w", replicas, err)
	}
	return nil
}

// waitManagerReady waits for a manager pod that is neither one of was nor still
// starting.
//
// The uid is the whole of it: a Deployment recreates a pod under a new name, but
// an old pod that has not gone away would otherwise satisfy "the manager is
// running" while the process that answers is the one this case replaced.
func waitManagerReady(ctx context.Context, was ...types.UID) error {
	deadline := time.Now().Add(3 * time.Minute)
	for {
		pods, err := managerPods(ctx)
		if err != nil {
			return err
		}
		for i := range pods {
			if slices.Contains(was, pods[i].UID) || !podReadyForRestart(&pods[i]) {
				continue
			}
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("no manager pod other than %v was ready within 3m (%d pods listed)",
				was, len(pods))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// podReadyForRestart is whether the pod is running with its containers ready.
func podReadyForRestart(pod *corev1.Pod) bool {
	if pod.Status.Phase != corev1.PodRunning {
		return false
	}
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}
