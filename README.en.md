# magpie-agent-trae-intl

Repository: <https://github.com/not502/magpie-agent-trae-intl>

Use the models configured in Magpie from **Trae (International)**. The plugin registers selected Magpie models as Trae custom models, starts a loopback request bridge on this machine, and keeps Magpie's model catalog synchronized with the custom-model list stored in the Trae account.

[中文版](README.md)

- Magpie Agent name: **Trae (International)** (agent id `trae-intl`)
- Entry in Trae's model menu: `<model display name> · Magpie`
- Loopback bridge: `http://127.0.0.1:3499`
- Plugin configuration directory: `~/.config/magpie-trae-intl`
- Package version: `0.1.0`, MIT

> **Verification boundary (read first)**
>
> This repository has been checked against **Windows 10/11 x64 + Trae International 3.6.20 + Magpie 0.1.4596** through static contract review, offline tests, and a **real-account catalog acceptance** (2026-11-21: create → read-back → idempotent re-sync → release/delete all passed, with zero change to the account's other models). End-to-end chat (selecting the model inside Trae and sending a message) and the optional client patch on a real installation remain unverified. Other Trae builds, macOS and Linux are unverified.
>
> Evidence and gaps: [`docs/design/architecture.md`](docs/design/architecture.md) §13 and §12 below.

---

## 1. What the plugin does

| Capability | Behaviour |
| --- | --- |
| Model catalog | Registers selected Magpie models as Trae `custom_openai_compatible` custom models; appends ` · Magpie` to the display name |
| Model capabilities | Synchronizes context length, output limit, image support and reasoning levels |
| Chat forwarding | Trae's native client calls `127.0.0.1:3499/v1/chat/completions`; the bridge replaces the auth header and forwards to the local Magpie gateway |
| Request fidelity | Streaming, tool calls, images and `reasoning_effort` are preserved; responses are relayed as raw bytes |
| Catalog updates | Checks the control file every 5 seconds; when idle, re-checks every 60 seconds |
| Disconnect recovery | Deletes entries the plugin created and nobody edited; restores adopted entries; keeps user-edited entries with a warning |
| Diagnostics | `status`, `models`, `sync`, `doctor`, `setup`, `serve`, `restore-client` |
| Optional hot refresh | Off by default; when explicitly enabled, catalog changes notify open Trae windows |

The plugin does not write Trae's SQLite databases, does not modify `storage.json`, and does not sign in, refresh tokens or switch accounts. It only reads the already signed-in Trae session on this machine, in order to call Trae's own model-management API.

---

## 2. Differences from the Trae CN plugin

This is an independent adapter for the international client, not a renamed CN plugin. Both can coexist on the same machine: agent id, configuration directory, port and data directories are all different.

| Dimension | This plugin (Trae International) | Trae CN plugin (reference implementation) |
| --- | --- | --- |
| Target client | Trae International 3.6.20 (checked) | Trae CN 3.4.18 / 3.4.20 (upstream record) |
| Agent id / display name | `trae-intl` / `Trae (International)` | Its own CN agent id |
| Configuration directory | `~/.config/magpie-trae-intl` | `~/.config/magpie-trae` |
| Loopback bridge port | `3499` | `3498` |
| Trae user data | `%APPDATA%/Trae`, `~/.trae` | `%APPDATA%/Trae CN`, `~/.trae-cn` |
| Installation discovery | Uninstall registry + common directories, validating `providerCode=i18n` and `packageType=TRAE_I18N` | Fixed CN install directory and CN identifiers |
| Model API host | International hosts selected by account region (SG / normal / US / USTTP) | CN host |
| Catalog API | International `batch_get_detail_param` response shape; `model_list` only as a diagnostic fallback | CN batch shape with five functions |
| Credential allowlist | Two Trae 3.6.20 DLLs and `out/main.js` hashes | Trae 3.4.18 / 3.4.20 hashes |
| Client hot refresh | **Off by default**, explicit opt-in, reversible | On by default |
| Cancellation-race patch | Not implemented | Optional 3.4.18-only script |

> Do not copy the CN plugin's `managed-models.json`, `connection.json` or `client-backups` into this plugin's configuration directory. The formats and account bindings are not interchangeable.

---

## 3. How it fits together

```text
Magpie host
  │ writes (read-only for this plugin)
  ▼
~/.config/magpie-trae-intl/connection.json
  │
  │  read control file + local Trae session
  ▼
Synchronizer ── HTTPS ──▶ Trae account / model-management API
  │                      /api/ide/v1/{batch_get_detail_param,
  │                      add_custom_model, update_custom_model}
  ▼
Custom models in the Trae account (display names end with " · Magpie",
base_url points to the local bridge)
  │
  │ Trae native client sends chat requests
  ▼
127.0.0.1:3499/v1/chat/completions
  │  checks loopback peer, Host, local marker, model allowlist
  │  replaces Authorization with the Magpie gatewayKey from connection.json
  ▼
Local Magpie gateway → upstream model
```

Three key points:

1. **Model selection stays in Trae.** `connect()` only passes Magpie's model list and capabilities to the host; it does not return a default model or default reasoning level.
2. **The Magpie key never enters Trae's cloud model configuration.** In the default (`native`) mode, Trae's model record only receives a native envelope of the loopback marker; the real `gatewayKey` is written only by the host into `connection.json`, and the bridge sends it only to the local Magpie gateway after reading it into memory.
3. **The account service is authoritative.** The plugin never edits Trae's local database directly. Every write is journaled first, then sent, then verified by reading back.

---

## 4. Installation

### 4.1 Prerequisites

| Item | Requirement |
| --- | --- |
| OS | Windows 10/11 x64 |
| Trae | International **3.6.20**, signed in, model menu works |
| Magpie | 0.1.4596 (baseline), at least one usable model or route group configured |
| Plugin runtime | Magpie's bundled Bun host; no npm runtime dependencies |
| Running the CLI / tests directly | Node.js **20 or newer** |

The plugin reads the Trae installation to confirm the version and DLL hashes. A build outside the allowlist **fails closed**: no models are registered, no key material is derived, and no client file is modified.

### 4.2 Add the plugin

Recommended: install directly from GitHub:

```powershell
magpie plugin add github:not502/magpie-agent-trae-intl
```

Or install from a local clone (useful for development and debugging):

```powershell
cd <repository directory>
magpie plugin add .
```

`magpie plugin add <local directory>` loads the directory in place; nothing is copied into the plugin cache. Moving or deleting the repository breaks the plugin (installing from GitHub does not have this limitation). To confirm the installation record (fields vary by Magpie version):

```powershell
magpie plugin --json
```

Adding, removing, updating or toggling a plugin restarts the Magpie host. If Magpie is running, reopen it when prompted.

### 4.3 Enable it on Magpie's Agent page

1. Open Magpie.
2. Go to the **Agent** page (some versions call it "Agents" or "Connections").
3. Find **Trae (International)** and turn on the connection switch.
4. If the model list is long, expand the "show remaining" area at the bottom before selecting.
5. If the page offers model/route-group selection, confirm the entries you want to expose to Trae; keep Magpie running.

After enabling, the Magpie host writes the gateway address, gateway key and model list to:

```text
~/.config/magpie-trae-intl/connection.json
```

This file is written by Magpie and only read by the plugin. Do not edit it by hand, and do not post its contents to an issue, chat or log: it contains `gatewayKey`.

### 4.4 When to restart Trae the first time

**After enabling the plugin for the first time, fully quit and restart Trae once.** This makes Trae fetch the custom-model list from the account again. Closing the window is not necessarily the same as quitting the process; confirm from the tray/taskbar that Trae has exited.

After that:

| Situation | Restart Trae? |
| --- | --- |
| First time the plugin is enabled | Restart once |
| First time client hot refresh is enabled | Restart once (so the patch loads at startup) |
| Hot refresh is reinstalled after a Trae upgrade | Restart once; an upgrade usually replaces `out/main.js` |
| Models are added/removed in Magpie later | Reload the Trae window; with hot refresh on, the plugin notifies automatically |
| Port or configuration directory changes | Reload the window after the next sync; restart if needed |
| After running `restore-client` | Restart once so the original entry point takes effect |

Catalog synchronization itself does not require restarting Trae; a restart only affects whether Trae re-reads its model list.

### 4.5 Selecting a model in Trae

Open Trae's model menu and choose an entry whose name ends with **` · Magpie`**. For example, a Magpie model named `Example Model` appears as:

```text
Example Model · Magpie
```

Notes:

- Magpie's Agent page shows **Trae (International)**; Trae's model menu shows model entries with the ` · Magpie` suffix. In other words, **Trae (International) is the Magpie-side connection name, not a model-name prefix in Trae's menu**.
- Display names are capped at 64 characters. With a very long model name the suffix can be truncated; confirm the mapping on Magpie's Agent page.
- The model entries are stored in the Trae account, not in the local SQLite cache; how long they persist is up to the Trae account service, until the plugin disconnects/uninstalls and completes the release.

---

## 5. Model capabilities

The plugin reads capability fields from each model entry passed by Magpie and writes them into Trae's custom-model configuration:

| Magpie field | Trae field | Rule |
| --- | --- | --- |
| `context` | `config_detail.model_hyper_params.prompt_max_tokens` | Written only when the value is > 0; 0 or missing means "not declared" |
| `output` | `config_detail.model_hyper_params.max_tokens` | Written only when the value is > 0 |
| `images` | `config_detail.multimodal` | Converted to boolean |
| `efforts` | `thinking_enable` + `reasoning_param` | If at least one level other than `default` remains, `thinking_enable=1` and `reasoning_param = {parameter:"reasoning_effort", values:["default", ...levels]}`; otherwise `0` and no parameter |
| `name` | `display_name` | Appends `" · Magpie"`, truncated to 64 characters |
| `id` | `model_name` | The model identifier in Trae |
| — | `config_detail.max_turn` | Fixed at `500` |

When a chat request passes through the bridge, `stream`, `tools`, image content and `reasoning_effort` are preserved; the bridge forwards no inbound headers and sends only the `gatewayKey` auth header plus the required `content-type`/`content-length`/UA/`accept`. Therefore:

- Image, tool and reasoning support ultimately **depends on the selected upstream model**; the plugin does not invent capabilities.
- Upstream rate limits, insufficient balance, expired plans and parameter errors are returned with their original status/body; the plugin does not rewrite them.
- If Magpie does not provide `context` / `output`, Trae will not show those limits; that does not mean the model has no context.
- If `efforts` contains only `default` or is empty, Trae's reasoning-level declaration is turned off.

---

## 6. Catalog sync and hot refresh

### 6.1 Sync cadence

- The plugin checks `connection.json` every **5 seconds**.
- If the control content is unchanged and less than **60 seconds** have passed since the last check, the tick is skipped to avoid hammering the Trae account API.
- A change (enable, disconnect, model change, port change) triggers a sync.
- On failure, `sync-status.json` becomes `{ "state": "pending", "code": "<code>" }`; later ticks retry. A changed control file usually retries on the next 5-second tick; idle retries remain limited by the 60-second interval.
- Writes always follow: **journal pending → call the cloud → read back and confirm → clear pending and commit**. If a response is lost, the next sync converges from the journal without duplicating creates or deleting the wrong entry.

### 6.2 Hot refresh (optional, off by default)

The Trae installation is not modified by default. **Hot refresh is not required for normal use**; without it, reload the Trae window after catalog changes. Only after an explicit opt-in does the plugin:

1. Verify the SHA-256 of `<Trae install>/resources/app/out/main.js` against the allowlist; if it does not match, stop **before the first write**.
2. Back up the original to `~/.config/magpie-trae-intl/client-backups/<version>/main.original.js`.
3. Copy `src/refresh-notifier.cjs` to `out/magpie-model-refresh.cjs`.
4. Append a dynamic `import()` loader to `out/main.js` (before `//# sourceMappingURL`).
5. The notifier runs in Trae's main process, reads `sync-status.json` every second, and sends Trae's native model-change notification to open windows when the catalog revision changes.

Enable it in either way:

```powershell
# Option 1: write Magpie plugin options, then restart the Magpie host
magpie plugin options <plugin name or directory name> '{"clientRefresh":true}'

# Option 2: set the environment variable before starting Magpie from a terminal
set MAGPIE_TRAE_INTL_CLIENT_REFRESH=1
```

Restart Trae once after enabling. Turning the option back to `false` is not enough to remove the hook: the appended loader remains. Run `restore-client` and restart Trae.

**Why it is off by default:** the 3.6.20 `out/main.js` append was only syntax-checked with `node --check` on a temporary copy; it was never run in a real installation. A failure in this patch does not affect the bridge or catalog sync, and `restore-client` is always available.

---

## 7. Disconnect, uninstall and recovery

### 7.1 Disconnect

1. On Magpie's **Agent** page, turn off the **Trae (International)** connection.
2. Keep Magpie running and wait for the release. Check with `node cli.mjs status`: `sync.models` becomes `0`; `sync.state` is usually `disconnected` (depending on how the host clears `connection.json`). The final check is that the plugin's entries are gone from Trae's menu. If no sync ever ran, there may be no status file.
3. If hot refresh was enabled, run `node cli.mjs restore-client`, then restart Trae.
4. Confirm the plugin's entries are gone from Trae's model menu.

Only models recorded in the journal are touched:

| Entry origin | Behaviour |
| --- | --- |
| Created by the plugin, not edited | Deleted from the Trae account |
| Adopted from the user, not edited | Restored to the configuration captured before adoption (name, URL, status, etc.) |
| Edited by the user later | **Kept**, with `model_edited_in_trae` in `sync-status.json`'s `warnings` |
| No longer present in the cloud | Removed from the journal without error |

### 7.2 Uninstall

**Disconnect first, then uninstall.** Recommended order:

1. Complete 7.1 and confirm the release (`sync.models=0`, entries gone from Trae's menu).
2. If hot refresh was enabled, run `restore-client` and restart Trae.
3. Remove the plugin from Magpie's plugin list (`magpie plugin off <repository directory>` disables it; the removal entry point depends on the Magpie version).
4. Delete `~/.config/magpie-trae-intl` only after you no longer need the recovery journal.

Do not delete the configuration directory before the disconnect completes: `managed-models.json` is the only record for releasing Trae models, and `client-backups/` is the only backup of `out/main.js`.

If the directory is already gone, the plugin cannot automatically delete or restore the models it managed; remove the entries ending with ` · Magpie` manually in Trae's model management.

### 7.3 Exit compensation

When the Magpie host exits, the plugin tries to start a detached `restore.mjs` process. It performs one release only when "the bridge is disconnected + a journal exists". Failure is harmless: the pending journal is retried on the next plugin start.

---

## 8. Diagnostics

Run these from the repository directory (or use the `magpie-trae-intl` bin if it is on `PATH`):

```powershell
node cli.mjs status
node cli.mjs models
node cli.mjs sync
node cli.mjs doctor
node cli.mjs setup
node cli.mjs serve
node cli.mjs restore-client
```

| Command | Purpose | Output | Exit code |
| --- | --- | --- | --- |
| `status` (default command) | Calls `GET http://127.0.0.1:<port>/health` with a 2 s timeout and checks that `name` is `magpie-trae-intl` | Redacted health JSON | 0; 1 when the bridge is offline |
| `models` | Calls `GET /v1/models` with the local loopback marker | Model array (id, name, capability fields) | 0; 1 when offline |
| `sync` | Runs one catalog sync immediately | Whitelisted sync result or `{ "error": "<code>" }` | 0 / 1 |
| `doctor` | Read-only report: product version, install source, region, model API hostname, session booleans, credential availability, catalog strategy, patch state, sync summary | JSON, **no token/key** | 0 / 1 |
| `setup` | Prints installation and first-restart instructions | Text | 0 |
| `serve` | Runs the loopback bridge in the foreground (no synchronizer) | `listening on 127.0.0.1:<port>` | 0 / 1 |
| `restore-client` | Reverts the optional hot-refresh patch | `{state, version, changed, backup, updatedAt}` | 0 / 1 |

Port precedence:

- Plugin entry: Magpie `options.port` > `MAGPIE_TRAE_INTL_PORT` > `3499`
- CLI: `--port <n>` > `MAGPIE_TRAE_INTL_PORT` > `3499`

Useful `status` health fields:

- `connected`: whether `connection.json` exists and matches the contract.
- `sync.state`: `synced` / `disconnected` / `pending` / `unknown`.
- `sync.models`: number of desired models.
- `sync.code`: the last failure's machine code.
- `sync.warnings`: `{model, code}` array, capped at 50.
- `requests` / `lastRequest`: forwarded-request count and the last request summary (model ID, status, streaming, tool count, image count, duration; **no message content**).
- `received` / `lastInbound`: inbound count and last route summary (excluding `/health`).
- `rejected` / `lastRejection`: rejected count and status/machine code.

`doctor`'s `clientRefresh` is only `off`, `installed` or `unsupported`; `sync` shows only state, count and revision. It never prints an absolute installation path, only the source enum (`env` / `registry` / `fallback`).

---

## 9. Port and configuration

| Item | Default | Notes |
| --- | --- | --- |
| Bridge listener | `127.0.0.1:3499` | Loopback only, never exposed to the LAN |
| Configuration directory | `~/.config/magpie-trae-intl` | Fixed; written by the Magpie host at the agent-descriptor path and not overridable by an environment variable |
| Install directory override | Auto-discovery | `MAGPIE_TRAE_INTL_APP` may point at the install directory or `resources/app` |
| Credential mode | `native` | `MAGPIE_TRAE_INTL_CREDENTIAL=plaintext` is for diagnostics only, not daily use (see [`docs/USAGE.md`](docs/USAGE.md) §5.2) |
| Hot refresh | Off | `options.clientRefresh` or `MAGPIE_TRAE_INTL_CLIENT_REFRESH=1` |

After changing the bridge port, models already registered in Trae still carry the old port in `base_url` until the next sync updates them. Reload the Trae window afterwards, and restart if needed. Do not run two copies of this plugin or two Magpie hosts competing for the same port.

---

## 10. Common error codes

Codes appear in `status`'s `sync.code`, `sync-status.json`, the `sync` command output or Magpie's stderr. A reference grouped by stage is in [`docs/USAGE.md`](docs/USAGE.md#9-错误码速查).

| Code | Meaning | First action |
| --- | --- | --- |
| `trae_not_signed_in` | Trae is not signed in, or the auth blob has no token/userId | Sign in to Trae, fully quit and reopen |
| `trae_sign_in_expired` | JWT expired (or `exp` cannot be parsed) | Sign in again; the plugin never refreshes tokens itself |
| `trae_device_unavailable` | No unique device key in the local session | Sign in again; check whether Trae user data was cleared |
| `trae_session_unreadable` | `storage.json` missing, unreadable or not valid JSON | Confirm Trae has completed its first sign-in |
| `trae_codec_unsupported` | Unknown login-blob encoding | Usually a client-version change; do not hand-edit `storage.json` |
| `trae_installation_unavailable` | Trae install, `Trae.exe`, `product.json` or DLL not found | Point `MAGPIE_TRAE_INTL_APP` at the international install |
| `trae_product_not_international` | `product.json` is not the international build (`providerCode` not `i18n`) | Check whether the path points at Trae CN; use the international directory |
| `trae_platform_unsupported` | Not Windows | This plugin supports Windows 10/11 x64 only |
| `trae_credential_version_unsupported` | Trae version not in the DLL allowlist | Use the checked 3.6.20 build; other builds need fresh measurements |
| `trae_credential_build_unsupported` | DLL SHA-256 mismatch | Reinstall the official 3.6.20 build; do not mix modified DLLs |
| `trae_credential_profile_unknown` | DLL marker is not unique or its prefix is incomplete | Build mismatch; fails closed; never guess key material |
| `trae_credential_unavailable` | Cannot derive credentials in `native` mode | Check the install directory and DLL hashes; do not silently fall back to plaintext |
| `trae_credential_cache_unreadable` | Local credential cache cannot be read | Back up and delete `local-credential.json`; the next sync rebuilds it |
| `trae_client_refresh_build_unsupported` | `out/main.js` hash mismatch or version not allowlisted | Do not install hot refresh; bridge and sync still work; use `restore-client` |
| `trae_client_refresh_backup_invalid` | Backup file hash mismatch | Do not overwrite from an unknown backup; reinstall Trae or contact the maintainer |
| `sync_busy` | Another sync process holds the lock | Wait; do not run two Magpie hosts in parallel |
| `sync_status_unavailable` | `/health` cannot read or parse `sync-status.json` | Check write access to the config directory; run a sync |
| `trae_account_changed` | The journal belongs to another Trae account | Sign back into the original account and disconnect; do not reuse the directory across accounts |
| `trae_pending_model_edited` | A pending operation found the entry edited by hand | Restore the entry in Trae, or follow the USAGE emergency pending reset |
| `trae_model_*_unverified` | Read-back after create/update/delete/restore did not confirm | The pending journal is kept and retried; inspect Trae's model list |
| `trae_catalog_unknown` | Unrecognized catalog response shape | Usually a client-version change; run `doctor` first, do not retry in a loop |
| `trae_api_<code\|status>` | Trae API returned a business code or HTTP error | 401/403: check sign-in; 429/5xx: retry later |
| `local_auth_invalid` | The bridge received a wrong loopback marker | Check for mixed CN-plugin configuration; re-sync models |
| `trae_gateway_required` | Magpie did not provide a gateway address or key | Configure the gateway in Magpie and enable the connection again |

`model_edited_in_trae` and `managed_model_removed_in_trae` are **warnings**, not sync failures; they appear in `sync.warnings`.

---

## 11. Privacy and security boundaries

### 11.1 What it reads

| Data | Location | Purpose |
| --- | --- | --- |
| Trae session | `%APPDATA%/Trae/User/globalStorage/storage.json` | Decode the local session to obtain token, userId, deviceId, region and expiry; **used only to call Trae's own model-management API** |
| Client version and host table | `<Trae install>/resources/app/product.json` | Validate the international build, choose the model API region, build headers |
| DLL hashes and embedded material | `<Trae install>/resources/app/modules/ai-agent/{harness,ai_agent}.dll` | Derive the AES-256-GCM envelope key; whole-file hashes must match the allowlist |
| Control file | `~/.config/magpie-trae-intl/connection.json` | Written by Magpie; the bridge reads `gatewayKey` and the model allowlist, the synchronizer reads the model list |

The plugin **does not sign in, refresh tokens, switch accounts or write `storage.json`**, and does not read Trae's SQLite model cache.

### 11.2 Never persisted, printed or sent out

- JWT / refreshToken
- userId, deviceId, e-mail, account information
- A copy of Magpie's `gatewayKey`
- DLL-derived key, salt or AAD
- Plaintext model `ak` / `sk`
- Chat message content

The token stays in memory and is used only for requests to Trae's account API; it is **never sent to Magpie**. The bridge sends `gatewayKey` only to the **local** gateway named in `connection.json`.

`managed-models.json`'s `before` field stores the server-returned `ak` value (normally a native envelope, not the Magpie gateway key); treat that file as sensitive, see §11.4.

### 11.3 Bridge boundary

- Listens on `127.0.0.1` only; non-loopback peers are rejected.
- Any request with an `Origin` header is rejected with 403, blocking browser pages.
- `Host` must be `127.0.0.1` / `localhost` / `[::1]` plus a port, blocking DNS rebinding.
- Requires `Authorization: Bearer <loopback marker>`, either as a native Trae envelope or plaintext (in `plaintext` mode only).
- Only `/v1/models` and `/v1/chat/completions` are allowed; only models in `connection.models` are forwarded.
- No inbound headers are forwarded (cookies, Trae cloud tokens, forwarding chains, etc.); only the `gatewayKey` auth header and the required `content-type`/`content-length`/UA/`accept` are sent upstream.
- The upstream URL must be loopback, its path must be `/v1`, and its port must differ from the bridge port.

The loopback marker (`LOCAL_TOKEN` in `src/constants.mjs`) is a **public constant, not an upstream secret**. The real boundary is loopback-only listening + Origin/Host checks + the model allowlist + sending `gatewayKey` only to the local Magpie gateway. Other processes under the same user can still call the bridge, as with the CN plugin.

### 11.4 What it writes

| File | Content | Sensitive? |
| --- | --- | --- |
| `~/.config/magpie-trae-intl/connection.json` | Host-written `{version,baseURL,gatewayKey,models}` | **Yes**, contains `gatewayKey`; read-only for the plugin |
| `~/.config/magpie-trae-intl/managed-models.json` | Recovery journal: model IDs, pre-adoption configuration, fingerprints, pending | **Yes**, `before` may contain the server-returned encrypted `ak` envelope |
| `~/.config/magpie-trae-intl/local-credential.json` | Loopback marker encrypted with a key derived from the installed client | **Yes**, treat as sensitive; not the Magpie gateway key |
| `~/.config/magpie-trae-intl/sync-status.json` | State, counts, warnings, revision | May contain model IDs; no message content |
| `~/.config/magpie-trae-intl/client-refresh-status.json` | Hot-refresh notification receipt | No |
| `~/.config/magpie-trae-intl/client-backups/<version>/main.original.js` | Original Trae entry point before the optional patch | No, but it is Trae client code; do not redistribute |
| `~/.config/magpie-trae-intl/model-sync.lock` | `{pid,key}` | No |

The configuration directory is created with `0700`, files are written with `0600` (Windows permission semantics depend on the filesystem).

### 11.5 Diagnostic output

- `doctor` prints versions, source enums, region, hostname, booleans and status summaries; no token, userId, deviceId, gatewayKey or model `ak`/`sk`.
- `status` health does not return the full model list, but `lastRequest.model` and `sync.warnings[].model` contain model IDs; these are not chat content.
- `models` prints model IDs and names by design.
- `restore-client` prints the backup file path (inside the local configuration directory); strip it before sharing.
- There is no telemetry. The plugin contacts only the Trae account API and the local Magpie gateway.

**Do not share** `connection.json`, `managed-models.json`, `local-credential.json`, `storage.json` or any log containing tokens/keys. In bug reports, include only versions, error codes and the redacted fields from `doctor`/`status`.

---

## 12. Verification boundary and tests

### 12.1 Checked

| Item | Result |
| --- | --- |
| Target environment | Windows 10/11 x64, Trae International 3.6.20, Magpie 0.1.4596 |
| Static contract | Module signatures, fixed constants, error codes and state-file schemas match `docs/design/interfaces.md` |
| Offline tests | `npm test`: 113 tests passed (run for this review) |
| Syntax check | `npm run check`: 32 files passed `node --check` |
| Privacy scan | `npm run privacy`: 44 files, 15 rules passed (7 test fixtures allowed by policy) |
| Pack whitelist | `npm run pack:check`: `npm pack --dry-run` lists 23 files (runtime + notices); no docs/tests/scripts/state files |
| Real-account acceptance | 2026-11-21: `batch_get_detail_param` 200; `add_custom_model` created and read back identically (AK echoed verbatim, `client_connect:true` set by the server); a second sync wrote nothing; disconnect deleted the model and the read-back confirmed it; the test model was cleaned up and every other account model was untouched |
| Client hashes | 3.6.20 `harness.dll`, `ai_agent.dll` and `out/main.js` hashes were measured read-only on the reference machine; see `src/constants.mjs` |
| Hot-refresh syntax | Appending a dynamic `import()` to `out/main.js` passed `node --check` on a temporary copy (research phase) |

> `docs/design/architecture.md` §13.3 records the 9 checks from the skeleton phase; the table above is a fresh run against the current implementation. They do not conflict; the latter supersedes the former.

### 12.2 Not verified

- End-to-end **chat** is not accepted yet: catalog CRUD is verified against the real account, but "select the model in Trae and send one message" needs the Magpie gateway and a running Trae client and has not been executed.
- **No** optional client patch was run against a real Trae installation; only a temporary-copy syntax check was done.
- **No** validation of other Trae builds, Trae CN, macOS or Linux.
- **No** validation of open questions such as non-empty `sk` or `model_list` GET bodies; they are listed in `docs/design/architecture.md` §14.
- Tests use synthetic DLLs, login blobs, control files and fake keys; they never read real credentials.

### 12.3 Fail-closed behaviour

- Non-Windows: `trae_platform_unsupported`; no models are registered and no key material is derived (macOS/Linux are not supported).
- Version/hash not allowlisted: no model registration, no key derivation, no client edits.
- No unique marker: `trae_credential_profile_unknown`, never guesses.
- Client entry hash mismatch: no hot-refresh write.
- Runtime errors expose whitelisted machine codes only; upstream response bodies and file contents never enter error messages.

---

## 13. Documentation and licence

- [`docs/USAGE.md`](docs/USAGE.md): step-by-step usage, troubleshooting, error-code reference.
- [`docs/design/architecture.md`](docs/design/architecture.md): data flow, state machine, failure modes, verification boundary.
- [`docs/design/interfaces.md`](docs/design/interfaces.md): module signatures, state-file schemas, error-code table.
- [`THIRD_PARTY.md`](THIRD_PARTY.md): origin and changes of `src/vendor/trae-client-codec.mjs`.
- [`ASSET_NOTICE.md`](ASSET_NOTICE.md): `assets/trae.svg` comes from official Trae (International) material, © Trae / ByteDance, used for identification and interoperability purposes only.

Code is under the [MIT License](LICENSE). Trae, Magpie and related names/trademarks belong to their respective owners. This project is an unofficial adapter and implies no official authorization or endorsement.

---

## Development

No npm runtime dependencies are required. Node.js 20+ can run the offline checks:

```powershell
npm test          # node --test "test/**/*.test.mjs"
npm run check     # node --check every project .js/.mjs/.cjs
npm run privacy   # scan for credentials and absolute user paths
npm run pack:check# verify the npm publish whitelist
```

Test fixtures use synthetic data and obvious fake values only; never replace them with a real `storage.json`, real DLL-derived material or a real `gatewayKey`.
