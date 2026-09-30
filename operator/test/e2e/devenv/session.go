package devenv

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"golang.org/x/crypto/ssh"
)

// A session, resolved once from the platform's own published state.
//
// Every case that runs something inside an environment needs the same four
// things — the address, the account, the platform's key and the platform's host
// key — and each of them comes from status or from a Secret status names. Doing
// that resolution here rather than in each case is what keeps the cases about
// what they assert.

// Session is an ssh login to one environment as the account the platform's own
// address names.
type Session struct {
	env     *Environment
	target  SSHTarget
	key     ssh.Signer
	hostKey ssh.PublicKey
}

// Open resolves the endpoint, the key and the host key.
//
// The key is the platform's own, which is what a case about the environment the
// platform built wants. An environment whose spec delegates its authorized_keys
// source has no key of the platform's to find, and a case about *that* has to
// name its own: OpenWithKey.
func (e *Environment) Open(ctx context.Context) (*Session, error) {
	pem, err := e.SSHClientKey(ctx)
	if err != nil {
		return nil, err
	}
	key, err := ParseClientKey(pem)
	if err != nil {
		return nil, err
	}
	return e.OpenWithKey(ctx, key)
}

// OpenWithKey resolves the address and the host key, and logs in with the key
// the caller names.
//
// The address and the account still come from the platform — they are what is
// under test — and so does the host key, which the platform minted and the
// server therefore has to be holding. The login key is the caller's, because an
// environment that delegates its authorized_keys source serves keys the platform
// never saw.
func (e *Environment) OpenWithKey(ctx context.Context, key ssh.Signer) (*Session, error) {
	ep, ok := e.SSHEndpoint()
	if !ok {
		return nil, fmt.Errorf("status published no ssh endpoint (has %v)", e.EndpointNames())
	}
	target, err := ParseSSHAddress(ep.Address)
	if err != nil {
		return nil, err
	}
	hostKey, err := e.SSHHostKey(ctx)
	if err != nil {
		return nil, err
	}
	return &Session{env: e, target: target, key: key, hostKey: hostKey}, nil
}

// User is the account the platform's address names.
//
// It is read from the address and not from the spec, because the address is the
// platform's own statement about who the endpoint serves: on a root environment
// it is the only place that account is written down.
func (s *Session) User() string { return s.target.User }

// Addr is the host:port the session connects to, for the cases that need a
// connection of their own — one with a key the platform did not mint.
func (s *Session) Addr() string { return s.target.Addr() }

// HostKey is the platform's host key, as the cases that ask the server to prove
// its identity compare against it.
func (s *Session) HostKey() ssh.PublicKey { return s.hostKey }

// Run executes one command in the session.
func (s *Session) Run(ctx context.Context, command string) (SSHResult, error) {
	return s.env.Suite.Dialer.SSH(ctx, s.target.Addr(), s.target.User, s.key, s.hostKey, command)
}

// RunAs asks for a different account with the environment's own key.
//
// For the negative cases: a server that admits this has matched the platform's
// key against an account the platform never placed it in, or served an account
// it was told not to.
func (s *Session) RunAs(ctx context.Context, user, command string) (SSHResult, error) {
	return s.env.Suite.Dialer.SSH(ctx, s.target.Addr(), user, s.key, s.hostKey, command)
}

// Ping runs a command that cannot fail on the far side, so a nil error means
// the session was established rather than that the command succeeded.
//
// The positive control in front of every refusal: without it, "the server
// refused" and "the network dropped" are the same result.
func (s *Session) Ping(ctx context.Context) error {
	_, err := s.Run(ctx, "true")
	return err
}

