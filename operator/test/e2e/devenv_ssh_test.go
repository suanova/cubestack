//go:build e2e
// +build e2e

package e2e

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"golang.org/x/crypto/ssh"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
	"github.com/suanova/cubestack/test/e2e/devenv"
)

// Family I: the SSH contract beyond logging in (§4.I).
//
// Family B asks whether the login works. These ask who else it admits, what
// happens when the material behind it changes, and what the platform does when
// that material stops being usable — which is where an environment can be left
// serving a credential nobody meant it to serve, or serving nothing at all with
// nothing to report.
//
// None of them rides the matrix. Every case here either shapes a spec the
// catalogue would never build — a delegated keys Secret, a withdrawn exposure —
// or changes the environment's own ssh material underneath a running workload,
// and a matrix environment is shared by eight other families that would inherit
// the result.

func describeSSHContract() {
	describeDelegatedKeys()
	describeUndelegatedKeys()
	describeHostKeyRepair()
	describeSSHWithdrawal()
	describeLiveUndelegation()
}

// --- the material the cases use -----------------------------------------------

// sshKey is a keypair a case owns, with the one-line public form that goes into
// an authorized_keys file or into a delegated Secret's data.
type sshKey struct {
	Signer ssh.Signer
	Line   string
}

func newSSHKey() (sshKey, error) {
	signer, err := devenv.NewClientKey()
	if err != nil {
		return sshKey{}, err
	}
	// MarshalAuthorizedKey renders the standard one-line form, which is also what
	// `ssh-copy-id` appends. Trimmed because the file may carry several and the
	// newline belongs to the writer, not to the key.
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	return sshKey{Signer: signer, Line: line}, nil
}

// authorizedKeys is the file body for a set of keys: one per line, which is the
// format sshd reads from every path its AuthorizedKeysFile names.
func authorizedKeys(keys ...sshKey) []byte {
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(k.Line)
		b.WriteString("\n")
	}
	return []byte(b.String())
}

// pkcs8HostKey renders a host key in the one format sshd cannot read.
//
// The controller's repair exists for this: an environment's host key is an
// OpenSSH-format ed25519 key, and a PKCS#8 block — what a generic tool writes —
// is a well-formed PEM that sshd rejects at startup. Overwriting the managed
// Secret with one is how a case puts an environment into the state the repair is
// for.
func pkcs8HostKey() (privPEM, pubLine []byte, err error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, nil, err
	}
	privPEM = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return nil, nil, err
	}
	return privPEM, ssh.MarshalAuthorizedKey(sshPub), nil
}

// The managed Secret's data keys, restated from the controller. The public half
// is informational — sshd derives it from the private key — so the replacement
// carries both, and replacing only the private one would leave the Secret
// describing a key it no longer holds.
const (
	hostKeyDataKey    = "ssh_host_ed25519_key"
	hostPubKeyDataKey = "ssh_host_ed25519_key.pub"
)

// The delegation label, restated. A Secret without it may not back an
// environment's authorized_keys: the workload mounts the referenced Secret
// straight into the container, so an undelegated reference would let an
// environment's creator read any same-namespace Secret from inside it.
const sshKeysDelegatedLabel = "ai.cubestack.io/ssh-keys-delegated"

// --- I1: a Secret that never opted in -----------------------------------------

