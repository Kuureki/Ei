# ei Install Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A curl-able, checksum-verified install script for `ei` plus the release/CI/docs plumbing that makes the README one-liner the primary install path.

**Architecture:** A single POSIX-sh script at the repo root downloads the platform binary and a `.sha256` sidecar from GitHub releases, verifies digest + size, installs atomically to `/usr/local/bin` (sudo) or `~/.local/bin`, and smoke-checks `ei version`. `release.yml` gains a sha256 sidecar per matrix asset; `ci.yml` syntax-checks the script; README leads with the one-liner.

**Tech Stack:** POSIX `/bin/sh` (no bashisms), `curl`, `sha256sum` (fallback `shasum -a 256`), `uname`, GNU coreutils (`install`/`cp`/`mv`), GitHub Actions (`release.yml`, `ci.yml`).

## Global Constraints

- Portability: script must run on any `/bin/sh` (dash/busybox/bash-as-sh), Linux only.
- Asset names are exactly `ei-linux-x64` and `ei-linux-arm64` (CLI `releaseAssetName` output); tags are `vX.Y.Z`; sidecars are `<asset>.sha256` written by `sha256sum` with stdout `"<64 hex>  <name>"`.
- Download URLs: latest → `https://github.com/Kuureki/Ei/releases/latest/download/<asset>`; pinned → `https://github.com/Kuureki/Ei/releases/download/<tag>/<asset>`.
- No interactivity: the script must be safe for provisioning scripts and behave identically non-TTY.
- Every failure path exits non-zero with a specific message and leaves no partial install (temp dir cleaned; prior binary restored on verification failure).
- Version floor: bun 1.3.14 for CI (`oven-sh/setup-bun@v2`), unchanged from existing workflows.

---

### Task 1: `install.sh` script + functional smoke

**Files:**
- Create: `/root/dev/projects/Ei/install.sh`
- Test: manual `sh -n` + functional smokes against a fake local release dir (commands below)

**Interfaces:**
- Consumes: the release asset names above (produced by `release.yml` in Task 2; the fake-release smoke in this task stands in for them).
- Produces: `install.sh` (executable), honoring env overrides `EI_REPO` (default `Kuureki/Ei`), `EI_VERSION` (default `latest`), `EI_BASE_URL` (full prefix incl. trailing slash; overrides `EI_REPO`/`EI_VERSION`), `EI_INSTALL_DIR` (default: `/usr/local/bin` via `sudo` when needed, else `$HOME/.local/bin`).

- [ ] **Step 1: Write the script**

```sh
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
```

Notes for the implementer:
- `cp` when root already has write access to `$HOME/.local/bin` (the no-sudo fallback) — the plain `cp`/`mv` branch covers it.
- The `CURL_HTTP_CODE` reference in the first error message is best-effort; `curl -f` exits 22/60/18 on HTTP/SSL errors, so the message is informational. Do not change the trailing behavior.

- [ ] **Step 2: Syntax check**

Run: `cd /root/dev/projects/Ei && sh -n install.sh && chmod +x install.sh`
Expected: exit 0, no output.

- [ ] **Step 3: Build a fake release and smoke the happy path**

Run:

```bash
set -eu
rm -rf /tmp/ei-fake-release /tmp/ei-prefix
mkdir -p /tmp/ei-fake-release
printf '#!/bin/sh\necho "v9.9.9-test"\n' > /tmp/ei-fake-release/ei-linux-x64
chmod +x /tmp/ei-fake-release/ei-linux-x64
cd /tmp/ei-fake-release && sha256sum ei-linux-x64 > ei-linux-x64.sha256
cd /tmp && EI_BASE_URL="file:///tmp/ei-fake-release" EI_INSTALL_DIR="/tmp/ei-prefix" sh /root/dev/projects/Ei/install.sh
/tmp/ei-prefix/ei version
ls -l /tmp/ei-prefix/ei
```

