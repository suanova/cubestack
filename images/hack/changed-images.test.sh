#!/usr/bin/env bash
# Fixtures for changed-images.sh — the rule's only test, and neither needs a registry,
# a network or a cluster: the input is a list of paths and the output is a list of names.
#
# Two halves:
#
#   * a table of diffs and the selection each must produce, one row per branch of the
#     rule. That is the readable half, and the half to extend when a branch is added.
#
#   * an equivalence check against the repository itself, because the load-bearing
#     claim of the whole design is that an image's `paths` and the diffs `select` starts
#     a run for name the same set. Here they are compared exhaustively rather than by
#     inspection: every tracked file the `paths` pathspec matches must be one `select`
#     claims that image for, and every tracked file under the rule's scope that `select`
#     claims must be one the pathspec matches. That is the property ci-images.yml's
#     `:latest` gate rests on, and the one no fixture table can establish.
#
# Usage: make -C images check-select
set -euo pipefail

cd "$(dirname "$0")/../.." # repository root: the paths below are the ones CI passes
SUT=images/hack/changed-images.sh
ALL="ssh jupyter maca ssh-maca cuda ssh-cuda"

cases=0
failures=0

# One line, for comparing a selection against an expectation. Command substitution
# keeps the newlines a multi-image selection has — they are only collapsed when the
# value is word-split — so the flattening has to be explicit.
flat() { printf '%s' "$1" | tr '\n' ' ' | sed 's/ *$//'; }

check() { # check <name> <expected-build> <expected-smoke> <path>...
  local name="$1" want_build="$2" want_smoke="$3"
  shift 3
  local got_build got_smoke
  # stderr dropped: two rows below are unrecognised paths, which the rule reports on
  # stderr by design, and that report is asserted on its own further down.
  got_build="$(flat "$(printf '%s\n' "$@" | "$SUT" select 2>/dev/null)")"
  got_smoke="$(flat "$(printf '%s\n' "$@" | "$SUT" smoke 2>/dev/null)")"
  cases=$((cases + 1))
  if [ "$got_build" != "$want_build" ] || [ "$got_smoke" != "$want_smoke" ]; then
    failures=$((failures + 1))
    printf 'FAIL  %s\n' "$name"
    printf '      build: want [%s] got [%s]\n' "$want_build" "$got_build"
    printf '      smoke: want [%s] got [%s]\n' "$want_smoke" "$got_smoke"
  else
    printf 'ok    %s\n' "$name"
  fi
}

# The grouping, compared as exact JSON text rather than as a parsed value: that text is what
# ci-operator.yml's `matrix.include` expands, so a reordering or a reformat is a change the
# workflow reads.
check_groups() { # check_groups <name> <expected-json> <image>...
  local name="$1" want="$2" got
  shift 2
  got="$("$SUT" groups "$@")"
  cases=$((cases + 1))
  if [ "$got" != "$want" ]; then
    failures=$((failures + 1))
    printf 'FAIL  %s\n' "$name"
    printf '      want [%s] got [%s]\n' "$want" "$got"
  else
    printf 'ok    %s\n' "$name"
  fi
}

# --- the table -----------------------------------------------------------------
#
# Rows 3 and 4 are the two reasons markdown is checked first and by a pattern that
# spans directories: a documentation edit on the image contract must publish nothing,
# at any depth, and a README inside an image directory must not select that image.

check "an empty diff" "" ""
check "another project" "" "" operator/internal/controller/devenv.go web/src/app.ts
check "markdown at images/ root" "" "" images/README.md
check "markdown inside an image directory" "" "" images/jupyter/README.md

check "an image's own file" ssh ssh images/ssh-ubuntu-server/Dockerfile
check "the jupyter launcher" jupyter jupyter images/jupyter/start-jupyter.sh
check "the maca image's own file" maca maca images/jupyter-maca-pytorch/Dockerfile
check "the maca ssh daemon config" ssh-maca ssh-maca images/ssh-maca-pytorch/Dockerfile
check "the cuda image's own file" cuda cuda images/jupyter-cuda-pytorch/Dockerfile
check "the cuda ssh daemon config" ssh-cuda ssh-cuda images/ssh-cuda-pytorch/Dockerfile

