package controller

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// reconcileHostPorts resolves the node ports a host-network environment binds.
//
// A pod on the pod network has a network namespace of its own, so the port its
// notebook server or sshd listens on belongs to that namespace and the type's
// fixed number is free on every node at once. A RoCE environment has the node's
// namespace instead, which is why it needs the host network at all
// (::rdmaResource): the same fixed number is then taken on the whole node, and
// one environment per node could ever be Running. So the platform brings its own
// numbers to that case — one allocation per environment, recorded in status,
// drawn from a pool of its own rather than the L4 one, whose ports are Gateway
// listeners.
//
// The allocation covers the two ports the platform itself launches: the main
// container's (the notebook server, or sshd for the ssh type) and sshd's when it
// runs beside another type. spec.ports are the user's own numbers and stay as
// declared: the application binds what the spec says, so the controller has no
// way to move it, and a host-network environment whose extra ports collide on a
// node says so by failing to schedule.
//
// A vscode environment is left alone. The platform's images do not implement
// that type, so there is no launcher to tell about the port; it keeps its fixed
// one and remains exclusive per node, which is the state it was already in.
func (r *DevEnvironmentReconciler) reconcileHostPorts(ctx context.Context, env *aiv1alpha1.DevEnvironment) (*aiv1alpha1.HostPorts, error) {
	if _, hostNetwork := r.rdmaResource(env); !hostNetwork {
		return nil, nil
	}
	if env.Spec.Type == aiv1alpha1.DevEnvironmentTypeVSCode {
		return nil, nil
	}
	cfg := r.defaultedConfig()
	used, err := r.usedHostPorts(ctx, env)
	if err != nil {
		return nil, err
	}
	// The environment's own record is kept while the port is still free, so the
	// address a user is shown and the port its workload binds do not move on a
	// reconcile that changed nothing about the environment.
	held := env.Status.HostPorts
	main, ok := allocateHostPort(heldMain(held), used, cfg.HostPortRangeStart, cfg.HostPortRangeEnd)
	if !ok {
		return nil, fmt.Errorf("no free host port in the range %d-%d", cfg.HostPortRangeStart, cfg.HostPortRangeEnd)
	}
	ports := &aiv1alpha1.HostPorts{Main: main}
	if sshExposed(env) && env.Spec.Type != aiv1alpha1.DevEnvironmentTypeSSH {
		ssh, ok := allocateHostPort(heldSSH(held), used, cfg.HostPortRangeStart, cfg.HostPortRangeEnd)
		if !ok {
			return nil, fmt.Errorf("no free host port in the range %d-%d", cfg.HostPortRangeStart, cfg.HostPortRangeEnd)
		}
		ports.SSH = ssh
	}
	return ports, nil
}

// announcedAllocation is what a status write before the apply may state: the
// allocation this pass resolved, plus any number it no longer uses but whose
// workload has not been replaced yet. A move off the host network resolves no
// ports, and turning SSH off drops the sshd port alone; the workload on either
// keeps binding them until the StatefulSet is re-applied — releasing the number
// first would hand it back to the pool while a pod still holds it, and the
// environment that drew it would not schedule. The release is ::settledAllocation.
func announcedAllocation(resolved, held *aiv1alpha1.HostPorts) *aiv1alpha1.HostPorts {
	if resolved == nil {
		return held
	}
	if held == nil || held.SSH == 0 || resolved.SSH != 0 {
		return resolved
	}
	// Only the ssh port can be dropped this way: ::allocateHostPort keeps the main
	// one whenever the pool still contains it, and a number the pool no longer
	// contains is one it cannot hand out again.
	announced := *resolved
	announced.SSH = held.SSH
	return &announced
}

// settledAllocation is what the status may record once the workload has been
// re-applied: the allocation this pass resolved, as soon as no pod binds the one
// still announced. A StatefulSet replaces its pod by deleting it and creating the
// next, so the pass that applies a new template still sees the outgoing pod; a
// later pass finds it gone and the numbers go back to the pool with that write.
func settledAllocation(resolved, announced *aiv1alpha1.HostPorts, pod *corev1.Pod) *aiv1alpha1.HostPorts {
	if announced == nil || !bindsPort(pod, announced) {
		return resolved
	}
	return announced
}

// bindsPort reports whether the pod still holds one of an allocation's numbers
// on its node. A pod on the pod network has a network namespace of its own, so
// none of its ports is the node's.
func bindsPort(pod *corev1.Pod, ports *aiv1alpha1.HostPorts) bool {
	if pod == nil || !pod.Spec.HostNetwork {
		return false
	}
	for _, container := range pod.Spec.Containers {
		for _, p := range container.Ports {
			if ports.Main != 0 && p.ContainerPort == ports.Main {
				return true
			}
			if ports.SSH != 0 && p.ContainerPort == ports.SSH {
				return true
			}
		}
	}
	return false
}

