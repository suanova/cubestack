//go:build e2e
// +build e2e

package e2e

import (
	"fmt"
	"strconv"
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/suanova/cubestack/test/e2e/devenv"
)

// Family F: the per-image stack (§4.F).
//
// Everything else in this suite asserts what the *platform* did with an image.
// These assert the images themselves: that the account an environment runs as
// can read the vendor stack, that the interpreter a session reaches is the one
// with the toolchain in it, and that the notebook a user opens lands on that
// same interpreter rather than on the one beside it.
//
// It is the family with the least platform in it, and it is here because both
// ways of getting it wrong are silent. A MACA base ships two 3.10 interpreters
// and only one has torch, so `import torch` succeeding interactively and failing
// in a notebook is a difference no endpoint case can see; and a vendor directory
// the running uid cannot read produces a stack that resolves on PATH and fails
// when used.
//
// Every case rides the matrix, because the environment each one is about is one
// the matrix already brings up. What varies is which images each case applies
// to, so each one skips the environments that are not its subject.

// describeStack declares family F for one environment.
func describeStack(open func() *devenv.Environment, img devenv.Image, identity devenv.Identity) {
	It("F1 runs the notebook as the image's own group",
		Label(devenv.TierP1, devenv.LabelFamily("F")), func(ctx SpecContext) {
			env := open()
			if img.Key != "jupyter-minimal" {
				Skip("the stock docker-stacks image is the one whose account is 1000:100")
			}
			if identity != devenv.NonRoot {
				Skip("a root environment's group is the platform's, which C1 asserts")
			}
			// The notebook process and not the session. The two are started
			// differently — the launcher drops to the account for the server, while
			// sshd starts the session for it — so a session at gid 100 says nothing
			// about the process a user's kernel actually runs under.
			notebook, err := notebookProcess(ctx, env)
			Expect(err).NotTo(HaveOccurred(), "finding the notebook server")
			Expect(notebook.GID).To(Equal(strconv.FormatInt(img.GID, 10)),
				"the notebook server runs at gid %s, and %s's account is %d:%d",
				notebook.GID, img.Key, img.UID, img.GID)
		})

	It("F2 gives a MACA environment a readable vendor tree on the torch interpreter",
		Label(devenv.TierP1, devenv.LabelFamily("F")), func(ctx SpecContext) {
			env := open()
			if !strings.Contains(img.Key, "maca") {
				Skip("this image carries no MACA stack")
			}
			// Readable as the session's own uid, which on a non-root environment is
			// the account the image builds for — the uid the vendor tree has to be
			// usable by. A root session asking is a stronger reader, not a
			// different question.
			out := strings.TrimSpace(sshOutput(ctx, env, `test -r /opt/maca && readlink -f /opt/maca`))
			Expect(out).NotTo(BeEmpty(), "the MACA tree the image's whole stack is under")

			// The interpreter, not the import: a base with two 3.10 interpreters
			// answers "does python3 have torch" differently depending on which one
			// `python3` resolves to, and the failure the image was fixed for was
			// exactly that resolution going to the torch-less one.
			interp := torchInterpreter(ctx, env)
			Expect(interp).NotTo(Equal("/usr/bin/python3"),
				"the session's python3 is the system interpreter the MACA base ships beside the vendor one, "+
					"which has no torch in it")
			Expect(strings.TrimSpace(sshOutput(ctx, env, `readlink -f "$(command -v python3)"`))).
				To(Equal(interp), "the interpreter `python3` resolves to and the one torch is installed in")

			if !img.ServesJupyter() {
				return
			}
			// And the notebook server, which is a third process with its own PATH:
			// the image was fixed by putting the vendor bin first at build time, so
			// the server inherits it — but a server started from a bare PATH would
			// still export a torch-less interpreter to every kernel it spawns.
			notebook, err := notebookProcess(ctx, env)
			Expect(err).NotTo(HaveOccurred(), "finding the notebook server")
			Expect(notebook.Exe).To(Equal(interp),
				"the notebook server runs on an interpreter without the vendor torch, so a kernel it spawns "+
					"would too; the session's own python3 is a different process and says nothing about it")
		})

	It("F3 lands a CUDA notebook on the interpreter a session gets",
		Label(devenv.TierP1, devenv.LabelFamily("F")), func(ctx SpecContext) {
			env := open()
			if !strings.Contains(img.Key, "cuda") {
				Skip("this image carries no CUDA stack")
			}
			interp := torchInterpreter(ctx, env)
			if !img.ServesJupyter() {
				return
			}
			// The kernel's own interpreter, which is not the server's by
			// construction: the base's kernelspec names a bare `python`, and
			// jupyter_client rewrites that to the server's `sys.executable` — so the
			// chain from "a user opens a notebook" to "a cell imports torch" runs
			// through the server, and breaks there rather than anywhere a session can
			// see.
			notebook, err := notebookProcess(ctx, env)
			Expect(err).NotTo(HaveOccurred(), "finding the notebook server")
			Expect(notebook.Exe).To(Equal(interp),
				"the notebook server and the session's python3 are different interpreters, so a cell would "+
					"import torch from the one the session cannot see")
		})

	It("F4 puts the CUDA toolkit and torch's libraries on the session",
		Label(devenv.TierP1, devenv.LabelFamily("F")), func(ctx SpecContext) {
			env := open()
			if !strings.Contains(img.Key, "cuda") {
				Skip("this image carries no CUDA stack")
			}
			sess := sshReady(ctx, env)
			sessionEnv, err := sess.SessionEnv(ctx)
			Expect(err).NotTo(HaveOccurred())

			// The toolkit by path and torch's libraries by derivation. The CUDA base
			// builds both of these and neither is set by any Dockerfile in this
			// repository — they reach a session only because the sshd drop-in names
			// them, which is the contract D3 asserts the shape of and this asserts
			// the content of.
			Expect(strings.Split(sessionEnv["PATH"], ":")).To(ContainElement("/usr/local/cuda/bin"),
				"the session's PATH: %s", sessionEnv["PATH"])

			// Read from torch rather than written down, because where torch's shared
			// objects live is the image's business: a base that moved them is a
			// change to test, not a test that goes stale.
			lib := strings.TrimSpace(sshOutput(ctx, env,
				`python3 -c 'import os, torch; print(os.path.join(os.path.dirname(torch.__file__), "lib"))'`))
			Expect(lib).NotTo(BeEmpty(), "torch does not say where its own libraries are")
			Expect(strings.Split(sessionEnv["LD_LIBRARY_PATH"], ":")).To(ContainElement(lib),
				"torch's libraries are at %s and the session's LD_LIBRARY_PATH is %s",
				lib, sessionEnv["LD_LIBRARY_PATH"])
		})
}

