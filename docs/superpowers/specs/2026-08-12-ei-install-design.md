# ei install script — design

Date: 2026-08-12
Status: approved (design review)
Related: [2026-08-12-ei-cli-design.md](./2026-08-12-ei-cli-design.md), CLI implementation plan.

## Goal

Anyone can install `ei` on a fresh Linux box with one command, no prerequisites
other than `curl` (and `sudo` when installing system-wide):

```sh
curl -fsSL https://raw.githubusercontent.com/Kuureki/Ei/main/install.sh | sh
```

The README CLI section must lead with that one-liner.

## Components

### `install.sh` (repo root, POSIX sh)

Pure POSIX sh (no bashisms) so it runs anywhere `/bin/sh` exists.

Behavior, in order:

1. **Platform detect** — map `uname -s`/`uname -m`:

   | uname -m | asset |
   | --- | --- |
   | `x86_64` / `amd64` | `ei-linux-x64` |
   | `aarch64` / `arm64` | `ei-linux-arm64` |
   | anything else | exit 1, "unsupported platform" |

2. **Resolve version + base URL** — `EI_VERSION` env pins a tag (default
   `latest` → the GitHub `latest` release). Download base:

   `https://github.com/Kuureki/Ei/releases/<latest|download/<tag>>/`

   `EI_BASE_URL` overrides the whole prefix (used by tests; full prefix up to
   and including the trailing slash, then `<asset>` / `<asset>.sha256` are
   appended).

3. **Download** — `curl -fsSL "<base><asset>"` and
   `curl -fsSL "<base><asset>.sha256"` into a temp dir (`mktemp -d`, cleaned up
   on exit).
   - No `curl`: exit 1 with a message pointing at `apt install curl` etc.

4. **Checksum verify** — parse the first whitespace-separated token of
   `<asset>.sha256` as the expected hex digest (release.yml writes standard
   `sha256sum` output, so the sidecar is `"<64 hex>  <name>"`) and compare with
   the local digest from `sha256sum <file>` (GNU coreutils, standard on Linux),
   falling back to `shasum -a 256` (macOS) when the former is absent. Mismatch
   → exit 1, "checksum mismatch".

5. **Size sanity** — reject files under 100 KB ("downloaded file looks too
   small"), matching the CLI's own guard in `selfUpdate`.

6. **Install** — `EI_INSTALL_DIR` env override wins.
   - Default: if `/usr/local/bin` is in `PATH` → install there, using `sudo`
     when the script is not run as root (`id -u` check).
   - If no `sudo` is available (non-root user, no sudo), fall back to
     `$HOME/.local/bin` (created with `mkdir -p`).
   - "install" = `chmod 0755` + atomic move (`mv` to `.ei.tmp.<rand>` then
     `mv -f` into place) so a partially-written binary never lands.
   - Record prior binary (if any) beside it as `ei.previous` before replace —
     if verification below fails, restore it.

7. **Verify + finish** — run `<dir>/ei version`; on failure, restore `ei.previous`
   (remove the new binary) and exit 1. On success, print:

   ```
   ei <version> installed to <dir>/ei
   Next: run `ei setup` to bootstrap the agent host, or `ei doctor` for a preflight check.
   ```

   When `$HOME/.local/bin` was used and is not on `PATH`, print a hint to add
   it.

Exit codes: `0` ok; `1` any failure (unsupported platform, download, checksum,
size, verify, or install failure); `2` bad `EI_VERSION` (no such release → the
download 404s and is reported as such).

### `.github/workflows/release.yml` (modify)

After the Compile step, for each matrix row:

```yaml
- name: Checksums
  working-directory: packages/agent
  run: sha256sum ei-${{ matrix.target }} > ei-${{ matrix.target }}.sha256
```

and attach both `packages/agent/ei-${{ matrix.target }}` and
`packages/agent/ei-${{ matrix.target }}.sha256` via
`softprops/action-gh-release` (`files` becomes a list of both). The
latest-release `download/<asset>` URL serves these automatically.

### `.github/workflows/ci.yml` (modify)

Add a step running `sh -n install.sh` (syntax check) on push/PR.

## Data flow

```
README one-liner
   └─> curl install.sh | sh
        ├─> resolve base (EI_VERSION | latest)
        ├─> download ei-linux-<arch> + .sha256
        ├─> sha256sum verify (sha256sum | shasum -a 256)
        ├─> size sanity (>= 100 KB)
        ├─> install -> /usr/local/bin (sudo?) | ~/.local/bin  (atomic, .previous kept)
        └─> `ei version` verify -> print next steps
```

## Error handling

- Failures are loud and specific: "unsupported platform", "curl not found",
  "download failed (HTTP …)", "checksum mismatch", "file too small", "verify
  failed". Each exits non-zero without leaving a partial install (temp dir
  removed; `ei.previous` restored on verify failure).
- Non-interactive by design: no prompts, safe to run in provisioning scripts.

## Testing

- `sh -n install.sh` in CI.
- Functional test (runnable locally by the developer, not part of CI):
  build a fake release dir containing an `ei-linux-x64` stub (a script that
  prints a version when run) and its `.sha256`, then run
  `EI_BASE_URL=file:///tmp/fake-release EI_INSTALL_DIR=/tmp/eiprefix sh install.sh`
  and assert the binary landed, is executable, and `ei version` output appears.
- CI: full `bun test` + typecheck unchanged (script touches no TS).

## Docs

- `README.md`, section "## 8. CLI": lead with the one-liner, then the safer
  download-then-run variant, then the existing from-source note.
- `docs/ENV.md` "## CLI" block: one line each for `EI_INSTALL_DIR` and
  `EI_VERSION`.

## Non-goals

- No Windows/macOS support (assets are linux-only; script still degrades
  gracefully with "unsupported platform").
- No signature verification (GPG/ed25519) — sha256 pinning is a supply-chain
  improvement that stops accidental corruption/interception; full signing is a
  separate effort.
- No caching/upgrade logic in the script; `ei upgrade` (CLI) owns that.
