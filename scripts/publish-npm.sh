#!/usr/bin/env bash
# Publish @utir/ssc and/or @utir/ssc-mcp to npm.
#
# Usage:
#   scripts/publish-npm.sh <cli|mcp|both> [--otp <code>]
#   scripts/publish-npm.sh --scan-only <file...>
#
# Steps (publish):
#   1. Refuses if the working tree is dirty or has untracked files.
#   2. Clones HEAD into a temp directory (clean build).
#   3. pnpm install + builds the target package(s).
#   4. Runs the full test suite (apps/api/scripts/run-suite.sh).
#      Refuses to continue unless "Failed: 0" is in the output.
#   5. npm pack --dry-run: validates file list and scans for secrets.
#   6. npm publish (with --otp if provided).
set -euo pipefail
umask 022

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Secret scan ───────────────────────────────────────────────────────────────
# Key-shaped regexes — broad enough to catch real credentials, narrow enough
# to skip short code-string appearances like startsWith("ssc_").

SECRET_REGEXES=(
  "ssc_[A-Za-z0-9_-]{24,}"
  "sscp_[A-Za-z0-9_-]{24,}"
  "FlyV1 fm[0-9]_[A-Za-z0-9_-]{10,}"
  "whsec_[A-Za-z0-9+/=]{20,}"
  "sk_(live|test)_[A-Za-z0-9]{10,}"
  "BEGIN [A-Z ]*PRIVATE KEY"
)

# scan_for_secrets <file> [<file> ...]
# On a match: prints "<file>: pattern '<pattern>'" to stderr (never the match).
# Returns 1 if any secret found, 0 otherwise.
scan_for_secrets() {
  local found=0
  for file in "$@"; do
    for pattern in "${SECRET_REGEXES[@]}"; do
      if grep -qE "$pattern" "$file" 2>/dev/null; then
        echo "$file: pattern '$pattern'" >&2
        found=1
      fi
    done
  done
  return $found
}

# ── --scan-only mode ──────────────────────────────────────────────────────────

if [[ "${1:-}" == "--scan-only" ]]; then
  shift
  if [[ $# -eq 0 ]]; then
    echo "Usage: $0 --scan-only <file...>" >&2
    exit 1
  fi
  if scan_for_secrets "$@"; then
    exit 0
  else
    exit 1
  fi
fi

# ── Argument parsing ──────────────────────────────────────────────────────────

TARGET="${1:-}"
OTP_CODE=""
shift 1 || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --otp) OTP_CODE="$2"; shift 2 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ "$TARGET" != "cli" && "$TARGET" != "mcp" && "$TARGET" != "both" ]]; then
  echo "Usage: $0 <cli|mcp|both> [--otp <code>]" >&2
  exit 1
fi

# ── Working tree check ────────────────────────────────────────────────────────

if ! git -C "$REPO" diff --quiet HEAD; then
  echo "ERROR: working tree has uncommitted changes. Commit or stash first." >&2
  exit 1
fi
if [[ -n "$(git -C "$REPO" ls-files --others --exclude-standard)" ]]; then
  echo "ERROR: untracked files present. Add them or update .gitignore." >&2
  exit 1
fi

# ── Build targets list ────────────────────────────────────────────────────────

TARGETS=()
[[ "$TARGET" == "cli"  || "$TARGET" == "both" ]] && TARGETS+=("cli")
[[ "$TARGET" == "mcp"  || "$TARGET" == "both" ]] && TARGETS+=("mcp")

pkg_name() {
  [[ "$1" == "cli" ]] && echo "@utir/ssc" || echo "@utir/ssc-mcp"
}

# ── Clone HEAD into temp dir ──────────────────────────────────────────────────

TMPDIR_BUILD="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BUILD"' EXIT

echo "Cloning HEAD into $TMPDIR_BUILD ..."
git -C "$REPO" archive HEAD | tar -x -C "$TMPDIR_BUILD"

echo "Installing dependencies ..."
(cd "$TMPDIR_BUILD" && pnpm install --frozen-lockfile)

# ── Build each package ────────────────────────────────────────────────────────

for pkg in "${TARGETS[@]}"; do
  name="$(pkg_name "$pkg")"
  echo ""
  echo "=== Building $name ==="
  (cd "$TMPDIR_BUILD" && pnpm --filter "$name" run build)
done

# ── Run the full test suite ───────────────────────────────────────────────────

echo ""
echo "=== Running test suite ==="
SUITE_OUT="$(mktemp)"
"$REPO/apps/api/scripts/run-suite.sh" > "$SUITE_OUT" 2>&1 || true
grep -aE "✗|Passed|Failed" "$SUITE_OUT" || true

if ! grep -q "Failed: 0" "$SUITE_OUT"; then
  echo ""
  echo "ERROR: test suite did not pass (Failed: 0 not found). Refusing to publish." >&2
  echo "--- suite output ---" >&2
  cat "$SUITE_OUT" >&2
  rm -f "$SUITE_OUT"
  exit 1
fi
rm -f "$SUITE_OUT"
echo "Test suite passed."

# ── Pack + secret scan for each package ──────────────────────────────────────

for pkg in "${TARGETS[@]}"; do
  name="$(pkg_name "$pkg")"
  pkg_dir="$TMPDIR_BUILD/packages/$pkg"

  echo ""
  echo "=== Packing $name (dry run) ==="
  (cd "$pkg_dir" && npm pack --dry-run 2>&1)

  # Validate expected files are in the pack
  pack_list="$(cd "$pkg_dir" && npm pack --dry-run 2>&1)"
  if ! echo "$pack_list" | grep -q "dist/index.js"; then
    echo "ERROR: dist/index.js is missing from $name pack output." >&2
    exit 1
  fi
  if ! echo "$pack_list" | grep -qi "readme"; then
    echo "ERROR: README.md is missing from $name pack output." >&2
    exit 1
  fi
  echo "File list OK."

  # Scan dist/index.js for secrets
  if ! scan_for_secrets "$pkg_dir/dist/index.js"; then
    echo "ERROR: $name dist/index.js failed secret scan (see above)." >&2
    exit 1
  fi
  echo "Secret scan passed."
done

# ── Publish (or dry-run) ──────────────────────────────────────────────────────

for pkg in "${TARGETS[@]}"; do
  name="$(pkg_name "$pkg")"
  pkg_dir="$TMPDIR_BUILD/packages/$pkg"
  version="$(node -e "process.stdout.write(require('$pkg_dir/package.json').version)")"

  echo ""
  if [[ "${DRY_RUN:-}" == "1" ]]; then
    PACK_DEST="$(mktemp -d)"
    echo "=== DRY RUN: packing $name into $PACK_DEST ==="
    (cd "$pkg_dir" && npm pack --pack-destination "$PACK_DEST")
    echo "DRY RUN: would publish ${name}@${version}"
    rm -rf "$PACK_DEST"
  else
    echo "=== Publishing $name ==="
    publish_args=("npm" "publish")
    [[ -n "$OTP_CODE" ]] && publish_args+=("--otp" "$OTP_CODE")
    (cd "$pkg_dir" && SSC_PUBLISH_VIA_SCRIPT=1 "${publish_args[@]}")
    echo "Published $name."
  fi
done

echo ""
echo "Done."
