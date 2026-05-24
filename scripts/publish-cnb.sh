#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# bun run 调 bash 脚本时不会把 .env 注入子进程；这里显式加载，
# 让 .npmrc 里的 ${CNB_TOKEN} 能解析到。
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT_DIR/.env"
  set +a
fi

usage() {
  cat <<'EOF'
Usage: scripts/publish-cnb.sh [--dry-run|--publish] [--skip-verify]

Publishes tramito-layout to the CNB npm artifact registry configured in .npmrc.

Options:
  --dry-run      Build and show the package contents without publishing. Default.
  --publish      Publish to CNB with npm publish.
  --skip-verify  Skip bun test, type-check, and build.
  -h, --help     Show this help.

Environment:
  CNB_TOKEN      Required for --publish when .npmrc uses ${CNB_TOKEN}.
EOF
}

mode="dry-run"
verify="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      mode="dry-run"
      ;;
    --publish)
      mode="publish"
      ;;
    --skip-verify)
      verify="false"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  "$@"
}

require_command bun
require_command bunx
require_command npm

npmrc="$ROOT_DIR/.npmrc"
if [[ ! -f "$npmrc" ]]; then
  echo "Missing .npmrc; CNB registry credentials must be configured before publishing." >&2
  exit 1
fi

registry="$(awk -F= '/^registry=/{print $2; exit}' "$npmrc" | tr -d '\r')"
if [[ -z "$registry" ]]; then
  echo "Missing registry=... in .npmrc." >&2
  exit 1
fi

if [[ "$mode" == "publish" ]] && grep -q '\${CNB_TOKEN}' "$npmrc" && [[ -z "${CNB_TOKEN:-}" ]]; then
  echo "CNB_TOKEN is required for publishing because .npmrc references \${CNB_TOKEN}." >&2
  exit 1
fi

package_name="$(bun -e 'const p = await Bun.file("package.json").json(); console.log(p.name)')"
package_version="$(bun -e 'const p = await Bun.file("package.json").json(); console.log(p.version)')"

echo "Package: ${package_name}@${package_version}"
echo "Registry: ${registry}"
echo "Mode: ${mode}"

if [[ "$verify" == "true" ]]; then
  run bun test
  run bunx tsc --noEmit
  run bun run build
fi

if [[ "$mode" == "dry-run" ]]; then
  run npm pack --dry-run
  echo "Dry run complete. Publish with: scripts/publish-cnb.sh --publish"
else
  run npm publish --registry="$registry"
fi