// describeUndelegatedKeys is I1.
func describeUndelegatedKeys() {
	const (
		envName = "ssh-undelegated-keys"
		// The data key the case's selector names. What is mounted is the selected
		// entry, so the case also proves the selection is honoured rather than a
		// conventional filename assumed.
		dataKey = "team_keys"
		secret  = "ssh-undelegated-keys-keys"
	)

	var key sshKey

	draftCase{
		Name:     envName,
		Image:    devenv.MustImage("ssh-ubuntu22.04"),
		Identity: devenv.NonRoot,
		Prepare: func(ctx context.Context) error {
			var err error
			if key, err = newSSHKey(); err != nil {
				return err
			}
			// No delegation label: the Secret is well-formed, readable, and carries
			// exactly the key the selector names. The only thing wrong with it is
			// that it never opted in, which is why nothing else here is wrong.
			return createSecret(ctx, secret,
				map[string][]byte{dataKey: authorizedKeys(key)}, nil)
		},
		Shape: func(want *aiv1alpha1.DevEnvironment) {
			want.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				AuthorizedKeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: secret},
					Key:                  dataKey,
				},
			}
		},
		Cases: func(open func() *devenv.Environment) {
			It("I1 refuses an authorized-keys Secret that never opted in",
				Label(devenv.TierP1, devenv.LabelFamily("I")), func(ctx SpecContext) {
					env := open()

					// The controller has looked at it: the finalizer is added on the
					// first pass, before anything is provisioned. Waiting for it is
					// what makes the absences below findings rather than a race with a
					// reconcile that has not run yet.
					Eventually(func() ([]string, error) {
						if err := env.Refresh(ctx); err != nil {
							return nil, err
						}
						return env.Object().Finalizers, nil
					}).WithTimeout(time.Minute).WithPolling(2*time.Second).
						Should(ContainElement(devenv.DevEnvFinalizer),
							"the controller never took %s on", env.Name)

					// And then, having looked at it, provisioned nothing. Asserted over
					// a window rather than at an instant: what could go wrong is that
					// the refusal is a *delay* — the workload comes up a reconcile
					// later — and an instantaneous check would not see it.
					Consistently(func() error {
						pods, err := env.Pods(ctx)
						if err != nil {
							return err
						}
						if len(pods) > 0 {
							return fmt.Errorf("the environment is running a pod: %s", podNames(pods))
						}
						if err := env.Refresh(ctx); err != nil {
							return err
						}
						if phase := env.Object().Status.Phase; phase != nil && phase.Name == aiv1alpha1.PhaseRunning {
							return errors.New("the environment reached Running")
						}
						return nil
					}).WithTimeout(30*time.Second).WithPolling(3*time.Second).
						Should(Succeed(), "an environment on an undelegated keys Secret")

					// The two Secrets the platform mints for an exposed environment: the
					// host identity, which exists once ssh is served, and the client key,
					// which it mints only when the spec names no delegated source. Neither
					// being there is what "nothing was provisioned" means concretely, and
					// the client key is checked as the *object* rather than only through
					// status, since a key nothing names would still be one that logs in.
					Expect(secretExists(ctx, env.SSHHostKeySecretName())).To(BeFalse(),
						"the platform minted a host key for an environment it should have refused")
					Expect(secretExists(ctx, env.SSHClientKeySecretName())).To(BeFalse(),
						"the platform minted a login key for an environment it should have refused")
					Expect(env.Object().Status.SSHClientKeySecret).To(BeNil())
				})
		},
	}.declare()
}

// --- I2, I6, I7: the user's own keys ------------------------------------------

