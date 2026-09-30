package devenv

import (
	"fmt"
	"os"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// The published image catalogue, as data.
//
// This is the table in images/README.md restated so the suite can iterate it.
// Keeping it here rather than inline in the specs means an image change is one
// review in one place, and it is what makes "every published image" a phrase the
// suite can honour rather than a list somebody remembered to extend.
//
// The account, uid:gid and home are the *image's* own, which is what a non-root
// environment is asserted against. A root environment is served as root whatever
// the image bakes, so those three fields do not apply to it — see Identity.

// The default registry and tag. Both are overridable so the suite can be pointed
// at a staging registry or a pinned build without editing this file.
//
// The registry is the host and nothing else: the harbor project is part of Repo,
// so the reference is <host>/suanova/<image>. Writing the project into both
// produces <host>/suanova/suanova/<image>, which harbor answers with a plain
// "not found" — an image that resolves to nothing rather than a pull that fails
// for a reason.
const (
	defaultRegistry = "harbor.isuanova.com"
	defaultTag      = "latest"
)

const (
	envRegistry = "DEVENV_E2E_REGISTRY"
	envTag      = "DEVENV_E2E_TAG"
)

// The image's own account, shared by the four self-authored images. Having one
// name for it is also the assertion: these images are built on the same base and
// serve the same login, and a divergence would be a deliberate change.
const (
	ubuntuAccount = "ubuntu"
	ubuntuHome    = "/home/ubuntu"
)

// Image is one published DevEnvironment image and what an environment running it
// looks like.
type Image struct {
	// Key is the catalogue name, and doubles as a Ginkgo label value
	// (LabelImage) and as part of the environment's name. Label values may not
	// contain "/ , & | ! ( )", which rules out the repo name — and the repo name
	// is the registry's to decide anyway.
	Key string

	// Repo is the image path under the registry: "suanova/jupyter-minimal" style,
	// without the registry host or the tag.
	Repo string

	// Type is the spec.type the environment needs. It also decides the name of
	// the web endpoint the controller publishes — a type of "ssh" gets none.
	Type aiv1alpha1.DevEnvironmentType

	// Account is the login the image's own sshd serves, and what a non-root
	// environment must be asserted against.
	Account string

	// UID and GID are the account's, and must agree with what the image bakes:
	// the controller pins runAsUser/runAsGroup from those numbers, so a mismatch
	// here is a process that cannot write its own home.
	UID int64
	GID int64

	// Home is the account's home as the image bakes it, and the default workspace
	// mount path the controller derives from spec.runtime.user.
	Home string

	// GroupOnlyWorkaround is true for the stock docker-stacks images, whose
	// account is 1000:100 but whose platform default group is 1000. The manifest
	// must state runAsGroup explicitly for those, and omitting it is the failure
	// this field exists to prevent. The self-authored images are 1000:1000 and
	// need no securityContext at all.
	GroupOnlyWorkaround bool

	// Stack is the image's own toolchain, as a probe a session runs to prove the
	// session's PATH resolves it. Empty for an image that is a base system and
	// nothing else.
	Stack Stack
}

// Stack is the image's own toolchain, as one command.
//
// It is here rather than in the case because it is a fact about the image: the
// vendor images put their interpreter somewhere a base image's PATH does not
// name, and the whole point of the shared sshd drop-in is that a session's PATH
// carries the image's. What proves that is asking the session to use the stack,
// so the command is the image's and the expectation is only that it exits 0.
type Stack struct {
	// Name is what the probe exercises, for a failure message. Empty means the
	// image has no stack beyond a base system.
	Name string
	// Command runs in the session's login shell and must exit 0.
	Command string
}

// Ref is the image reference to pull: <registry>/<repo>:<tag>, with the registry
// and tag overridable through the environment.
func (i Image) Ref() string {
	registry := defaultRegistry
	if v := os.Getenv(envRegistry); v != "" {
		registry = v
	}
	tag := defaultTag
	if v := os.Getenv(envTag); v != "" {
		tag = v
	}
	return fmt.Sprintf("%s/%s:%s", registry, i.Repo, tag)
}

// Images is every published DevEnvironment image.
//
// Order matters only for the report: environments come up one at a time and the
// cheap ones first means a broken cluster is diagnosed before the first
// multi-gigabyte pull rather than after it.
var Images = []Image{
	{
		Key:     "ssh-ubuntu22.04",
		Repo:    "suanova/ssh-ubuntu22.04",
		Type:    aiv1alpha1.DevEnvironmentTypeSSH,
		Account: ubuntuAccount,
		UID:     1000,
		GID:     1000,
		Home:    ubuntuHome,
		// No stack: ubuntu:22.04 with sshd and nothing else, which is what the
		// image is for — a session that reaches the workspace, not a toolchain.
	},
	{
		Key:                 "jupyter-minimal",
		Repo:                "suanova/jupyter-minimal",
		Type:                aiv1alpha1.DevEnvironmentTypeJupyter,
		Account:             "jovyan",
		UID:                 1000,
		GID:                 100,
		Home:                "/home/jovyan",
		GroupOnlyWorkaround: true,
		// JupyterLab is the stack here, and the interpreter that serves it is the
		// conda one the base publishes — the same interpreter the notebook kernel
		// and the ssh session have to agree on.
		Stack: Stack{
			Name:    "jupyterlab",
			Command: `python3 -c 'import jupyterlab; print(jupyterlab.__version__)'`,
		},
	},
	{
		Key:     "jupyter-maca-pytorch",
		Repo:    "suanova/jupyter-maca-pytorch",
		Type:    aiv1alpha1.DevEnvironmentTypeJupyter,
		Account: ubuntuAccount,
		UID:     1000,
		GID:     1000,
		Home:    ubuntuHome,
		// torch is the vendor's, and only the conda interpreter has it: the base
		// ships a second, torch-less python at /usr/bin, so an import that
		// succeeds is the whole of the claim.
		Stack: Stack{
			Name:    "MACA torch",
			Command: `python3 -c 'import torch; print(torch.__version__)'`,
		},
	},
	{
		Key:     "ssh-maca-pytorch",
		Repo:    "suanova/ssh-maca-pytorch",
		Type:    aiv1alpha1.DevEnvironmentTypeSSH,
		Account: ubuntuAccount,
		UID:     1000,
		GID:     1000,
		Home:    ubuntuHome,
		Stack: Stack{
			Name:    "MACA torch",
			Command: `python3 -c 'import torch; print(torch.__version__)'`,
		},
	},
	{
		Key:     "jupyter-cuda-pytorch",
		Repo:    "suanova/jupyter-cuda-pytorch",
		Type:    aiv1alpha1.DevEnvironmentTypeJupyter,
		Account: ubuntuAccount,
		UID:     1000,
		GID:     1000,
		Home:    ubuntuHome,
		// The CUDA build is a distribution rather than a base, so its torch is on
		// the one interpreter it ships; what is worth reading back is which CUDA
		// that torch was built for.
		Stack: Stack{
			Name:    "CUDA torch",
			Command: `python3 -c 'import torch; print(torch.version.cuda)'`,
		},
	},
	{
		Key:     "ssh-cuda-pytorch",
		Repo:    "suanova/ssh-cuda-pytorch",
		Type:    aiv1alpha1.DevEnvironmentTypeSSH,
		Account: ubuntuAccount,
		UID:     1000,
		GID:     1000,
		Home:    ubuntuHome,
		Stack: Stack{
			Name:    "CUDA torch",
			Command: `python3 -c 'import torch; print(torch.version.cuda)'`,
		},
	},
}

// ImageByKey finds a catalogue entry, for a label filter naming one image.
func ImageByKey(key string) (Image, bool) {
	for _, i := range Images {
		if i.Key == key {
			return i, true
		}
	}
	return Image{}, false
}

// MustImage is ImageByKey for the spec tree, where a key that names nothing is a
// mistake in this repository rather than a condition of the cluster.
func MustImage(key string) Image {
	img, ok := ImageByKey(key)
	if !ok {
		panic(fmt.Sprintf("no image %q in the catalogue", key))
	}
	return img
}

// ServesJupyter reports whether the environment publishes a web endpoint at all.
//
// It is the image's type rather than a second catalogue field, because that is
// what the controller reads: a "ssh" environment gets no web endpoint whether or
// not its image could serve one. Asking the catalogue a question the controller
// answers from the spec is how the two drift.
func (i Image) ServesJupyter() bool {
	return i.Type != aiv1alpha1.DevEnvironmentTypeSSH
}

// Identity is the account axis: an environment as its image's own account, or as
// root.
//
// It is the axis that matters. Root is not a variant of the same code path — the
// controller mounts the host key 0600 rather than 0644, sources AllowUsers
// differently, injects the launcher's own NB_* settings and expects /run/sshd to
// exist. An assertion that holds for one says nothing about the other.
type Identity string

const (
	// NonRoot is the image's own account, named by spec.runtime.user.
	NonRoot Identity = "nonroot"
	// Root is runAsUser 0. The spec says nothing else about it: the account, its
	// uid and gid and the launcher's settings are all the controller's to derive.
	Root Identity = "root"
)

// Identities is both axes, in the order a run brings them up.
var Identities = []Identity{NonRoot, Root}

// RunAsUser is the spec.runtime.securityContext.runAsUser this identity needs,
// nil for the image's own account.
//
// A non-root environment states the image's account through spec.runtime.user
// and needs no number; a root one states only the number, and the controller
// derives the rest. That asymmetry is the whole design — see the CRD's note on
// the Accepted condition.
func (id Identity) RunAsUser() *int64 {
	if id == Root {
		zero := int64(0)
		return &zero
	}
	return nil
}

// Account is the login the endpoint should serve for this identity.
//
// Root is named by the platform rather than by the image, which is why it is not
// read from the catalogue: a root environment is served as root whatever the
// image bakes.
func (id Identity) Account(img Image) string {
	if id == Root {
		return "root"
	}
	return img.Account
}
