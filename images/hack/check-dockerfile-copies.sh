#!/usr/bin/env bash
# The convention the image-selection rule rests on: a Dockerfile reads from its own
# directory and from common/, never from a sibling image's.
#
# images/hack/changed-images.sh answers "which images does this diff reach" from a path
# alone, and that is only sound while this holds. One `COPY jupyter/start-jupyter.sh`
# inside the MACA Dockerfile would give that image an input nothing can see: a change to
# that file would rebuild the MACA image from content the rule never accounted for, and
# the paths that decide its `:latest` would not cover it. Nothing else asserts this, and
# the failure is invisible, so it is checked here rather than trusted.
#
# The build context for every Dockerfile is the images/ directory — see .dockerignore,
# which ignores everything and re-includes these directories one by one — so a COPY
# source's first path segment names the directory it comes from.
#
# Usage: make -C images check-deps
set -euo pipefail

cd "$(dirname "$0")/.." # the images/ directory: COPY sources are relative to it, as the context is

files=0
sources=0
failed=0

for dockerfile in */Dockerfile; do
  own="${dockerfile%/Dockerfile}"
  files=$((files + 1))

  # One instruction at a time, with continuations joined: a COPY wrapped over several
  # lines is one instruction, and reading line by line would check only its first
  # fragment — the part that happens to be well-formed.
  lineno=0
  start=0
  instruction=""
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))

    continued=0
    if [[ "$line" == *\\ ]]; then
      continued=1
      line="${line%\\}"
    fi

    if [ -z "$instruction" ]; then
      start=$lineno
      instruction="$line"
    else
      instruction="$instruction $line"
    fi
    if [ "$continued" = 1 ]; then continue; fi

    case "$instruction" in
      COPY[[:space:]]* | ADD[[:space:]]*) ;;
      *)
        instruction=""
        continue
        ;;
    esac

    # The instruction word, then its arguments. Flags come first by the Dockerfile
    # grammar, so the leading ones go; the last argument is the destination and
    # everything between is a source.
    # shellcheck disable=SC2086
    set -- $(printf '%s' "${instruction#* }")
    from_stage=0
    while [ $# -gt 1 ] && [[ "$1" == --* ]]; do
      if [[ "$1" == --from=* ]]; then from_stage=1; fi
      shift
    done

    # --from reads a stage's or another image's filesystem, not this build context, so
    # none of its paths is an input the rule could name — and the stage's own COPYs are
    # checked here as well, being in this same file. Named rather than passed over: an
    # unchecked instruction should be visible, not silent.
    if [ "$from_stage" = 1 ]; then
      printf 'check-dockerfile-copies.sh: %s:%s: COPY --from, sources not checked\n' \
        "$dockerfile" "$start"
      instruction=""
      continue
    fi

    while [ $# -gt 1 ]; do
      source="$1"
      shift
      sources=$((sources + 1))

      case "$source" in
        common/* | "$own"/*) ;;
        *)
          failed=1
          printf '%s:%s: COPY source %s is outside common/ and %s/.\n' \
            "$dockerfile" "$start" "$source" "$own" >&2
          printf '%s: images/hack/changed-images.sh derives an image'"'"'s inputs from its\n' \
            "$dockerfile" >&2
          printf '    path alone, so a source elsewhere is an input that rule cannot see.\n' >&2
          ;;
      esac
    done

    instruction=""
  done <"$dockerfile"
done

if [ "$failed" = 0 ]; then
  printf 'check-dockerfile-copies.sh: %s COPY sources across %s Dockerfiles, all within the convention\n' \
    "$sources" "$files"
fi
exit "$failed"