// describeDelegatedKeys is I2, I6 and I7, on one environment that delegates.
func describeDelegatedKeys() {
	const (
		envName = "ssh-delegated-keys"
		// Deliberately not "authorized_keys": what the workload mounts is the entry
		// the selector *names*, so a platform that assumed the conventional key
		// would serve nobody here.
		dataKey = "team_keys"
		secret  = "ssh-delegated-keys-keys"
	)

	var keyA, keyB sshKey

	draftCase{
		Name:     envName,
		Image:    devenv.MustImage("ssh-ubuntu22.04"),
		Identity: devenv.NonRoot,
		Prepare: func(ctx context.Context) error {
			var err error
			if keyA, err = newSSHKey(); err != nil {
				return err
			}
			if keyB, err = newSSHKey(); err != nil {
				return err
			}
			return createSecret(ctx, secret,
				map[string][]byte{dataKey: authorizedKeys(keyA, keyB)},
				map[string]string{sshKeysDelegatedLabel: "true"})
		},
		Shape: func(want *aiv1alpha1.DevEnvironment) {
			want.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				AuthorizedKeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: secret},
					Key:                  dataKey,
				},
			}
		},
		Cases: func(open func() *devenv.Environment) {
			It("I7 admits every key the delegated Secret carries, and no other",
				Label(devenv.TierP1, devenv.LabelFamily("I")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)
					sess := sshReadyWithKey(ctx, env, keyA.Signer)

					for i, k := range []sshKey{keyA, keyB} {
						res, err := conformance.Dialer.SSH(ctx, sess.Addr(), sess.User(),
							k.Signer, sess.HostKey(), "true")
						Expect(err).NotTo(HaveOccurred(),
							"key %d of the delegated Secret does not log in", i+1)
						Expect(res.ExitCode).To(Equal(0))
					}

					// The negative control, without which the two logins above prove
					// only that sshd is listening: with a delegated source the platform
					// has no key of its own in the container, so a server that admitted
					// a stranger is one that admitted everything.
					stranger, err := newSSHKey()
					Expect(err).NotTo(HaveOccurred())
					_, err = conformance.Dialer.SSH(ctx, sess.Addr(), sess.User(),
						stranger.Signer, sess.HostKey(), "true")
					Expect(err).To(HaveOccurred(),
						"the environment admitted a key that is neither in %s nor minted by the platform", secret)

					// And the platform kept its own key out: a minted client key here
					// would be one more credential that logs in.
					Expect(env.Object().Status.SSHClientKeySecret).To(BeNil(),
						"the platform minted a login key for an environment whose spec delegates")
					Expect(secretExists(ctx, env.SSHClientKeySecretName())).To(BeFalse())
				})

			It("I2 reaches a running environment with a key added to the delegated Secret, without rolling it",
				Label(devenv.TierP1, devenv.LabelFamily("I")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)
					sess := sshReadyWithKey(ctx, env, keyA.Signer)
					before, err := env.PodUID(ctx)
					Expect(err).NotTo(HaveOccurred())

					added, err := newSSHKey()
					Expect(err).NotTo(HaveOccurred())
					Expect(appendSecretKey(ctx, secret, dataKey, authorizedKeys(keyA, keyB, added))).To(Succeed())

					// The workload is not restarted for this, so the new bytes have to
					// reach a container that is already running — which is kubelet
					// syncing the mounted Secret, on its own schedule. The key is
					// therefore expected to appear within a window the sync period fits
					// in, and a platform that rolled the pod instead would be a working
					// login and a failed case.
					Eventually(func() error {
						_, err := conformance.Dialer.SSH(ctx, sess.Addr(), sess.User(),
							added.Signer, sess.HostKey(), "true")
						return err
					}).WithTimeout(3*time.Minute).WithPolling(5*time.Second).
						Should(Succeed(), "the key added to %s never reached the running environment", secret)

					after, err := env.PodUID(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(after).To(Equal(before),
						"adding a key to the delegated Secret rolled the workload, which it must not: the "+
							"mount is a directory mount precisely so a rotation needs no restart")

					// The key that was already there still works — an update that
					// replaced the file rather than extending it would log the added key
					// in and lock everyone else out.
					_, err = conformance.Dialer.SSH(ctx, sess.Addr(), sess.User(),
						keyA.Signer, sess.HostKey(), "true")
					Expect(err).NotTo(HaveOccurred(),
						"the key that was already in %s stopped working when another was added", secret)
				})

			It("I6 admits a key the user placed in their own $HOME, not just the platform's file",
				Label(devenv.TierP1, devenv.LabelFamily("I")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)
					sess := sshReadyWithKey(ctx, env, keyA.Signer)

					// What `ssh-copy-id` does, done here: append the key to the
					// account's own authorized_keys with the modes sshd expects. The
					// image's sshd names that path as well as the platform's file, which
					// is what lets a user add a key the platform never knew about — and
					// $HOME is the workspace claim, so the file survives a restart.
					//
					// StrictModes is off in the image's drop-in, which is what makes
					// this work at all: the workspace is group-writable, and its default
					// would refuse a key file under such a directory.
					own, err := newSSHKey()
					Expect(err).NotTo(HaveOccurred())
					res, err := sess.Run(ctx,
						`umask 077 && mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" && `+
							`printf '%s\n' '`+own.Line+`' >> "$HOME/.ssh/authorized_keys"`)
					Expect(err).NotTo(HaveOccurred())
					Expect(res.ExitCode).To(Equal(0),
						"writing $HOME/.ssh/authorized_keys exited %d (stderr: %s)",
						res.ExitCode, strings.TrimSpace(res.Stderr))

					_, err = conformance.Dialer.SSH(ctx, sess.Addr(), sess.User(),
						own.Signer, sess.HostKey(), "true")
					Expect(err).NotTo(HaveOccurred(),
						"a key in $HOME/.ssh/authorized_keys is not served, so ssh-copy-id cannot work "+
							"against this environment")

					// And it is a *second* path, not a replacement: the delegated keys
					// still log in.
					_, err = conformance.Dialer.SSH(ctx, sess.Addr(), sess.User(),
						keyA.Signer, sess.HostKey(), "true")
					Expect(err).NotTo(HaveOccurred(),
						"writing the user's own authorized_keys displaced the platform's keys")
				})
		},
	}.declare()
}

