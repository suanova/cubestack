package devenv

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/net/proxy"
)

// Dialer is how this host reaches the Gateway's address.
//
// One decision, in one place. A cluster on a private network is reached from a
// workstation through a SOCKS5 proxy, and everything the suite dials — the
// Jupyter URL, the SSH port, the liveness probe — has to go the same way or the
// answers disagree. Proxy is empty when the address is directly routable, which
// is also the case on a node.
type Dialer struct {
	// Proxy is a SOCKS5 URL, e.g. socks5h://127.0.0.1:1080. Empty means direct.
	//
	// socks5h and socks5 behave identically here: the library sends a non-IP
	// address to the proxy as a domain name for the proxy to resolve, which is
	// what the h suffix asks for. The suffix is accepted rather than corrected so
	// a caller can paste the same URL they would give curl.
	Proxy string
}

// httpTimeout bounds one request. A Jupyter server that has not answered in
// thirty seconds is not going to.
const httpTimeout = 30 * time.Second

// sshTimeout bounds a handshake, and not the session that follows it: a vendor
// image's first import of torch takes minutes, and the case asked for it.
const sshTimeout = 30 * time.Second

// dialTimeout bounds a connection nothing else bounds.
const dialTimeout = 30 * time.Second

// DialContext opens a connection to addr, through the proxy when one is set.
//
// A context that carries no deadline of its own gets dialTimeout, because what
// this suite dials is a peer that may accept the connection and then say nothing
// — a published port with no pod behind it, a proxy that has stopped forwarding
// — and an unbounded dial waits on the operating system instead of failing the
// case. A deadline the caller did set is left alone.
func (d Dialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, dialTimeout)
		defer cancel()
	}
	if d.Proxy == "" {
		var nd net.Dialer
		return nd.DialContext(ctx, network, addr)
	}
	socks, err := d.socksDialer()
	if err != nil {
		return nil, err
	}
	return socks.DialContext(ctx, network, addr)
}

func (d Dialer) socksDialer() (proxy.ContextDialer, error) {
	u, err := url.Parse(d.Proxy)
	if err != nil {
		return nil, fmt.Errorf("parsing proxy %q: %w", d.Proxy, err)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("proxy %q names no host", d.Proxy)
	}
	var auth *proxy.Auth
	if u.User != nil {
		pw, _ := u.User.Password()
		auth = &proxy.Auth{User: u.User.Username(), Password: pw}
	}
	pd, err := proxy.SOCKS5("tcp", u.Host, auth, proxy.Direct)
	if err != nil {
		return nil, fmt.Errorf("building socks5 dialer for %q: %w", d.Proxy, err)
	}
	cd, ok := pd.(proxy.ContextDialer)
	if !ok {
		// Not reachable with the x/net implementation, but a silent downgrade to a
		// context-free dial would hang a test past its deadline rather than fail
		// it, so say so instead.
		return nil, fmt.Errorf("socks5 dialer for %q does not support contexts", d.Proxy)
	}
	return cd, nil
}

// Prober dials and closes, which is all "can this host reach the Gateway" needs.
func (d Dialer) Prober() func(ctx context.Context, addr string) error {
	return func(ctx context.Context, addr string) error {
		conn, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return err
		}
		return conn.Close()
	}
}

// HTTPClient is a client whose every connection goes through the dialer, so a
// request to a status-published address takes the same path as everything else.
func (d Dialer) HTTPClient() *http.Client {
	return &http.Client{
		Timeout: httpTimeout,
		Transport: &http.Transport{
			DialContext:         d.DialContext,
			DisableKeepAlives:   true,
			MaxIdleConnsPerHost: -1,
		},
	}
}

// SSHResult is what a session produced, kept together because a test wants both
// halves when it fails: an sshd that refuses the key explains itself on stderr.
type SSHResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// SSHTarget is the login an ssh endpoint's address names.
type SSHTarget struct {
	User string
	Host string
	Port string
}

// ParseSSHAddress splits the ssh://<user>@<host>:<port> an endpoint publishes.
//
// The user is read from the address rather than taken from the spec, because the
// address is the platform's own statement about who the endpoint serves — on a
// root environment it is the only place that account is written down, since the
// spec names no user at all. Asserting the session against the spec would be
// asserting the input; asserting it against the address asserts the output.
func ParseSSHAddress(address string) (SSHTarget, error) {
	u, err := url.Parse(address)
	if err != nil {
		return SSHTarget{}, fmt.Errorf("parsing ssh address %q: %w", address, err)
	}
	if u.Scheme != "ssh" {
		return SSHTarget{}, fmt.Errorf("address %q is not an ssh address", address)
	}
	if u.User == nil || u.User.Username() == "" {
		return SSHTarget{}, fmt.Errorf("ssh address %q names no account", address)
	}
	host, port, err := net.SplitHostPort(u.Host)
	if err != nil {
		return SSHTarget{}, fmt.Errorf("ssh address %q: %w", address, err)
	}
	return SSHTarget{User: u.User.Username(), Host: host, Port: port}, nil
}

// Addr is the host:port to dial.
func (t SSHTarget) Addr() string { return net.JoinHostPort(t.Host, t.Port) }