Expected: output lines `ei: downloading ei-linux-x64 from file:///tmp/ei-fake-release`, `ei v9.9.9-test installed to /tmp/ei-prefix/ei`, `Next: run \`ei setup\` ...`; `ei version` prints `v9.9.9-test`; file is `-rwxr-xr-x`.

- [ ] **Step 4: Smoke the checksum-mismatch failure**

Run:

```bash
printf '#!/bin/sh\necho "evil"\n' > /tmp/ei-fake-release/ei-linux-x64
cd /tmp/ei-fake-release && sha256sum ei-linux-x64 > ei-linux-x64.sha256
cd /tmp && EI_BASE_URL="file:///tmp/ei-fake-release" EI_INSTALL_DIR="/tmp/ei-prefix" sh /root/dev/projects/Ei/install.sh; echo "exit=$?"
```

Expected: `ei: checksum mismatch` on stderr, `exit=1`, and `/tmp/ei-prefix/ei` still prints `v9.9.9-test` (previous binary intact).

- [ ] **Step 5: Smoke unsupported platform + missing curl messages**

Run: `EI_BASE_URL="file:///tmp/ei-fake-release" sh /root/dev/projects/Ei/install.sh` on a non-Linux shell is not possible here; instead assert the platform branch logic is inert by confirming the happy-path run above already exercised `uname` Linux/x86_64. For the curl guard, simulate via `PATH`:

```bash
mkdir -p /tmp/ei-nobin && PATH="/tmp/ei-nobin" sh /root/dev/projects/Ei/install.sh; echo "exit=$?"
```

Expected: `ei: curl not found — install curl (e.g. apt install curl) and retry`, `exit=1`.

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add install.sh
git commit -m "feat(cli): curl-able ei install script with sha256 verification

POSIX sh one-liner installer: resolves the latest (or EI_VERSION-pinned)
release, downloads the platform binary and .sha256 sidecar, verifies
digest and size, installs atomically to /usr/local/bin (sudo) or
~/.local/bin, and smoke-checks ei version, restoring the previous binary
on failure. EI_BASE_URL/EI_INSTALL_DIR overrides for tests and custom
prefixes.

Per spec 2026-08-12-ei-install-design.

Co-authored-by: factory-droid[bot] <138933558+factory-droid[bot]@users.noreply.github.com>"
```

---

### Task 2: Checksum sidecars, CI check, docs, full verification

**Files:**
- Modify: `/root/dev/projects/Ei/.github/workflows/release.yml`, `/root/dev/projects/Ei/.github/workflows/ci.yml`, `/root/dev/projects/Ei/README.md` (`## 8. CLI`), `/root/dev/projects/Ei/docs/ENV.md` (`## CLI`)
- Test: full repo verification (below)

**Interfaces:**
- Consumes: `install.sh` (Task 1) — its asset/sidecar names and URL scheme.
- Produces: release assets `ei-linux-x64`, `ei-linux-arm64`, plus `ei-linux-x64.sha256`, `ei-linux-arm64.sha256`; CI gate on install.sh syntax; README one-liner.

- [ ] **Step 1: Add checksums to release.yml**

Edit `release.yml`: insert a `Checksums` step after `Compile` and expand the `softprops/action-gh-release@v2` `files` to a multi-line list:

```yaml
      - name: Compile
        working-directory: packages/agent
        run: bun build --compile --target ${{ matrix.target }} --outfile ei-${{ matrix.target }} cli/main.ts
      - name: Checksums
        working-directory: packages/agent
        run: sha256sum ei-${{ matrix.target }} > ei-${{ matrix.target }}.sha256
      - name: Smoke test
        working-directory: packages/agent
        run: ./ei-${{ matrix.target }} version && ./ei-${{ matrix.target }} doctor --json --dry-run | head -c 2000
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            packages/agent/ei-${{ matrix.target }}
            packages/agent/ei-${{ matrix.target }}.sha256
```

Run: `cd /root/dev/projects/Ei && git diff .github/workflows/release.yml`
Expected: only the `Checksums` step and `files:` block differ.