// notebookProcess is the running notebook server, as the kernel sees it.
//
// Found by scanning /proc rather than by a name or a pid file: what is under
// test is the interpreter the *serving* process runs on, and the only place that
// is written down is the process itself. The match is a python executable whose
// command line names jupyter, which is what both launchers leave behind and what
// no other process in these images is.
type notebookProcessInfo struct {
	Exe string
	GID string
}

func notebookProcess(ctx SpecContext, env *devenv.Environment) (notebookProcessInfo, error) {
	GinkgoHelper()
	res, err := sshReady(ctx, env).Run(ctx, notebookProcessProbe)
	if err != nil {
		return notebookProcessInfo{}, err
	}
	if res.ExitCode != 0 {
		return notebookProcessInfo{}, fmt.Errorf("no notebook server process: %s", strings.TrimSpace(res.Stderr))
	}
	var info notebookProcessInfo
	for line := range strings.SplitSeq(strings.TrimSpace(res.Stdout), "\n") {
		if v, ok := strings.CutPrefix(line, "exe="); ok {
			info.Exe = v
		}
		if v, ok := strings.CutPrefix(line, "gid="); ok {
			info.GID = v
		}
	}
	if info.Exe == "" || info.GID == "" {
		return notebookProcessInfo{}, fmt.Errorf("the notebook process answered %q", strings.TrimSpace(res.Stdout))
	}
	return info, nil
}

// notebookProcessProbe prints the notebook server's executable and its gid.
//
// The exe is the resolved path and not the argv[0], because argv[0] is whatever
// the launcher was given and the question is which binary is running. The gid is
// the process's own, not the session's.
//
// The exe is read as the container's own gid, because reading the /proc symlink
// at any other one fails: the kernel allows it when the reader's uid *and* gid
// match the target's, or the reader holds CAP_SYS_PTRACE, which a container does
// not have in the default capability set. So for a session whose gid is not the
// container's, `readlink` finds nothing, `|| continue` drops every process, and
// the answer is "no process runs jupyter" about a container that is running one.
// That is not hypothetical — it is what a root environment produced: the root
// account's gid is 0 from the image's /etc/passwd while the platform runs the
// container as 0:<workspace gid>, and the case failed on exactly this message
// (measured on cs3, with the same probe reading the same container correctly at
// the container's own gid and answering nothing at gid 0). A non-root session's
// gids agree with the container's and the first branch is the whole story.
//
// cmdline is not gated the same way — measured: it reads at either gid, which is
// why the read below it is not guarded too.
const notebookProcessProbe = `
set -o pipefail
gid=$(awk '/^Gid:/{print $2}' /proc/1/status)
own=$(id -g)
for p in /proc/[0-9]*; do
  if [ "$own" = "$gid" ]; then exe=$(readlink -f "$p/exe" 2>/dev/null) || continue
  else exe=$(setpriv --regid "$gid" --keep-groups readlink -f "$p/exe" 2>/dev/null) || continue; fi
  case "${exe##*/}" in python*) ;; *) continue ;; esac
  cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
  case "$cmd" in *jupyter*) ;; *) continue ;; esac
  awk '/^Gid:/{print "gid=" $2}' "$p/status"
  printf 'exe=%s\n' "$exe"
  exit 0
done
echo "no process runs jupyter" >&2
exit 1
`

// torchInterpreter is the interpreter the session's `python3` resolves to, and
// the one torch is installed in.
//
// One command, because the two have to be the same reading to mean anything: an
// interpreter named on one line and an import that succeeded on another are two
// facts about possibly two pythons.
func torchInterpreter(ctx SpecContext, env *devenv.Environment) string {
	GinkgoHelper()
	const probe = `python3 -c 'import os, sys, torch; print(os.path.realpath(sys.executable))'`
	res := sshRun(ctx, env, probe)
	Expect(res.ExitCode).To(Equal(0),
		"python3 does not import torch: %s", strings.TrimSpace(res.Stderr))
	out := strings.TrimSpace(res.Stdout)
	Expect(out).NotTo(BeEmpty(), "the interpreter answered with nothing")
	return out
}