check "a shared runtime file" "$ALL" "$ALL" images/common/sshd/install-dropin.sh
# The vendor jupyter launcher lives under common/ because the two vendor jupyter images share
# it, and check-dockerfile-copies.sh admits nowhere else a file two images can read from. So
# an edit to one vendor's launcher reaches every image, the CPU pair included — none of which
# is built from it. That is this rule's over-selecting bargain, and a path that selected
# `maca` alone until the launcher moved.
check "the vendor jupyter launcher" "$ALL" "$ALL" images/common/jupyter/start-jupyter.sh
check "the Makefile" "$ALL" "$ALL" images/Makefile
check "the context definition" "$ALL" "$ALL" images/.dockerignore
check "the publish workflow" "$ALL" "$ALL" .github/workflows/ci-images.yml
check "the smoke workflow" "$ALL" "$ALL" .github/workflows/ci-operator.yml
check "the selection action" "$ALL" "$ALL" .github/actions/changed-images/action.yml

# The two selections differ on this path and nowhere else.
check "the smoke harness" "" "$ALL" images/hack/smoke.sh

# Deliberately a directory no image claims, and named so it reads that way: `cuda` is a real
# token now, and a fixture calling itself pytorch-cuda would look like a near-miss of an image
# that exists rather than like the unclaimed path this is testing.
check "a new image directory" "$ALL" "$ALL" images/rocm-pytorch/Dockerfile
check "a stray file at images/ root" "$ALL" "$ALL" images/notes.txt

# A selection is a union over the whole diff, not the last path to match, and these two
# share no input and are not each other's.
check "two images' own files" "jupyter ssh-maca" "jupyter ssh-maca" \
  images/jupyter/start-jupyter.sh images/ssh-maca-pytorch/Dockerfile

# The same union across bases: one selection, two legs below.
check "images on different bases" "jupyter ssh-cuda" "jupyter ssh-cuda" \
  images/jupyter/start-jupyter.sh images/ssh-cuda-pytorch/Dockerfile

# The other half of the unrecognised branch: selecting everything is a guess, so it has
# to say so. Silence would leave the next person to find the gap by reading the script.
warned="$(printf 'images/notes.txt\n' | "$SUT" select 2>&1 >/dev/null)"
cases=$((cases + 1))
case "$warned" in
  *'not a known build input'*)
    printf 'ok    an unrecognised path warns on stderr\n'
    ;;
  *)
    failures=$((failures + 1))
    printf 'FAIL  an unrecognised path must warn on stderr, got [%s]\n' "$warned"
    ;;
esac

# --- the smoke matrix's legs ----------------------------------------------------
#
# One leg per base, which is what ci-operator.yml's `images-smoke` job expands from. Two
# properties are load-bearing and neither is visible in the selection above: a base the
# selection does not name contributes no leg at all (so a CUDA-only pull request schedules
# one job, not three), and the two images of one base are one leg (so they share a runner
# instead of unpacking that base twice).

check_groups "a selection with no images has no leg" '[]'
check_groups "the cuda pair is one leg" \
  '[{"base":"cuda","images":"cuda ssh-cuda","vendor":true}]' cuda ssh-cuda
check_groups "the cpu pair is one leg, and is not a vendor leg" \
  '[{"base":"ubuntu","images":"ssh jupyter","vendor":false}]' jupyter ssh
check_groups "a maca-only selection schedules no other base's leg" \
  '[{"base":"maca","images":"maca ssh-maca","vendor":true}]' maca ssh-maca
check_groups "one leg per selected base, in the table's order" \
  '[{"base":"ubuntu","images":"ssh jupyter","vendor":false},{"base":"maca","images":"maca ssh-maca","vendor":true},{"base":"cuda","images":"cuda ssh-cuda","vendor":true}]' \
  ssh jupyter maca ssh-maca cuda ssh-cuda
check_groups "a repeated name does not repeat a leg" \
  '[{"base":"cuda","images":"cuda ssh-cuda","vendor":true}]' cuda cuda ssh-cuda

# The primitive the action's publish matrix is sized from, asserted apart from the grouping
# so that a `vendor` gone wrong cannot hide behind a grouping fixture that agrees with it.
cases=$((cases + 1))
if [ "$("$SUT" vendor cuda)" = true ] && [ "$("$SUT" vendor jupyter)" = false ]; then
  printf 'ok    vendor follows the base, not a name list\n'
else
  failures=$((failures + 1))
  printf 'FAIL  vendor must read true for cuda and false for jupyter\n'
fi

