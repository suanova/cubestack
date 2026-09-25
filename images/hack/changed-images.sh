#!/usr/bin/env bash
# Which DevEnvironment images a change reaches — the one rule CI selects on.
#
# The build context for every Dockerfile here is this directory, so the *context* is
# shared and the *inputs* are not: a Dockerfile COPYs from common/ and from its own
# directory, and from nowhere else. That convention is what makes "which images does
# this diff reach" answerable from a path alone, and `check-deps` is what keeps it true.
#
# Two workflows need the answer and have to agree on it:
#
#   .github/workflows/ci-operator.yml   smokes a pull request
#   .github/workflows/ci-images.yml     publishes a merge
#
# so the rule lives here once rather than as a paths-filter block in each. `paths` is
# what makes the agreement structural rather than reviewed: ci-images.yml's `:latest`
# gate diffs against exactly the paths this script says reach the image, so the gate's
# pathspec cannot drift from the filter that started the run. A gate wider than the
# filter withholds a tag that no later run would move — the stranding defect the gate
# exists to prevent — and both now come out of the same tables below.
#
# Changed paths arrive on stdin, one per line (`git diff --name-only`). Not a <base>
# <head> pair: the two callers diff different things — a pull request against its merge
# base, a merge against the commit it published from — and neither choice belongs here.
# The question this answers is "given this diff, which images", which is also what makes
# the fixtures plain lists of paths with no repository to arrange.
#
# Usage:
#   changed-images.sh select       # images to build and publish, one per line
#   changed-images.sh smoke        # images to smoke, one per line
#   changed-images.sh paths <img>  # that image's pathspec, for the `:latest` gate
#   changed-images.sh list         # every image this workspace builds
#
# `select` and `smoke` are not the same set — see the smoke-harness branch below.
set -euo pipefail

# One name per image, in the order output is emitted. These are the Makefile's RETAG
# vocabulary (`make -C images push-ssh`, `retag-latest-jupyter`), because the callers
# feed them straight back to make; neither the directory nor the published repository
# name is what a caller wants.
ALL_IMAGES=(ssh jupyter maca ssh-maca)

# The CI that decides how these images are built, smoked and published: the two workflows,
# and the action both of them delegate the selection to. A change to any of them
# republishes every image, so every image's gate watches all three. The action belongs
# here as much as the workflows do, and for the same reason: it is what picks the diff
# base the rule is asked about, and the flags that size each publishing leg — a change to
# it alone changes what every selection below means.
CI_PATHS=(
  .github/actions/changed-images/action.yml
  .github/workflows/ci-images.yml
  .github/workflows/ci-operator.yml
)

# Paths that reach every image. `images/common/` is COPYd by all four Dockerfiles;
# images/Makefile holds the base digests and build args no Dockerfile names;
# images/.dockerignore defines the context; the last three are this rule, its test, and the
# checker of the COPY convention the rule is derived from — machinery that decides what
# every one of those selections and gates *means*, rather than what the images contain. A
# change to any of them is a change to all four, and leaving the checker out would also
# leave it unrun: ci-operator.yml's `images-check` job is gated on a non-empty selection.
#
# This list is read by `select`, and the CI half of it by `paths`.
SHARED_PATHS=(
  "${CI_PATHS[@]}"
  images/common
  images/Makefile
  images/.dockerignore
  images/hack/changed-images.sh
  images/hack/changed-images.test.sh
  images/hack/check-dockerfile-copies.sh
)

# The smoke harness. Its own branch because it is verification rather than artifact
# content: a change to it rebuilds nothing, since no image contains it, but every
# image's verification is now different, so every image is re-smoked. Selecting nothing
# would put off the new assertions until some later, unrelated merge.
SMOKE_HARNESS=images/hack/smoke.sh

usage() {
  cat >&2 <<'EOF'
usage: changed-images.sh select       # images to build and publish, one per line
       changed-images.sh smoke        # images to smoke, one per line
       changed-images.sh paths <img>  # that image's pathspec, for the `:latest` gate
       changed-images.sh list         # every image this workspace builds

`select` and `smoke` read changed paths on stdin, one per line.
EOF
}

# The directory a Dockerfile of this image lives in, and what it COPYs from.
own_dir() {
  case "$1" in
    ssh) printf 'ssh-ubuntu-server' ;;
    jupyter) printf 'jupyter' ;;
    maca) printf 'jupyter-maca-pytorch' ;;
    ssh-maca) printf 'ssh-maca-pytorch' ;;
    *)
      printf 'changed-images.sh: %s is not a known image (see `list`)\n' "$1" >&2
      return 1
      ;;
  esac
}

known_image() {
  local want="$1" img
  for img in "${ALL_IMAGES[@]}"; do
    [ "$img" = "$want" ] && return 0
  done
  return 1
}

