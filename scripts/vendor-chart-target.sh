#!/usr/bin/env bash
# Print the cubestack-operator branch a source ref vendors into. A tag does not
# record its source branch, so derive release-X.Y from its version.
set -euo pipefail

ref_type=$1
ref_name=$2

case "$ref_type" in
  branch)
    printf '%s\n' "$ref_name"
    ;;
  tag)
    tag=${ref_name#v}
    # Same SemVer rule as resolve-release-version; reject a malformed tag here too.
    SEMVER='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$'
    if ! printf '%s' "$tag" | grep -Eq "$SEMVER"; then
      printf '%s is not a release tag\n' "$ref_name" >&2
      exit 1
    fi
    core=${tag%%-*}
    printf 'release-%s\n' "${core%.*}"
    ;;
  *)
    printf 'unknown ref type: %s\n' "$ref_type" >&2
    exit 1
    ;;
esac