// --- I3: a host key sshd cannot read ------------------------------------------

// describeHostKeyRepair is I3.
//
// The Secret it overwrites is owned by the environment, so the controller's
// Secret watch enqueues the environment for the event and the repair runs
// without the case having to prod anything.
func describeHostKeyRepair() {
	draftCase{
		Name:     "ssh-host-key-repair",
		Image:    devenv.MustImage("ssh-ubuntu22.04"),
		Identity: devenv.NonRoot,
		Cases: func(open func() *devenv.Environment) {
			It("I3 replaces a host key sshd cannot read, and rolls the workload onto it",
				Label(devenv.TierP1, devenv.LabelFamily("I")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)
					sess := sshReady(ctx, env)

					name := env.SSHHostKeySecretName()
					before, err := env.SSHHostKey(ctx)
					Expect(err).NotTo(HaveOccurred())
					uidBefore, err := env.PodUID(ctx)
					Expect(err).NotTo(HaveOccurred())

					// A well-formed PKCS#8 block, which is exactly the trap: it parses,
					// it is a real ed25519 key, and sshd refuses to start on it. The
					// public half is replaced with it so the Secret stays internally
					// consistent and the *only* thing wrong is the format.
					priv, pub, err := pkcs8HostKey()
					Expect(err).NotTo(HaveOccurred())
					Expect(replaceSecret(ctx, name, map[string][]byte{
						hostKeyDataKey:    priv,
						hostPubKeyDataKey: pub,
					})).To(Succeed())

					// Repaired in place: the Secret is the platform's, and the fix is to
					// write a readable key into it rather than to mint a second Secret
					// and leave this one describing a key nothing holds.
					Eventually(func() error {
						data, err := secretData(ctx, name)
						if err != nil {
							return err
						}
						block, _ := pem.Decode(data[hostKeyDataKey])
						if block == nil || block.Type != "OPENSSH PRIVATE KEY" {
							typeName := "no PEM block"
							if block != nil {
								typeName = block.Type
							}
							return fmt.Errorf("%s still holds a %s", name, typeName)
						}
						return nil
					}).WithTimeout(2*time.Minute).WithPolling(3*time.Second).
						Should(Succeed(), "the managed host key was not repaired")

					after, err := env.SSHHostKey(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(after.Marshal()).NotTo(Equal(before.Marshal()),
						"the host key was not replaced, so sshd is still being handed a key it cannot read")

					// And the workload was rolled onto it. The private key reaches the
					// container through a subPath mount, which never sees an in-place
					// update, so a repaired host key that did not roll the workload
					// would leave the pod serving the key it started with — the
					// environment would look healthy and answer with the wrong identity.
					Eventually(func() (string, error) {
						uid, err := env.PodUID(ctx)
						return string(uid), err
					}).WithTimeout(5*time.Minute).WithPolling(3*time.Second).
						ShouldNot(Equal(string(uidBefore)),
							"the workload was not rolled onto the repaired host key")

					running(ctx, env)
					sess = sshReady(ctx, env)
					presented, err := conformance.Dialer.SSHPresentedHostKey(ctx, sess.Addr())
					Expect(err).NotTo(HaveOccurred())
					Expect(presented.Marshal()).To(Equal(sess.HostKey().Marshal()),
						"the server still presents a key other than the one %s now holds", name)
				})
		},
	}.declare()
}