# Prints the subset of ALL_IMAGES named by the arguments, in canonical order and
# without repeats. The caller's list arrives as words, so membership is what matters
# and order in the input is not preserved.
print_selection() {
  local img candidate selected
  for img in "${ALL_IMAGES[@]}"; do
    selected=0
    for candidate in "$@"; do
      [ "$candidate" = "$img" ] && selected=1
    done
    if [ "$selected" = 1 ]; then printf '%s\n' "$img"; fi
  done
}

# Reads changed paths on stdin and fills SELECT_BUILD / SELECT_SMOKE.
#
# The failure this has to avoid is the quiet one. A path this rule does not recognise
# and silently ignores selects nothing, so a change to it publishes nothing and leaves
# `:latest` on the older build with no run to correct it — the same shape of defect the
# gate exists to prevent. An unrecognised path under images/ therefore selects every
# image and says so: over-selecting costs a rebuild, under-selecting ships a stale
# image.
collect() {
  SELECT_BUILD=()
  SELECT_SMOKE=()
  local unrecognised=0 path img dir p

  while IFS= read -r path || [ -n "$path" ]; do
    [ -n "$path" ] || continue

    # Documentation reaches no image: nothing under images/ COPYs or otherwise reads a
    # .md, the Dockerfiles taking *.sh and *.conf. `*` matches across `/` in this
    # pattern, so the one case covers every depth — and it is first, because a markdown
    # file inside an image directory would otherwise match that image.
    if [[ "$path" == images/*.md ]]; then
      continue
    fi

    if [[ "$path" == "$SMOKE_HARNESS" ]]; then
      SELECT_SMOKE=("${ALL_IMAGES[@]}")
      continue
    fi

    local matched=0
    for p in "${SHARED_PATHS[@]}"; do
      if [[ "$path" == "$p" || "$path" == "$p"/* ]]; then
        SELECT_BUILD=("${ALL_IMAGES[@]}")
        SELECT_SMOKE=("${ALL_IMAGES[@]}")
        matched=1
        break
      fi
    done
    if [ "$matched" = 1 ]; then continue; fi

    # An image's own directory: its Dockerfile and everything that Dockerfile COPYs.
    for img in "${ALL_IMAGES[@]}"; do
      dir="$(own_dir "$img")"
      if [[ "$path" == "images/$dir"/* ]]; then
        SELECT_BUILD+=("$img")
        SELECT_SMOKE+=("$img")
        matched=1
        break
      fi
    done
    if [ "$matched" = 1 ]; then continue; fi

    # Under images/ and claimed by nothing above: a new image directory, a file at
    # images/ root, a new script in hack/. The rule has not been taught this path, and
    # it may well be an input — so it selects everything, loudly.
    if [[ "$path" == images/* ]]; then
      printf 'changed-images.sh: %s is not a known build input; selecting every image.\n' "$path" >&2
      printf 'changed-images.sh: teach it in %s (SHARED_PATHS, or an image directory).\n' "$0" >&2
      unrecognised=1
      continue
    fi

    # Outside images/ and not a workflow file: reaches no image. operator/, web/ and
    # docs/ belong to other projects, and every image here is built from this directory
    # alone.
  done

  if [ "$unrecognised" = 1 ]; then
    SELECT_BUILD=("${ALL_IMAGES[@]}")
    SELECT_SMOKE=("${ALL_IMAGES[@]}")
  fi
}

cmd="${1:-}"
case "$cmd" in
  select | smoke)
    collect
    # Guarded rather than expanded bare: an empty array is an unset variable to `set -u`
    # on the bash 3.2 a developer's Mac has, where CI's bash reads it as no arguments.
    if [ "$cmd" = select ]; then
      [ ${#SELECT_BUILD[@]} -eq 0 ] || print_selection "${SELECT_BUILD[@]}"
    else
      [ ${#SELECT_SMOKE[@]} -eq 0 ] || print_selection "${SELECT_SMOKE[@]}"
    fi
    ;;

  paths)
    [ $# -eq 2 ] || { usage >&2; exit 2; }
    known_image "$2" || exit 2
    # The pathspec ci-images.yml hands to `git diff` to decide whether this image may
    # move `:latest`. Written as a complement — the whole scope, less the paths that
    # reach some *other* image, less the two kinds that reach none — rather than as a
    # list of this image's inputs, because `select` fails open: a changed path under
    # images/ the rule has not been taught selects *every* image, and a gate that could
    # not see such a path would let two merges through it move `:latest` in whichever
    # order they happened to finish. The complement is taken over the same tables below,
    # so the two cannot drift.
    printf '%s\n' images "${CI_PATHS[@]}"
    for other in "${ALL_IMAGES[@]}"; do
      if [ "$other" != "$2" ]; then printf ':(exclude)images/%s\n' "$(own_dir "$other")"; fi
    done
    printf '%s\n' ':(exclude)images/*.md' ":(exclude)$SMOKE_HARNESS"
    ;;

  list)
    printf '%s\n' "${ALL_IMAGES[@]}"
    ;;

  *)
    usage >&2
    exit 2
    ;;
esac