// ParseClientKey turns a private key into the signer a session authenticates
// with.
func ParseClientKey(pem []byte) (ssh.Signer, error) {
	signer, err := ssh.ParsePrivateKey(pem)
	if err != nil {
		return nil, fmt.Errorf("parsing the client key: %w", err)
	}
	return signer, nil
}

// NewClientKey mints a throwaway ed25519 key, for the cases that assert a
// refusal: a server that admits this one has admitted a key it never minted,
// which is the failure those cases are about. The key never leaves the process
// and never touches the cluster.
func NewClientKey() (ssh.Signer, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generating a key: %w", err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, fmt.Errorf("building a signer from the generated key: %w", err)
	}
	return signer, nil
}

// errHostKeyCaptured aborts a handshake once the host key is in hand. It never
// reaches a caller: it is the mechanism, not a result.
var errHostKeyCaptured = errors.New("host key captured")

// SSHPresentedHostKey returns the host key the server presents, without pinning
// it.
//
// The key is exchanged before authentication, so the callback is the whole of
// the work: the handshake is abandoned there rather than continued into a login
// that would only be a second way to fail. What this is for is asking *who the
// server is* as a question separate from *may I log in* — every other case pins
// the platform's key, and a pin only means identity if the key it pins is the
// one the server would present anyway.
func (d Dialer) SSHPresentedHostKey(ctx context.Context, addr string) (ssh.PublicKey, error) {
	var presented ssh.PublicKey
	cfg := &ssh.ClientConfig{
		User: "host-key-probe",
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			presented = key
			return errHostKeyCaptured
		},
	}

	// The bound is on the socket and not in ClientConfig: the Timeout field
	// there is read only by ssh.Dial, and this dials for itself so that the
	// connection goes through the suite's proxy. A spec's own deadline is
	// sooner when it has one, which WithTimeout prefers.
	hsCtx, cancel := context.WithTimeout(ctx, sshTimeout)
	defer cancel()
	conn, err := d.DialContext(hsCtx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("dialing %s: %w", addr, err)
	}
	defer func() { _ = conn.Close() }()
	deadline, _ := hsCtx.Deadline()
	_ = conn.SetDeadline(deadline)

	// The handshake is expected to fail with the sentinel above, so the error is
	// only the diagnosis for the case where no key arrived at all — which is why
	// this reads the captured value rather than the error.
	_, _, _, err = ssh.NewClientConn(conn, addr, cfg)
	if presented == nil {
		return nil, fmt.Errorf("the ssh handshake with %s presented no host key: %w", addr, err)
	}
	return presented, nil
}

// SSH runs one command over a session authenticated with key and pinned to
// hostKey.
//
// The host key is pinned rather than trusted-on-first-use because the platform
// mints it and publishes the endpoint, so "this is the server the platform
// described" is checkable — and checking it is the difference between testing
// the endpoint and testing whatever answered.
//
// A non-zero exit is returned in the result rather than as an error: the command
// is the caller's, and a shell that reached the far side has done its job even
// when what it ran failed. Only a failure to establish the session is an error.
func (d Dialer) SSH(
	ctx context.Context,
	addr, user string,
	key ssh.Signer,
	hostKey ssh.PublicKey,
	command string,
) (SSHResult, error) {
	cfg := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(key)},
		HostKeyCallback: ssh.FixedHostKey(hostKey),
	}

	// The handshake is bounded and the session is not. A peer that accepts the
	// connection and then says nothing has to fail the case rather than hang the
	// run until the go test timeout, and a command the case asked for may
	// legitimately take minutes — a vendor image's first import of torch does.
	// So the socket carries a deadline until the handshake is done, and the
	// caller's own afterwards, if the caller set one.
	hsCtx, cancel := context.WithTimeout(ctx, sshTimeout)
	defer cancel()
	conn, err := d.DialContext(hsCtx, "tcp", addr)
	if err != nil {
		return SSHResult{}, fmt.Errorf("dialing %s: %w", addr, err)
	}
	handshake, _ := hsCtx.Deadline()
	_ = conn.SetDeadline(handshake)

	sshConn, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		_ = conn.Close()
		return SSHResult{}, fmt.Errorf("ssh handshake with %s: %w", addr, err)
	}
	if sessionDeadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(sessionDeadline)
	} else {
		_ = conn.SetDeadline(time.Time{})
	}
	client := ssh.NewClient(sshConn, chans, reqs)
	defer func() { _ = client.Close() }()

	session, err := client.NewSession()
	if err != nil {
		return SSHResult{}, fmt.Errorf("opening a session on %s: %w", addr, err)
	}
	defer func() { _ = session.Close() }()

	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr

	res := SSHResult{}
	if err := session.Run(command); err != nil {
		var exitErr *ssh.ExitError
		if !errors.As(err, &exitErr) {
			return SSHResult{}, fmt.Errorf("running the command on %s: %w", addr, err)
		}
		res.ExitCode = exitErr.ExitStatus()
	}
	res.Stdout = stdout.String()
	res.Stderr = stderr.String()
	return res, nil
}