// stdout returns the command's output, or the failure that stood in for it.
//
// It exists to be the body of an Eventually: while an environment is still
// starting, the honest answer to "what does this command print" is the error
// that stopped it, and a predicate that returned an empty string instead would
// fail every assertion until the retry deadline without ever saying why.
func (s *Session) stdout(ctx context.Context, command string) (string, error) {
	res, err := s.Run(ctx, command)
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return res.Stdout, fmt.Errorf("%s exited %d: %s", command, res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return res.Stdout, nil
}

// -- environment inspection ----------------------------------------------------

// The two sides of the environment comparison in family D. `/proc/1/environ` is
// the container's own environment — what the kubelet gave the entrypoint, then
// whatever it exported before exec'ing — as opposed to the pod spec's env list,
// which is only what was asked for. It is NUL-separated, and reading it needs no
// privileges beyond being the process's own uid, which the session is.
//
// The gid is why this is a script rather than one redirection. The kernel allows
// the read when the reader's uid *and* gid match the target's, or when the reader
// holds CAP_SYS_PTRACE, which a container does not have in the default capability
// set (`CapEff` a80425fb, bit 19 clear — measured on cs3, not reasoned). A root
// session runs as 0:0, the root account's own gid from /etc/passwd, while the
// container runs as 0:<the pod's runAsGroup>: the platform sets runAsGroup to the
// workspace's gid so the environment can write its claim, and the two disagree
// for exactly the identity that asks for root. So a root session is refused its
// own container's environment — `cat /proc/1/environ` answers "Permission
// denied" and the same read under `setpriv --regid <pid 1's gid>` succeeds. A
// non-root session's gids agree and the first branch is the whole story.
//
// pipefail and the `--keep-groups` are both scars. `setpriv` refuses --regid
// without one of its group flags, and its complaint goes to stderr while `tr`
// still exits 0 — so without pipefail the read reports success and *nothing*, and
// "the container does not set PATH" is what an empty answer looks like from
// outside. The groups themselves are not part of the kernel's check, and
// --keep-groups is the flag that changes nothing (--clear-groups wants a
// capability a non-root caller may not have).
const (
	containerEnvProbe = `
set -o pipefail
gid=$(awk '/^Gid:/{print $2}' /proc/1/status)
if [ "$(id -g)" = "$gid" ]; then cat /proc/1/environ
else setpriv --regid "$gid" --keep-groups cat /proc/1/environ; fi | tr '\0' '\n'
`
	sessionEnvProbe = "env"
)

// dropInPath is the sshd drop-in every image installs. Its single SetEnv line is
// the image's own statement about which of its variables must survive into a
// session, which is the thing D3 is about: sshd replaces the session
// environment rather than extending it, so a drop-in that names one variable
// too few strips it silently.
const dropInPath = "/etc/ssh/sshd_config.d/10-devenv.conf"

// EnvMap parses one variable per line into a map. Blank lines and lines with no
// "=" are dropped: a value may legitimately contain anything but a newline, and
// nothing here is worth failing over.
func EnvMap(text string) map[string]string {
	m := map[string]string{}
	for line := range strings.SplitSeq(text, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		name, value, ok := strings.Cut(line, "=")
		if !ok || name == "" {
			continue
		}
		m[name] = value
	}
	return m
}

// SortedEnvNames is EnvMap's keys, sorted, for a failure message.
func SortedEnvNames(m map[string]string) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

// SetEnvNames reads the variable names out of the image's sshd drop-in.
//
// Read from inside the image rather than listed here, because the list is the
// image's: the MACA base needs its compilers, MPI and UCX named and the CPU
// image needs none of them, and a copy of that list in this repository would go
// stale the first time an image changed. What is asserted is the *contract* —
// every name the drop-in carries arrives with the container's value — not a
// particular roster of names.
func (s *Session) SetEnvNames(ctx context.Context) ([]string, error) {
	out, err := s.stdout(ctx, "grep '^SetEnv' "+dropInPath)
	if err != nil {
		return nil, err
	}
	// SetEnv takes whitespace-separated NAME=VALUE pairs and there is exactly one
	// such line (the image build refuses a second, since sshd ignores repeats).
	_, rest, ok := strings.Cut(strings.TrimSpace(out), "SetEnv")
	if !ok {
		return nil, fmt.Errorf("%s declares no SetEnv: %q", dropInPath, strings.TrimSpace(out))
	}
	var names []string
	for pair := range strings.FieldsSeq(rest) {
		name, _, ok := strings.Cut(pair, "=")
		if ok && name != "" {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("%s declares an empty SetEnv", dropInPath)
	}
	return names, nil
}

// ContainerEnv is the environment the container is running with.
func (s *Session) ContainerEnv(ctx context.Context) (map[string]string, error) {
	out, err := s.stdout(ctx, containerEnvProbe)
	if err != nil {
		return nil, err
	}
	env := EnvMap(out)
	if len(env) == 0 {
		// Every container has an environment, so an empty one is a broken read
		// rather than a fact about the container. Without this the caller's next
		// assertion is "the drop-in names PATH, which the container does not set",
		// which names the wrong component entirely.
		return nil, fmt.Errorf("reading the container's environment gave nothing: %q", strings.TrimSpace(out))
	}
	return env, nil
}

// SessionEnv is the environment a login session is given.
func (s *Session) SessionEnv(ctx context.Context) (map[string]string, error) {
	out, err := s.stdout(ctx, sessionEnvProbe)
	if err != nil {
		return nil, err
	}
	return EnvMap(out), nil
}