// --- I4: withdrawing the exposure ---------------------------------------------

// describeSSHWithdrawal is I4.
//
// It drafts a jupyter environment, because that is the only type whose ssh
// exposure is a spec field: for `type: ssh` the exposure is the type, and there
// is nothing to switch off.
func describeSSHWithdrawal() {
	draftCase{
		Name:     "ssh-withdrawn",
		Image:    devenv.MustImage("jupyter-minimal"),
		Identity: devenv.NonRoot,
		Cases: func(open func() *devenv.Environment) {
			It("I4 withdraws the ssh endpoint and releases its port when the exposure is turned off",
				Label(devenv.TierP1, devenv.LabelFamily("I")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					ep, ok := env.SSHEndpoint()
					Expect(ok).To(BeTrue(), "status published no ssh endpoint (has %v)", env.EndpointNames())
					port := ep.ListenerPort
					Expect(port).NotTo(BeZero())

					// The pod the environment is on before the change. The withdrawal
					// rewrites the pod template — the host key and the authorized keys
					// arrive as volumes, and an environment no longer serving ssh must
					// not keep them mounted — so the workload is replaced, and the
					// wait at the end is keyed on this because an environment reads
					// Running on the pod it is replacing.
					uidBefore, err := env.PodUID(ctx)
					Expect(err).NotTo(HaveOccurred())

					// The published address works before the change, so everything
					// asserted after it is about the withdrawal and not about an
					// endpoint that never served.
					sshReady(ctx, env)
					_, present, err := conformance.DataplanePort(ctx, port)
					Expect(err).NotTo(HaveOccurred())
					Expect(present).To(BeTrue(),
						"the dataplane does not publish the ssh port %d before the change", port)

					Expect(env.Patch(ctx, func(want *aiv1alpha1.DevEnvironment) {
						want.Spec.SSH.Enabled = false
					})).To(Succeed())

					// Three separate consequences, and each is a different component's
					// answer: what the platform tells users, what it declares to the
					// Gateway, and what the dataplane is actually serving. A withdrawal
					// that stopped at the first would leave a port held by nothing.
					Eventually(func() []string {
						_ = env.Refresh(ctx)
						return env.EndpointNames()
					}).WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						ShouldNot(ContainElement(devenv.SSHEndpointName),
							"status still advertises an ssh endpoint after the exposure was turned off")

					Eventually(func() error {
						_, err := env.ListenerSet(ctx)
						if err == nil {
							return errors.New("the ListenerSet is still there")
						}
						if apierrors.IsNotFound(err) {
							return nil
						}
						return err
					}).WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(Succeed(), "the environment's L4 ListenerSet after the withdrawal")

					// The port is not merely undeclared but released: the dataplane
					// stops publishing it, which is what returning it to the pool means
					// for anything else that asks for one.
					Eventually(func() (bool, error) {
						_, present, err := conformance.DataplanePort(ctx, port)
						return present, err
					}).WithTimeout(3*time.Minute).WithPolling(3*time.Second).
						Should(BeFalse(), "the dataplane still publishes port %d after the withdrawal", port)

					held, err := conformance.L4PortsHeld(ctx)
					Expect(err).NotTo(HaveOccurred())
					Expect(held).NotTo(HaveKey(port),
						"port %d is still declared by %s, so it cannot be drawn by another environment",
						port, strings.Join(held[port], ", "))

					// And the notebook is untouched: this is a withdrawal of one
					// exposure, not a stop. The environment is re-provisioned rather
					// than stopped, and that the replacement becomes Ready is part of
					// the assertion — the template it is built from has given up the
					// host key and the authorized keys, and a template that gave up
					// something it still needs is a pod that does not start.
					runningOn(ctx, env, uidBefore)
					Expect(env.EndpointNames()).To(ContainElement(string(aiv1alpha1.DevEnvironmentTypeJupyter)))
				})
		},
	}.declare()
}

