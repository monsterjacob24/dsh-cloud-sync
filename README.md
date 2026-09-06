English | [简体中文](README.zh.md)

# dsh-cloud-sync

A cloud session-sync plugin for DeepSeek Harness (dsh): **it automatically backs up your local chat sessions to your own server and restores them onto a new machine with one click — restored sessions continue where they left off, just like local ones.**

- **End-to-end encrypted** — session titles, paths, and conversation content are encrypted before they ever leave your machine; the server (even a cloud provider) only ever sees ciphertext.
- **Automatic background sync** — just use dsh as usual; failed syncs retry automatically and never disturb local work.
- **Self-hosted** — your data lives on your own server, with no third-party cloud service in the loop.

## Prerequisites

- dsh installed locally (pre-release build)
- A machine to run the server on (cloud VM, NAS, or localhost; requires Node 22+)

## Step 1: Deploy the server

The server is a minimal storage program (a single Node process, no database) that stores and serves ciphertext without understanding it.

Put this repository on the server (`git clone`, or just copy the `packages/server/` directory), then from `packages/server/`:

```sh
pnpm install   # first time

# Personal use (single user)
DSH_SYNC_TOKEN=<pick-an-access-token> PORT=8787 pnpm start

# Shared server (one username + token per person)
DSH_SYNC_TOKENS="alice:<token-a>,bob:<token-b>" PORT=8787 pnpm start
```

- **Access tokens** are yours to generate (long random strings, e.g. `openssl rand -base64 32`); in multi-user mode hand each user their *username + token* pair — user data stays fully isolated.
- For long-running deployments keep it alive with systemd (sample unit: `packages/server/deploy/dsh-cloud-sync-server.service`).
- On the public internet, front it with nginx/caddy for HTTPS: session content is encrypted, but the access token travels in cleartext over plain HTTP and can be sniffed.

## Step 2: Install the plugin in dsh

Install from npm:

```sh
dsh plugin --profile web add dsh-session-cloud
```

Manual alternative: from the profile directory (default `~/.dsh/profiles/web/`) run `pnpm add dsh-session-cloud`, then append the package name to the `dsh.profile.bundles` array in that directory's `package.json` and restart dsh.

Offline install (no npm registry access): build a tarball and install that: `pnpm --filter dsh-session-cloud build && pnpm --filter dsh-session-cloud pack`, then `dsh plugin --profile web add <path-to-tarball>`.

## Step 3: Configure

Open dsh web → Settings → Plugins → **Cloud Sync** card and fill in:

| Field | What to enter |
|---|---|
| Server address | e.g. `http://your-server-ip:8787` |
| Username | The username your admin assigned (multi-user servers); leave empty on single-user servers |
| Access token | The token configured on the server (in multi-user mode, **your own**) |
| Passphrase | Pick one. **All your devices must use the same one** — it is the only decryption key |
| Device name | A name for this machine; **must be unique across your devices** |

Click **Test connection**; "Connected · N sessions in cloud" means you are set. From then on, sessions upload automatically (encrypted) as you use dsh.

## Daily use

- **Backup**: fully automatic. The settings card shows sync status and a manual "Sync all now" action.
- **Restore onto a new device**: install the plugin on the new device, fill in the same server address / username / token / **passphrase** (pick a different device name) → follow the startup prompt or the settings card's "Restore sessions from cloud…" → pick the sessions to restore (target paths are editable) → restored sessions appear under their workspaces and continue like local ones.

## FAQ

- **I forgot my passphrase. Can I recover it?** No. The key is derived from the passphrase and the server only holds ciphertext — a lost passphrase means lost data. Keep it safe.
- **What does the server store?** Only encrypted session data. The server operator can see object sizes, timestamps, and device names — never any conversation content.
- **How do multiple devices work?** Same passphrase, different device names. Once the second device is configured it can read the first device's backups directly.
- **Do failed syncs lose data?** No. The local session is the single source of truth and sync is one-way backup; failures retry automatically and can always be retried manually.
- **Which sessions are backed up?** Sessions in dsh's default storage format (zstd-compressed JSONL); profiles using `compression: none` are not supported — the status line will say so.

## Design & development

This repository is a monorepo: `packages/plugin` (the plugin) and `packages/server` (the reference server). Design and protocol documents are internal: maintained alongside the code but not published with it.

```sh
pnpm install
pnpm test                                        # all unit tests
pnpm --filter dsh-session-cloud typecheck && pnpm --filter dsh-session-cloud build
bash packages/plugin/test/e2e/m4/run.sh          # restore-flow e2e (self-driving)
```
