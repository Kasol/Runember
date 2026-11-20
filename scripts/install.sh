#!/bin/sh
set -eu
version=v2.2.0-beta.5
install_dir=
start=0
json=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) version=$2; shift 2 ;;
    --install-dir) install_dir=$2; shift 2 ;;
    --start) start=1; shift ;;
    --json) json=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done
[ "$(uname -s)" = Darwin ] || { echo 'This installer supports macOS.' >&2; exit 1; }
printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$' || { echo 'Invalid version' >&2; exit 1; }
case "$(uname -m)" in arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) echo 'Unsupported architecture' >&2; exit 1 ;; esac
folder=runember-${version#v}-macos-$arch
if [ -z "$install_dir" ]; then install_dir="$HOME/Library/Application Support/Runember/runtime/$folder"; fi
case "$install_dir" in /*) ;; *) echo 'Install directory must be absolute.' >&2; exit 1 ;; esac
if [ ! -d "$install_dir" ]; then
  work=$(mktemp -d "${TMPDIR:-/tmp}/runember-install.XXXXXXXX")
  trap 'rm -rf -- "$work"' EXIT HUP INT TERM
  asset=$folder.tar.gz
  url=https://github.com/Kasol/Runember/releases/download/$version/$asset
  curl --fail --location --retry 2 "$url" -o "$work/$asset"
  curl --fail --location --retry 2 "$url.sha256" -o "$work/$asset.sha256"
  (cd "$work" && shasum -a 256 -c "$asset.sha256") >&2
  tar -tzf "$work/$asset" > "$work/entries"
  if grep -E '(^/|(^|/)\.\.(/|$))' "$work/entries" >/dev/null; then echo 'Invalid archive path' >&2; exit 1; fi
  mkdir "$work/extract"
  tar -xzf "$work/$asset" -C "$work/extract"
  [ -f "$work/extract/$folder/runtime.json" ] || { echo 'Runtime manifest missing' >&2; exit 1; }
  mkdir -p "$(dirname "$install_dir")"
  [ ! -e "$install_dir" ] || { echo 'Destination changed during install' >&2; exit 1; }
  mv "$work/extract/$folder" "$install_dir"
fi
[ -x "$install_dir/runember" ] && [ -f "$install_dir/runtime.json" ] || { echo 'Existing directory is not a Runember runtime.' >&2; exit 1; }
manifest="$install_dir/runtime.json"
[ "$(/usr/bin/plutil -extract product raw -o - "$manifest")" = Runember ] &&
[ "$(/usr/bin/plutil -extract version raw -o - "$manifest")" = "${version#v}" ] &&
[ "$(/usr/bin/plutil -extract platform raw -o - "$manifest")" = darwin ] &&
[ "$(/usr/bin/plutil -extract arch raw -o - "$manifest")" = "$arch" ] || { echo 'Version or architecture mismatch.' >&2; exit 1; }
report=$(mktemp "${TMPDIR:-/tmp}/runember-diagnostics.XXXXXXXX")
code=0
"$install_dir/runember" doctor --json > "$report" || code=$?
if [ "$start" = 1 ]; then "$install_dir/runember" start --no-browser >&2; fi
if [ "$json" = 1 ]; then
  "$install_dir/node" -e 'const fs=require("fs");console.log(JSON.stringify({status:process.argv[4]==="0"?"installed":"needs_setup",installDir:process.argv[2],command:process.argv[2]+"/runember",diagnostics:JSON.parse(fs.readFileSync(process.argv[1],"utf8"))},null,2))' "$report" "$install_dir" "$version" "$code"
else printf 'Runember installed: %s\nCommand: %s/runember\n' "$install_dir" "$install_dir"; fi
rm -f "$report"
[ "$code" = 0 ] || exit 2