# A name the rule does not know must fail loudly: a group silently dropped here is an image
# no run would ever smoke, which is the one outcome worse than an over-selection.
cases=$((cases + 1))
if grouped="$("$SUT" groups nosuch 2>/dev/null)"; then
  failures=$((failures + 1))
  printf 'FAIL  an unknown image must not be grouped, got [%s]\n' "$grouped"
else
  printf 'ok    an unknown image is refused rather than dropped from the matrix\n'
fi

# `list` is a tag publish's selection (the action's tag branch) and the order `groups` emits
# in, so it is pinned against the fixtures' own expectation rather than against itself.
cases=$((cases + 1))
if [ "$("$SUT" list | tr '\n' ' ' | sed 's/ *$//')" = "$ALL" ]; then
  printf 'ok    list names every image in the table order\n'
else
  failures=$((failures + 1))
  printf 'FAIL  list disagrees with the fixtures\n'
fi

# --- the rule's scope is exactly what it claims ---------------------------------

# Every tracked file outside images/ and the CI the rule names — the two workflows and the
# action both of them delegate to — must reach no image. The list is restated rather than
# read out of the rule, so the two have to be kept equal by hand; that is the same bargain
# the table above makes. One invocation rather than one per file: the selection is a union,
# so anything these produce would show up here.
outside=()
while IFS= read -r f; do
  outside+=("$f")
done < <(git ls-files | grep -v '^images/' | grep -vE '^\.github/(workflows/ci-(images|operator)\.yml|actions/changed-images/action\.yml)$' || true)
cases=$((cases + 1))
if [ "$(printf '%s\n' "${outside[@]:-}" | "$SUT" select)" != "" ]; then
  failures=$((failures + 1))
  printf 'FAIL  a path outside the rule reaches an image\n'
else
  printf 'ok    no path outside images/ and the CI the rule names reaches an image\n'
fi

# --- paths == select, exhaustively ----------------------------------------------
#
# `paths <image>` is what ci-images.yml hands to `git diff` to decide whether to move
# `:latest`. If it matched a file that does not start a run for that image, the tag
# would be withheld by a later commit that no run of that image would move it for.

scope=()
while IFS= read -r f; do
  scope+=("$f")
done < <(git ls-files -- images \
  .github/actions/changed-images/action.yml \
  .github/workflows/ci-images.yml \
  .github/workflows/ci-operator.yml)

for img in $ALL; do
  read -r -a path_args <<<"$("$SUT" paths "$img" | tr '\n' ' ')"

  gated=()
  while IFS= read -r f; do
    gated+=("$f")
  done < <(git ls-files -- "${path_args[@]}" | sort)

  claimed=()
  for f in "${scope[@]}"; do
    # Captured, padded and matched as a word — deliberately not `… | grep -qx "$img"`.
    # `grep -q` exits at the match, so under `pipefail` the pipeline reports the
    # writer's SIGPIPE (141) for an answer that was yes, and only when the match is not
    # the final line. That race claimed a different subset on every run.
    selection=" $(printf '%s\n' "$f" | "$SUT" select | tr '\n' ' ') "
    case "$selection" in
      *" $img "*) claimed+=("$f") ;;
    esac
  done

  cases=$((cases + 1))
  if diff <(printf '%s\n' "${gated[@]:-}" | sort) <(printf '%s\n' "${claimed[@]:-}" | sort) >/dev/null; then
    printf 'ok    paths %s == select %s (%s files)\n' "$img" "$img" "${#gated[@]}"
  else
    failures=$((failures + 1))
    printf 'FAIL  `paths %s` and `select` disagree:\n' "$img"
    # `|| true`: the diff is the finding, and it exits 1 — under `set -e` and pipefail
    # that would end the run here and hide every image after this one.
    diff <(printf '%s\n' "${gated[@]:-}" | sort) <(printf '%s\n' "${claimed[@]:-}" | sort) | sed 's/^/      /' || true
  fi
done

# --- the gate needs the pathspec, not a list of image names ----------------------

cases=$((cases + 1))
if [ "$("$SUT" paths jupyter | wc -l)" -lt 2 ]; then
  failures=$((failures + 1))
  printf 'FAIL  `paths` must emit a pathspec for git, not a name\n'
else
  printf 'ok    paths emits a pathspec\n'
fi

printf '\n%s: %s cases, %s failed\n' "$SUT" "$cases" "$failures"
[ "$failures" -eq 0 ]