// withHostPorts returns a copy of env that resolves ports against the allocation
// a pass computed rather than against the one the status still records. A pass
// that moves an environment off the host network reads an allocation that is on
// its way out — the workload it belongs to is still running until the
// StatefulSet is re-applied — so anything reasoning about which container port
// the platform's Service forwards to has to be handed what this pass resolved
// (::reconcileHostPorts, ::resolvedMainPort).
func withHostPorts(env *aiv1alpha1.DevEnvironment, hostPorts *aiv1alpha1.HostPorts) *aiv1alpha1.DevEnvironment {
	resolved := env.DeepCopy()
	resolved.Status.HostPorts = hostPorts
	return resolved
}

// hostPortsForPass resolves the ports the pass needs, and tolerates a failed
// allocation on a pass that only scales the environment down. A stop is the user
// asking for the one state a failed allocation would deny — nothing running — so
// it goes ahead with what is already recorded: the workload is scaled to zero,
// and the next pass that wants the environment to run reports the failure.
func (r *DevEnvironmentReconciler) hostPortsForPass(ctx context.Context, env *aiv1alpha1.DevEnvironment) (*aiv1alpha1.HostPorts, error) {
	hostPorts, err := r.reconcileHostPorts(ctx, env)
	if err == nil {
		return hostPorts, nil
	}
	if env.Spec.Running && !autoStopped(env) {
		return nil, err
	}
	if held := env.Status.HostPorts; held != nil {
		return held.DeepCopy(), nil
	}
	return nil, nil
}

// usedHostPorts is every host port the cluster is known to bind, so the pool is
// drawn from cluster-wide rather than per node. An environment is scheduled onto
// a node only after it is created, and keeping the allocation unique across the
// cluster is what makes it valid on whichever node the pod lands on.
//
// Two sources are read: the allocation each environment records, and the ports a
// host-network environment declares in spec.ports, which are the user's numbers
// and would otherwise be invisible to the pool.
//
// The List goes through APIReader rather than the cache, for the reason
// ::usedPorts does: allocation is a read followed by a status write, and an
// environment reconciled inside the window before the cache catches up would
// read a pool that does not contain the port the previous reconcile just took.
// Reconciles are serialized (MaxConcurrentReconciles is pinned to 1), so reading
// past the cache is enough to close the window.
func (r *DevEnvironmentReconciler) usedHostPorts(ctx context.Context, env *aiv1alpha1.DevEnvironment) (map[int32]bool, error) {
	var list aiv1alpha1.DevEnvironmentList
	if err := r.APIReader.List(ctx, &list); err != nil {
		return nil, err
	}
	used := make(map[int32]bool, 2*len(list.Items))
	for i := range list.Items {
		other := &list.Items[i]
		if other.Namespace == env.Namespace && other.Name == env.Name {
			continue
		}
		if held := other.Status.HostPorts; held != nil {
			if held.Main != 0 {
				used[held.Main] = true
			}
			if held.SSH != 0 {
				used[held.SSH] = true
			}
		}
		if _, hostNetwork := r.rdmaResource(other); hostNetwork {
			for _, p := range other.Spec.Ports {
				used[p.ContainerPort] = true
			}
		}
	}
	// The environment's own declared ports are its to bind too, and an allocation
	// landing on one of them would keep its own application off the node.
	for _, p := range env.Spec.Ports {
		used[p.ContainerPort] = true
	}
	return used, nil
}

// allocateHostPort reuses the port the environment already holds when it is
// still in range and free, and otherwise takes the lowest free one, marking the
// choice used so a second port for the same environment cannot be the same one.
func allocateHostPort(held int32, used map[int32]bool, start, end int32) (int32, bool) {
	if held >= start && held <= end && !used[held] {
		used[held] = true
		return held, true
	}
	for p := start; p <= end; p++ {
		if !used[p] {
			used[p] = true
			return p, true
		}
	}
	return 0, false
}

func heldMain(held *aiv1alpha1.HostPorts) int32 {
	if held == nil {
		return 0
	}
	return held.Main
}

func heldSSH(held *aiv1alpha1.HostPorts) int32 {
	if held == nil {
		return 0
	}
	return held.SSH
}

// resolvedMainPort is the port the environment's main container listens on: the
// allocation for a host-network environment, the type's fixed port otherwise.
// The Service port is not this one — it stays the conventional number and the
// targetPort moves — so only the container side reads this.
func resolvedMainPort(env *aiv1alpha1.DevEnvironment) int32 {
	if held := env.Status.HostPorts; held != nil && held.Main != 0 {
		return held.Main
	}
	return mainContainerPort(env.Spec.Type)
}

// resolvedSSHPort is the port sshd listens on: the allocation for a host-network
// environment, the base images' fixed port otherwise. The ssh type's main port
// is sshd's own, so its allocation is the one that applies there.
func resolvedSSHPort(env *aiv1alpha1.DevEnvironment) int32 {
	held := env.Status.HostPorts
	if held == nil {
		return sshContainerPort
	}
	if env.Spec.Type == aiv1alpha1.DevEnvironmentTypeSSH {
		return resolvedMainPort(env)
	}
	if held.SSH != 0 {
		return held.SSH
	}
	return sshContainerPort
}