- [ ] **Step 2: Add the install.sh syntax check to ci.yml**

Edit `ci.yml`, adding after the typecheck step:

```yaml
      - run: bun run typecheck
      - name: Install script syntax
        run: sh -n install.sh
      - name: Agent tests
        working-directory: packages/agent
        run: bun test
```

- [ ] **Step 3: README one-liner**

Edit `README.md` `## 8. CLI` so the section reads (insert the install block between the intro sentence and the existing command list; keep the rest intact):

```markdown
## 8. CLI

`ei` is a compiled, self-updating command line for operating the agent.
Install on any Linux box with one command:

```sh
curl -fsSL https://raw.githubusercontent.com/Kuureki/Ei/main/install.sh | sh
```

Prefer downloading and inspecting first? Same script, two steps:

```sh
curl -fSL https://raw.githubusercontent.com/Kuureki/Ei/main/install.sh -o install.sh
sh install.sh
```

`EI_VERSION=<tag>` pins a specific release (default: latest),
`EI_INSTALL_DIR=<dir>` overrides the install prefix (default
`/usr/local/bin` via `sudo`, else `~/.local/bin`). The binary is verified
against a `.sha256` sidecar before install.

    ei setup     bootstrap a host (doppler, deps, build, register, systemd)
```

- [ ] **Step 4: ENV.md install overrides**

Append to the `## CLI` block in `docs/ENV.md`:

```markdown
- `EI_INSTALL_DIR` — override `install.sh`'s prefix (default `/usr/local/bin` via sudo, else `~/.local/bin`).
- `EI_VERSION` — pin a release tag in `install.sh` (default: latest).
```

- [ ] **Step 5: Full verification**

Run:

```bash
cd /root/dev/projects/Ei
sh -n install.sh
cd packages/agent && bun test 2>&1 | tail -4
cd /root/dev/projects/Ei && bun run typecheck
cd packages/agent && bun run typecheck
```

Expected: `sh -n` clean; agent tests 144 pass / 0 fail; both typechecks clean.

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add .github/workflows/release.yml .github/workflows/ci.yml README.md docs/ENV.md
git commit -m "feat(cli): sha256 release sidecars, install doc one-liner

release.yml now emits a sha256 sidecar per compiled asset and uploads
both; ci.yml syntax-checks install.sh; README leads the CLI section with
the curl | sh one-liner and documents EI_VERSION/EI_INSTALL_DIR; ENV.md
lists the overrides.

Per spec 2026-08-12-ei-install-design.

Co-authored-by: factory-droid[bot] <138933558+factory-droid[bot]@users.noreply.github.com>"
```

---

## Self-review notes (write-only, for the planner)

- Spec coverage: behavior 1–7 → Task 1 Steps 1–5; release.yml sidecar → Task 2 Step 1; ci.yml `sh -n` → Task 2 Step 2; testing → Task 1 Steps 2–5 + Task 2 Step 5; README → Task 2 Step 3; ENV.md → Task 2 Step 4. Non-goals untouched (no macOS/Windows paths — the script still errors cleanly on them via the `uname -s` guard; no signing; no upgrade logic in the script).
- Type/name consistency: `ei-linux-x64`/`ei-linux-arm64` match `cli/version.ts` `releaseAssetName`; `.sha256` naming matches `sha256sum` output parsing in the script (`awk '{print $1}'`); `EI_BASE_URL`/`EI_INSTALL_DIR` used identically in spec, script, and README.
- Shell correctness: `set -eu` is safe because every failure site `exit 1`s explicitly and `if ! cmd` guards the two commands whose non-zero exit is expected (`curl -f`, `$TARGET version`); `$(...)`/`mktemp -d`/trap quote correctly; no bashisms (`local`, `[[`, `&>` absent).
- Placeholder scans: no TBDs; every step has concrete commands and expected output. The fake-release smoke replaces a real GitHub release (none exist yet for the CLI binary), so Task 1 is runnable today.
