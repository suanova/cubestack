//go:build e2e
// +build e2e

package e2e

import (
	"context"
	"fmt"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/test/e2e/devenv"
)

// Family H: storage and workspace (§4.H).
//
// The workspace is the one thing a user can lose silently. A container that
// comes up with a home it cannot write fails loudly; one whose home is writable
// but is not the claim — an emptyDir, or the image's own overlay path — comes up
// green and drops the work at the next restart. So the cases here are about
// which directory the session is actually in, who owns it, and whether what is
// under it outlives the pod.
//
// H1 and H4 ride the matrix: the first is a claim about every environment the
// platform builds, and the second is a property of the claim every one of them
// gets. The rest each draft an environment, because each is about a spec field
// the catalogue does not set.

// describeStorage declares H1 and H4 for one environment.
func describeStorage(open func() *devenv.Environment, img devenv.Image) {
	It("H1 gives the workspace to the environment's own identity before the session uses it",
		Label(devenv.TierP1, devenv.LabelFamily("H")), func(ctx SpecContext) {
			env := open()

			// Read off the pod rather than off the catalogue: the numbers the
			// platform pinned the process to are the numbers it had to make the
			// workspace writable for, and a case that brought its own idea of the
			// identity could pass while the pod ran as somebody else. The
			// securityContext is the container's, not the pod's — the platform sets
			// it there.
			pod, err := env.Pod(ctx)
			Expect(err).NotTo(HaveOccurred())
			uid, gid := containerIdentity(pod)

			// The init container is the platform's statement of what it intends.
			var init *corev1.Container
			for i := range pod.Spec.InitContainers {
				if pod.Spec.InitContainers[i].Name == devenv.InitContainerName {
					init = &pod.Spec.InitContainers[i]
				}
			}
			Expect(init).NotTo(BeNil(),
				"the pod runs no %s init container, so nothing established the workspace's ownership",
				devenv.InitContainerName)
			Expect(init.Env).To(ContainElement(
				corev1.EnvVar{Name: devenv.InitWorkspacePathEnv, Value: devenv.InitContainerClaimMount}))
			Expect(init.Env).To(ContainElement(
				corev1.EnvVar{Name: devenv.InitWorkspaceUIDEnv, Value: uid}))
			Expect(init.Env).To(ContainElement(
				corev1.EnvVar{Name: devenv.InitWorkspaceGIDEnv, Value: gid}))

			// And this is whether it did it. The session is asked about the path the
			// platform mounted rather than about $HOME, so the assertion is about
			// the claim and not about a variable that could agree with the intent
			// while pointing somewhere else.
			mount, err := env.WorkspaceMountPath(ctx)
			Expect(err).NotTo(HaveOccurred())
			owner := strings.TrimSpace(sshOutput(ctx, env, `stat -c '%u:%g' '`+mount+`'`))
			Expect(owner).To(Equal(uid+":"+gid),
				"the workspace at %s is owned by %s while the environment runs as %s:%s: "+
					"the account cannot write its own home",
				mount, owner, uid, gid)

			// Ownership is the platform's whole claim here, so the case also shows
			// the consequence a user meets rather than only the number that implies
			// it. It is written by the account itself and not by the init container,
			// which is what makes it a statement about the account.
			sshOutput(ctx, env, `touch '`+mount+`/.e2e-owned' && test -w '`+mount+`'`)
		})

	It("H4 asks for the workspace in an access mode that does not pin it to a node",
		Label(devenv.TierP1, devenv.LabelFamily("H")), func(ctx SpecContext) {
			env := open()

			// The design's claim is that the workspace follows a pod that lands on
			// another node, and this cluster has one node: the movement cannot be
			// performed here, and a case that faked it would assert nothing. What
			// can be checked is the property that makes it possible — the access
			// mode the claim was provisioned with. A ReadWriteOnce workspace is the
			// failure this row exists to catch, because it fails the *second* start,
			// on the node the scheduler moved the pod to, long after the run that
			// created it went green. ReadWriteMany is not sufficient for the move on
			// every driver, but it is necessary, and nothing weaker is even possible.
			pvc, err := env.WorkspaceClaimObject(ctx)
			Expect(err).NotTo(HaveOccurred())
			Expect(pvc.Spec.AccessModes).To(ContainElement(corev1.ReadWriteMany),
				"the workspace %s/%s carries %v, so it cannot be re-attached anywhere but the node "+
					"that first mounted it", pvc.Namespace, pvc.Name, pvc.Spec.AccessModes)
		})
}

