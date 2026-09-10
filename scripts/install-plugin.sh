#!/usr/bin/env bash
#
# install-plugin.sh -- build this plugin and copy it into an Obsidian vault.
#
# Usage:
#   scripts/install-plugin.sh [-n] VAULT
#
# Copies main.js, manifest.json and styles.css into
# VAULT/.obsidian/plugins/<id>/, with the id read from manifest.json.
# -n prints what would happen and changes nothing. An existing data.json,
# which holds the plugin's settings, is never touched.

set -euo pipefail

dry=0
if [ "${1:-}" = "-n" ]; then
  dry=1
  shift
fi

vault="${1:-}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "$vault" ]; then
  echo "usage: scripts/install-plugin.sh [-n] VAULT" >&2
  exit 2
fi

if [ ! -d "$vault/.obsidian" ]; then
  echo "install-plugin.sh: $vault has no .obsidian/ folder." >&2
  echo "  Open it as a vault in Obsidian once, then run this again." >&2
  exit 1
fi

manifest_field() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]])' \
    "$here/manifest.json" "$1"
}

id="$(manifest_field id)"
name="$(manifest_field name)"
dest="$vault/.obsidian/plugins/$id"

files=(main.js manifest.json)
if [ -f "$here/styles.css" ]; then
  files+=(styles.css)
fi

if [ "$dry" = 1 ]; then
  echo "would run: npm run build"
  for f in "${files[@]}"; do
    echo "would copy $f -> $dest/"
  done
  exit 0
fi

(cd "$here" && npm run build)

mkdir -p "$dest"
for f in "${files[@]}"; do
  cp "$here/$f" "$dest/$f"
  echo "copied $f -> $dest/"
done

echo
echo "Now enable it in Obsidian: Settings -> Community plugins -> $name."
