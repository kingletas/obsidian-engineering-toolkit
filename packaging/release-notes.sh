#!/usr/bin/env bash
#
# release-notes.sh -- print one version's section of the CHANGELOG.
#
# Usage:
#   packaging/release-notes.sh 0.2.0
#
# Environment overrides:
#   CHANGELOG   the file to read (default: CHANGELOG.md in this repository)
#
# The release workflow uses the output as the release body. Exits 1 when the
# version has no section, so a release cannot ship with an empty body.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-}"
CHANGELOG="${CHANGELOG:-$HERE/CHANGELOG.md}"

[ -n "$VERSION" ] || { echo "usage: release-notes.sh VERSION" >&2; exit 2; }

# Everything between "## [VERSION]" and the next "## " heading, compared as a string.
notes="$(awk -v version="$VERSION" '
  function bare(f) { gsub(/\[/, "", f); gsub(/\]/, "", f); gsub(/:/, "", f); return f }
  !found && $1 == "##" && bare($2) == version { found = 1; next }
  found && $1 == "##" { exit }
  found { print }
' "$CHANGELOG")"

# Drop the blank lines left at either end.
notes="$(printf '%s\n' "$notes" | sed -e '/./,$!d' -e ':a' -e '/^\n*$/{$d;N;ba' -e '}')"

if [ -z "$notes" ]; then
  echo "release-notes.sh: no section for $VERSION in $CHANGELOG" >&2
  exit 1
fi

printf '%s\n' "$notes"