// --- I5: the Secret stops being usable under a running environment ------------

// describeLiveUndelegation is I5.
//
// The design's claim is that the reference is re-checked rather than trusted
// from creation time. What the platform does with that answer is narrower than
// the row implies, and this case asserts what it does:
//
//   - it does **not** fall back to a key of its own. That is the property worth
//     holding on to, and the one a plausible implementation would break: a
//     platform that minted a login key when its delegated source went bad would
//     be granting itself access to an environment whose owner had just taken it
//     away;
//   - it does **not** disturb the running environment. The mounted bytes are in
//     the container already; nothing about a Secret's metadata can take them
//     back, and re-provisioning the workload over it would be an outage for a
//     metadata change.
//
// What it also does not do — a finding rather than a contract — is report the
// refusal anywhere a user can see: the reconcile returns the error from the
// middle of its pipeline, so no condition is written and no phase changes. The
// environment keeps running and keeps serving, and every later edit to it is
// silently not applied. This case asserts the two properties above, which
// survive a fix; the missing diagnosis is reported separately rather than
// encoded here as the contract.
//
// The Secret's own watch is what makes this a real run of the path rather than a
// vacuously quiet one: removing the label enqueues the environment, so the
// refusal is exercised.
func describeLiveUndelegation() {
	const (
		envName = "ssh-undelegated-live"
		dataKey = "team_keys"
		secret  = "ssh-undelegated-live-keys"
	)

	var key sshKey

	draftCase{
		Name:     envName,
		Image:    devenv.MustImage("ssh-ubuntu22.04"),
		Identity: devenv.NonRoot,
		Prepare: func(ctx context.Context) error {
			var err error
			if key, err = newSSHKey(); err != nil {
				return err
			}
			return createSecret(ctx, secret,
				map[string][]byte{dataKey: authorizedKeys(key)},
				map[string]string{sshKeysDelegatedLabel: "true"})
		},
		Shape: func(want *aiv1alpha1.DevEnvironment) {
			want.Spec.SSH = &aiv1alpha1.SSHSpec{
				Enabled: true,
				AuthorizedKeysSecret: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: secret},
					Key:                  dataKey,
				},
			}
		},
		Cases: func(open func() *devenv.Environment) {
			It("I5 keeps the environment's own keys when the delegated Secret stops opting in",
				Label(devenv.TierP1, devenv.LabelFamily("I")), func(ctx SpecContext) {
					env := open()
					running(ctx, env)

					// Remove the delegation, which is the edit the design names. The
					// Secret itself is left intact — the same name, the same data key,
					// the same key — so the only thing that changed is the opt-in.
					Expect(patchSecret(ctx, secret, func(s *corev1.Secret) {
						delete(s.Labels, sshKeysDelegatedLabel)
					})).To(Succeed())

					// The consequence, over a window: the platform neither mints a
					// replacement credential nor stops what it is running. The key is
					// checked as the object rather than only through status — a key
					// nothing names would still be one that logs in.
					Consistently(func() error {
						if err := env.Refresh(ctx); err != nil {
							return err
						}
						if ref := env.Object().Status.SSHClientKeySecret; ref != nil {
							return fmt.Errorf("the platform minted %s when its delegated source stopped opting in", ref.Name)
						}
						if secretExists(ctx, env.SSHClientKeySecretName()) {
							return errors.New("the platform created a login key behind status's back")
						}
						if err := env.Ready(ctx); err != nil {
							return fmt.Errorf("the environment stopped being ready: %w", err)
						}
						return nil
					}).WithTimeout(30*time.Second).WithPolling(3*time.Second).
						Should(Succeed(), "the environment after its delegated Secret was undelegated")

					// The key the user had still works: whatever the platform decides
					// about the reference, it cannot un-mount bytes that are already in
					// the container, and pretending otherwise would be an outage. The
					// session opens with that key because it is the only one there is:
					// the platform mints no login key for an environment whose keys are
					// delegated, which is the property the block above asserts.
					sess := sshReadyWithKey(ctx, env, key.Signer)
					_, err := sess.Run(ctx, "true")
					Expect(err).NotTo(HaveOccurred(),
						"the key already mounted in the environment stopped working")
				})
		},
	}.declare()
}

