#!/bin/sh
# ei installer — POSIX sh, linux only.
#   curl -fsSL https://raw.githubusercontent.com/Kuureki/Ei/main/install.sh | sh
# Env overrides: EI_REPO, EI_VERSION (tag, default latest), EI_BASE_URL,
#   EI_INSTALL_DIR. Downloads <asset> + <asset>.sha256, verifies digest and
#   size, installs atomically, then smoke-checks `ei version`.
set -eu

REPO="${EI_REPO:-Kuureki/Ei}"
VERSION="${EI_VERSION:-latest}"

# ---- platform ----------------------------------------------------------
case "$(uname -s)" in
  Linux) ;;
  *) echo "ei: unsupported platform: $(uname -s) (linux only)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) ASSET="ei-linux-x64" ;;
  aarch64 | arm64) ASSET="ei-linux-arm64" ;;
  *) echo "ei: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# ---- resolve base url ---------------------------------------------------
if [ -n "${EI_BASE_URL:-}" ]; then
  BASE_URL="$EI_BASE_URL"
elif [ "$VERSION" = "latest" ]; then
  BASE_URL="https://github.com/$REPO/releases/latest/download"
else
  BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
fi

# ---- tools ---------------------------------------------------------------
if ! command -v curl >/dev/null 2>&1; then
  echo "ei: curl not found — install curl (e.g. apt install curl) and retry" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  echo "ei: neither sha256sum nor shasum found" >&2
  exit 1
fi

in_path() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# ---- download + verify ----------------------------------------------------
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT HUP INT TERM

echo "ei: downloading $ASSET from $BASE_URL"
if ! curl -fsSL "$BASE_URL/$ASSET" -o "$TMPDIR/ei"; then
  echo "ei: download failed for $ASSET (HTTP ${CURL_HTTP_CODE:-?})" >&2
  exit 1
fi
if ! curl -fsSL "$BASE_URL/$ASSET.sha256" -o "$TMPDIR/ei.sha256"; then
  echo "ei: download failed for $ASSET.sha256" >&2
  exit 1
fi

EXPECTED="$(awk '{print $1}' "$TMPDIR/ei.sha256")"
ACTUAL="$(digest "$TMPDIR/ei")"
if [ -z "$EXPECTED" ]; then
  echo "ei: checksum file contains no digest" >&2
  exit 1
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "ei: checksum mismatch" >&2
  exit 1
fi

SIZE="$(wc -c < "$TMPDIR/ei")"
if [ "$SIZE" -lt 100000 ]; then
  echo "ei: downloaded file looks too small ($SIZE bytes)" >&2
  exit 1
fi
chmod 0755 "$TMPDIR/ei"

# ---- install dir -----------------------------------------------------------
USE_SUDO=""
if [ -n "${EI_INSTALL_DIR:-}" ]; then
  INSTALL_DIR="$EI_INSTALL_DIR"
elif [ -d /usr/local/bin ] && in_path /usr/local/bin; then
  if [ "$(id -u)" -eq 0 ]; then
    INSTALL_DIR=/usr/local/bin
  elif command -v sudo >/dev/null 2>&1; then
    INSTALL_DIR=/usr/local/bin
    USE_SUDO=1
  else
    INSTALL_DIR="$HOME/.local/bin"
  fi
else
  INSTALL_DIR="$HOME/.local/bin"
fi
mkdir -p "$INSTALL_DIR"
TARGET="$INSTALL_DIR/ei"

# backup the current binary before replacing (restored if verify fails)
if [ -f "$TARGET" ]; then
  cp "$TARGET" "$TMPDIR/ei.previous"
fi

# stage inside the target dir so the final mv is an atomic rename
STAGE="$INSTALL_DIR/.ei.tmp.$$"
if [ -n "$USE_SUDO" ]; then
  sudo cp "$TMPDIR/ei" "$STAGE"
  sudo chmod 0755 "$STAGE"
  sudo mv -f "$STAGE" "$TARGET"
else
  cp "$TMPDIR/ei" "$STAGE"
  chmod 0755 "$STAGE"
  mv -f "$STAGE" "$TARGET"
fi

# ---- verify + finish -------------------------------------------------------
if ! "$TARGET" version >"$TMPDIR/version.out" 2>&1; then
  echo "ei: installed binary failed verification — restoring previous version" >&2
  cat "$TMPDIR/version.out" >&2
  if [ -n "$USE_SUDO" ]; then
    if [ -f "$TMPDIR/ei.previous" ]; then sudo mv -f "$TMPDIR/ei.previous" "$TARGET"; else sudo rm -f "$TARGET"; fi
  else
    if [ -f "$TMPDIR/ei.previous" ]; then mv -f "$TMPDIR/ei.previous" "$TARGET"; else rm -f "$TARGET"; fi
  fi
  exit 1
fi

INSTALLED_VERSION="$(awk 'NR==1{print; exit}' "$TMPDIR/version.out")"
echo "ei $INSTALLED_VERSION installed to $TARGET"
echo 'Next: run `ei setup` to bootstrap the agent host, or `ei doctor` for a preflight check.'
if [ "$INSTALL_DIR" = "$HOME/.local/bin" ] && ! in_path "$HOME/.local/bin"; then
  echo "Add $HOME/.local/bin to your PATH (e.g. export PATH=\"$HOME/.local/bin:\$PATH\")."
fi