// containerIdentity is the uid and gid the platform pinned the environment's
// container to, as the strings the init container's env carries them.
func containerIdentity(pod *corev1.Pod) (uid, gid string) {
	GinkgoHelper()
	Expect(pod.Spec.Containers).NotTo(BeEmpty(), "pod %s runs no containers", pod.Name)
	sc := pod.Spec.Containers[0].SecurityContext
	Expect(sc).NotTo(BeNil(), "the container of %s states no securityContext", pod.Name)
	Expect(sc.RunAsUser).NotTo(BeNil(), "the container of %s states no runAsUser", pod.Name)
	Expect(sc.RunAsGroup).NotTo(BeNil(), "the container of %s states no runAsGroup", pod.Name)
	return fmt.Sprintf("%d", *sc.RunAsUser), fmt.Sprintf("%d", *sc.RunAsGroup)
}

// describeStorageCases declares H2, H3 and H5, each on an environment it shapes.
func describeStorageCases() {
	describeMountPath()
	describeVolumes()
}

// describeMountPath is H2 and H5, which are two readings of one environment.
//
// They share it because each is about a field of the same small struct and
// neither needs the other's state changed underneath it: the case declares the
// spec once and asks a different question of the cluster that came out. H5's
// second half — an unsupported StorageClass — is not executable here and is
// noted rather than dropped: the class is the platform's to choose
// (`cephfs-ephemeral`, hardcoded), so a spec cannot name one the cluster does
// not have, and there is no such thing as a DevEnvironment on an unsupported
// class to assert against.
func describeMountPath() {
	// The path the spec pins, and deliberately not the one the identity implies:
	// the derived path for this image is /home/ubuntu, which is also the home the
	// image bakes, so a run that ignored the override would land on the same
	// directory either way.
	const pinned = "/workspace-x"
	const size = "3Gi"

	draftCase{
		Name:     "storage-mount-path",
		Image:    devenv.MustImage("ssh-ubuntu22.04"),
		Identity: devenv.NonRoot,
		Shape: func(want *aiv1alpha1.DevEnvironment) {
			want.Spec.Storage.MountPath = pinned
			want.Spec.Storage.Size = size
		},
		Cases: func(open func() *devenv.Environment) {
			It("H2 mounts the workspace where the spec says, and a session's home stays its account's",
				Label(devenv.TierP1, devenv.LabelFamily("H")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					mount, err := env.WorkspaceMountPath(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(mount).To(Equal(pinned),
						"the workspace is mounted at %s and the spec pinned it at %s", mount, pinned)

					// The container is stated the path, so a launcher that serves the
					// home it is handed serves the workspace. Asserted on the pod as
					// well as in the session because they fail apart: the variable can
					// be right while the mount is elsewhere, and then the session's
					// home is a directory on the image's own filesystem.
					pod, err := env.Pod(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(containerEnv(pod)).To(HaveKeyWithValue(devenv.EnvHome, pinned))

					// The session's home is not the mount path, and is not meant to
					// be: mountPath says where the claim is mounted, while a login
					// account's home is a property of the image's passwd entry, which
					// sshd reads for each session and no environment variable moves.
					// The two agree on every default environment because the platform
					// derives the mount path from the account, which is exactly why
					// this is the one case that can tell them apart — pinning a path
					// the account does not use. E6 asserts the other half: that a HOME
					// the spec declares does not reach the container either.
					//
					// Read from the image rather than written here, so the assertion
					// is "the session gets its account's home" and not a second copy
					// of /home/ubuntu.
					home := strings.TrimSpace(sshOutput(ctx, env, `printf '%s' "$HOME"`))
					declared := strings.TrimSpace(sshOutput(ctx, env,
						`getent passwd "$(id -un)" | cut -d: -f6`))
					Expect(declared).NotTo(BeEmpty(), "the account has no home in the image's passwd")
					Expect(home).To(Equal(declared),
						"the session's HOME is %s and its account's is %s", home, declared)
					Expect(home).NotTo(Equal(pinned),
						"the session's HOME follows the mount path, so a login session is no longer "+
							"reading the image's account and the workspace is something the mount alone decides")
					sshOutput(ctx, env, `test -w "$HOME"`)
				})

			It("H5 provisions the claim at the size the spec asks for",
				Label(devenv.TierP1, devenv.LabelFamily("H")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					// The failure this catches is silent by construction: a size that
					// the controller dropped on the way to the claim, or that the
					// provisioner ignored, leaves an environment that runs, is Ready,
					// and fills up months later. So the case reads the claim the
					// cluster actually has — and reads it as Bound, because a claim
					// that is Pending is one that was created and rejected rather than
					// provisioned.
					pvc, err := env.WorkspaceClaimObject(ctx)
					Expect(err).NotTo(HaveOccurred())

					want := resource.MustParse(size)
					asked := pvc.Spec.Resources.Requests[corev1.ResourceStorage]
					Expect(asked.Cmp(want)).To(Equal(0),
						"the workspace %s asks for %s and the spec declared %s: %v",
						pvc.Name, asked.String(), size, pvc.Spec.Resources.Requests)

					Expect(pvc.Status.Phase).To(Equal(corev1.ClaimBound),
						"the workspace %s is %s rather than provisioned: %s",
						pvc.Name, pvc.Status.Phase, objectEvents(ctx, "PersistentVolumeClaim", pvc.Name))

					// Bound at the size asked for, not merely Bound: a provisioner
					// that quietly gave less would leave the same green environment and
					// the same later surprise.
					got, ok := pvc.Status.Capacity[corev1.ResourceStorage]
					Expect(ok).To(BeTrue(), "the workspace %s reports no capacity: %v",
						pvc.Name, pvc.Status.Capacity)
					Expect(got.Cmp(want)).To(BeNumerically(">=", 0),
						"the workspace %s was provisioned at %s for a spec that declared %s",
						pvc.Name, got.String(), size)
				})
		},
	}.declare()
}

// describeVolumes is H3: the user's own storage, mounted alongside the platform's.
//
// It is the one case here that needs a cluster object before the environment
// exists, because `spec.volumes[]` references a claim that already has to be
// there — the platform never creates one for a user.
//
// Three claims, each mounted once. One claim mounted three times is what the case
// would rather ask, and cannot: on the reference cluster a pod that references a
// cephfs claim twice never starts. Measured there with a hand-written pod, so it
// is the cluster's storage and not anything this platform renders — rw+rw,
// rw+readOnly, and a claim beside its own subdirectory, all sat in
// ContainerCreating for ten minutes with the CSI node plugin silent and no
// FailedMount event, while the same three mounts against three distinct claims
// ran immediately. So each question below is asked of a claim of its own.
//
// What puts the markers in them is then a loader pod that mounts each claim
// whole, because the environment cannot: it is handed one of them read-only and
// another narrowed to a subdirectory, and both assertions are about what those
// mounts must not show.
func describeVolumes() {
	// The StorageClass the platform itself hardcodes for the workspace claim, so a
	// cluster running these cases has it — and ReadWriteMany because the workspace
	// is; a class that could not serve this claim could not serve the environment's
	// own either. It is a constant rather than read from the workspace claim
	// because Prepare runs before there is an environment to read one from.
	const (
		storageClass = "cephfs-ephemeral"

		claimName    = "storage-volumes-data"
		roClaimName  = "storage-volumes-data-ro"
		subClaimName = "storage-volumes-data-sub"

		subPath = "sub"

		// What the loader leaves, as file names: one at each claim's own root,
		// which a mount that ignored subPath would show and a narrowed one must
		// not, and one inside the subdirectory a narrowed mount is narrowed to.
		rootFile = ".e2e-h3-root"
		leafFile = ".e2e-h3-leaf"
	)

	// The three mounts, and why each is a different question: a second path is a
	// mount the platform has to place; readOnly is one it has to respect; subPath
	// is one it has to narrow. A platform that mounted every reference the same
	// way would satisfy the first and fail the other two.
	shaped := func(want *aiv1alpha1.DevEnvironment) {
		want.Spec.Storage.MountPath = "/workspace-volumes"
		want.Spec.Volumes = []aiv1alpha1.VolumeMount{
			{Name: "data", PVCName: claimName, MountPath: "/data"},
			{Name: "data-ro", PVCName: roClaimName, MountPath: "/data-ro", ReadOnly: true},
			{Name: "data-sub", PVCName: subClaimName, MountPath: "/sub", SubPath: subPath},
		}
	}

	draftCase{
		Name:     "storage-volumes",
		Image:    devenv.MustImage("ssh-ubuntu22.04"),
		Identity: devenv.NonRoot,
		Shape:    shaped,
		Prepare: func(ctx context.Context) error {
			for _, claim := range []string{claimName, roClaimName, subClaimName} {
				if err := prepareClaim(ctx, claim, storageClass); err != nil {
					return err
				}
			}
			return loadVolumeMarkers(ctx, fmt.Sprintf(volumeLoaderScript, rootFile, leafFile, subPath),
				claimName, roClaimName, subClaimName)
		},
		Cases: func(open func() *devenv.Environment) {
			It("H3 mounts a referenced claim at its path, read-only as asked, and narrowed by subPath",
				Label(devenv.TierP1, devenv.LabelFamily("H")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					// What the platform was asked for, on the pod: three mounts, and
					// the read-only one carrying the flag through to the mount.
					pod, err := env.Pod(ctx)
					Expect(err).NotTo(HaveOccurred())
					mounts := map[string]corev1.VolumeMount{}
					for _, m := range pod.Spec.Containers[0].VolumeMounts {
						mounts[m.Name] = m
					}
					for _, name := range []string{"data", "data-ro", "data-sub"} {
						Expect(mounts).To(HaveKey(name),
							"the pod mounts no %q volume, so the spec.volumes entry was dropped", name)
					}
					Expect(mounts["data-ro"].ReadOnly).To(BeTrue(),
						"the read-only mount reached the container writable")
					Expect(mounts["data-sub"].SubPath).To(Equal(subPath))

					// The control the read-only assertion needs: a platform that made
					// every mount read-only would satisfy everything below about the
					// second one.
					sshOutput(ctx, env, `printf 'own' > /data/.e2e-h3-owned`)

					// And the read-only mount carries the storage it was given, so
					// the refusal below is about the mount and not about an empty
					// volume.
					content := strings.TrimSpace(sshOutput(ctx, env, `cat /data-ro/`+rootFile))
					Expect(content).To(Equal("root"),
						"the read-only mount does not show what is in the claim it was handed")

					res := sshRun(ctx, env, `touch /data-ro/.e2e-h3-probe`)
					Expect(res.ExitCode).NotTo(Equal(0),
						"a write through the read-only mount succeeded: %s", res.Stdout)

					// And the third is narrowed: the subdirectory is visible, the
					// claim's root is not. A platform that ignored subPath would mount
					// the whole claim at /sub and pass every assertion above.
					leaf := strings.TrimSpace(sshOutput(ctx, env, `cat /sub/`+leafFile))
					Expect(leaf).To(Equal("inner"),
						"the subPath mount does not show the subdirectory's contents")
					listed := sshOutput(ctx, env, `ls -A /sub`)
					Expect(listed).NotTo(ContainSubstring(rootFile),
						"the subPath mount lists the claim's root (%q), so it is not narrowed to %q",
						listed, subPath)
				})
		},
	}.declare()
}

// volumeLoaderScript writes the markers H3 asserts on, from a pod that mounts
// each claim whole. The paths are this pod's own and are not the environment's:
// the environment is handed one claim read-only and another narrowed to a
// subdirectory, so it can write to neither the claim it must only read nor the
// root of the claim it must not see.
//
// The chmod is what lets the environment's own uid write to the first, which is
// not the uid this pod runs as. It does not weaken the read-only assertion below
// it: that refusal is the mount's, and a mount the platform left writable would
// let the write through whatever the directory mode says.
//
// The names are the case's — the markers, and the subdirectory the third claim
// is narrowed to — so what is written and what is read cannot drift apart.
const volumeLoaderScript = `
set -e
chmod 0777 /data /data-ro /data-sub
printf 'root' > /data/%[1]s
printf 'root' > /data-ro/%[1]s
mkdir -p /data-sub/%[3]s
printf 'inner' > /data-sub/%[3]s/%[2]s
printf 'root' > /data-sub/%[1]s
`

// volumeLoaderMounts are where the loader mounts the case's three claims, in the
// order it is handed them, and are the paths volumeLoaderScript writes to.
var volumeLoaderMounts = []string{"/data", "/data-ro", "/data-sub"}

// volumeLoaderName is the loader pod's name.
const volumeLoaderName = "storage-volumes-loader"

// loadVolumeMarkers runs volumeLoaderScript and waits for it to finish.
//
// The pod is the case's, so the image is the case's too and the loader costs no
// pull the environment does not already pay for. It mounts each claim once,
// which is the constraint describeVolumes records: the three paths below are the
// ones the script names, and a claim mounted somewhere else fails the loader
// loudly rather than quietly writing nothing.
func loadVolumeMarkers(ctx context.Context, script, data, ro, sub string) error {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: volumeLoaderName, Namespace: conformance.Namespace},
		Spec: corev1.PodSpec{
			RestartPolicy: corev1.RestartPolicyNever,
			Containers: []corev1.Container{{
				Name:    "load",
				Image:   devenv.MustImage("ssh-ubuntu22.04").Ref(),
				Command: []string{"sh", "-c", script},
				// Root, because the image lands on its own account, which does not
				// own the directory it would have to chmod.
				SecurityContext: &corev1.SecurityContext{RunAsUser: ptr(int64(0))},
			}},
		},
	}
	for i, claim := range []string{data, ro, sub} {
		name := fmt.Sprintf("claim-%d", i)
		pod.Spec.Volumes = append(pod.Spec.Volumes, corev1.Volume{
			Name: name,
			VolumeSource: corev1.VolumeSource{
				PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: claim},
			},
		})
		pod.Spec.Containers[0].VolumeMounts = append(pod.Spec.Containers[0].VolumeMounts,
			corev1.VolumeMount{Name: name, MountPath: volumeLoaderMounts[i]})
	}

	switch err := conformance.Client.Create(ctx, pod); {
	case err == nil:
	case apierrors.IsAlreadyExists(err):
		// A previous run in this namespace — the run's own, so this one reuses
		// whatever it finds rather than treating it as a foreign object.
	default:
		return fmt.Errorf("creating the volume loader: %w", err)
	}

	deadline := time.Now().Add(3 * time.Minute)
	for {
		var got corev1.Pod
		if err := conformance.Client.Get(ctx, client.ObjectKeyFromObject(pod), &got); err != nil {
			return fmt.Errorf("reading the volume loader back: %w", err)
		}
		switch got.Status.Phase {
		case corev1.PodSucceeded:
			return nil
		case corev1.PodFailed:
			return fmt.Errorf("the volume loader failed: %s", objectEvents(ctx, "Pod", got.Name))
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the volume loader is %s after 3m: %s",
				got.Status.Phase, objectEvents(ctx, "Pod", got.Name))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// prepareClaim creates the claim a spec.volumes entry references, and waits for
// it to be provisioned.
//
// The wait is here rather than left to the environment's own timeout because a
// claim that never binds is otherwise reported twenty minutes later as a pod
// that never came up, which points at the workload instead of at the storage.
func prepareClaim(ctx context.Context, name, class string) error {
	// 1Gi is this suite's floor for a workspace and more than the case writes; the
	// subject is the mount options, and the size is H5's.
	claim := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: conformance.Namespace},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany},
			StorageClassName: ptr(class),
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("1Gi")},
			},
		},
	}
	err := conformance.Client.Create(ctx, claim)
	switch {
	case err == nil:
	case apierrors.IsAlreadyExists(err):
		// A previous run of this case left it behind — it is in the run's own
		// namespace, so it is this run's to reuse rather than a foreign object.
	default:
		return fmt.Errorf("creating the claim %s/%s: %w", claim.Namespace, claim.Name, err)
	}

	deadline := time.Now().Add(2 * time.Minute)
	for {
		var got corev1.PersistentVolumeClaim
		key := client.ObjectKey{Namespace: claim.Namespace, Name: claim.Name}
		if err := conformance.Client.Get(ctx, key, &got); err != nil {
			return fmt.Errorf("reading the claim %s back: %w", key, err)
		}
		if got.Status.Phase == corev1.ClaimBound {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the claim %s/%s is %s after 2m and nothing provisioned it on class %q",
				got.Namespace, got.Name, got.Status.Phase, class)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// ptr is the one-line helper the API's pointer fields need.
func ptr[T any](v T) *T { return &v }

// objectEvents is the tail of a failure message: why an object did not get where
// it was going is in the events on it, and a case that reported only the phase
// would leave the reader to go and look.
func objectEvents(ctx context.Context, kind, name string) string {
	var events corev1.EventList
	if err := conformance.Client.List(ctx, &events, client.InNamespace(conformance.Namespace)); err != nil {
		return "the events could not be read: " + err.Error()
	}
	var b strings.Builder
	for i := range events.Items {
		e := &events.Items[i]
		if e.InvolvedObject.Kind != kind || e.InvolvedObject.Name != name {
			continue
		}
		fmt.Fprintf(&b, "; %s: %s", e.Reason, truncate(e.Message))
	}
	if b.Len() == 0 {
		return "no events mention it"
	}
	return "events on " + name + b.String()
}