// --- Secret plumbing ----------------------------------------------------------

func createSecret(
	ctx context.Context,
	name string,
	data map[string][]byte,
	labels map[string]string,
) error {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: conformance.Namespace, Labels: labels},
		Type:       corev1.SecretTypeOpaque,
		Data:       data,
	}
	err := conformance.Client.Create(ctx, secret)
	if err == nil {
		return nil
	}
	if !apierrors.IsAlreadyExists(err) {
		return fmt.Errorf("creating the Secret %s/%s: %w", secret.Namespace, secret.Name, err)
	}
	// A name that is already taken is an interrupted run and a second attempt
	// under the same run id, which reuses the run namespace. What the first
	// attempt left is the previous keys and — for the case that delegates a
	// Secret to the platform — the delegation label, and the cases here are
	// about exactly those two things. So the caller's bytes and the caller's
	// labels are what stand afterwards, rather than the leftovers.
	return patchSecret(ctx, name, func(s *corev1.Secret) {
		s.Data = data
		s.Labels = labels
	})
}

func secretData(ctx context.Context, name string) (map[string][]byte, error) {
	var s corev1.Secret
	key := client.ObjectKey{Namespace: conformance.Namespace, Name: name}
	if err := conformance.Client.Get(ctx, key, &s); err != nil {
		return nil, fmt.Errorf("reading %s/%s: %w", key.Namespace, key.Name, err)
	}
	return s.Data, nil
}

func secretExists(ctx context.Context, name string) bool {
	var s corev1.Secret
	err := conformance.Client.Get(ctx, client.ObjectKey{Namespace: conformance.Namespace, Name: name}, &s)
	return err == nil
}

// patchSecret applies one edit to a Secret, reading it first so the caller
// mutates what is there rather than a resourceVersion it never saw.
func patchSecret(ctx context.Context, name string, mutate func(*corev1.Secret)) error {
	var s corev1.Secret
	key := client.ObjectKey{Namespace: conformance.Namespace, Name: name}
	if err := conformance.Client.Get(ctx, key, &s); err != nil {
		return fmt.Errorf("reading %s/%s: %w", key.Namespace, key.Name, err)
	}
	patch := client.MergeFrom(s.DeepCopy())
	mutate(&s)
	if err := conformance.Client.Patch(ctx, &s, patch); err != nil {
		return fmt.Errorf("patching %s/%s: %w", key.Namespace, key.Name, err)
	}
	return nil
}

// appendSecretKey replaces one entry of a Secret, for the case that hands the
// user a longer authorized_keys file and expects the running container to see it.
func appendSecretKey(ctx context.Context, name, dataKey string, body []byte) error {
	return patchSecret(ctx, name, func(s *corev1.Secret) {
		if s.Data == nil {
			s.Data = map[string][]byte{}
		}
		s.Data[dataKey] = body
	})
}

// replaceSecret sets entries on a Secret, for the case that hands the platform a
// value it has to notice and repair. It is appendSecretKey's sibling for the
// entries the platform owns rather than the user's.
func replaceSecret(ctx context.Context, name string, data map[string][]byte) error {
	return patchSecret(ctx, name, func(s *corev1.Secret) {
		if s.Data == nil {
			s.Data = map[string][]byte{}
		}
		for k, v := range data {
			s.Data[k] = v
		}
	})
}
