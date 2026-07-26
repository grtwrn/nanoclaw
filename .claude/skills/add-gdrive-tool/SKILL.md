---
name: add-gdrive-tool
description: Add Google Drive as an MCP tool (search, read, list folders, create/upload/move/copy/delete files, plus Docs/Sheets/Slides editing) using OneCLI-managed OAuth. Mirrors /add-gmail-tool and /add-gcal-tool's stub pattern — no raw credentials ever reach the container; OneCLI injects real tokens at request time.
---

# Add Google Drive Tool (OneCLI-native)

This skill wires [`@piotr-agier/google-drive-mcp`](https://github.com/piotr-agier/google-drive-mcp) into selected agent groups. The MCP server reads stub credentials containing the `onecli-managed` placeholder; the OneCLI gateway intercepts outbound calls to `www.googleapis.com` / `drive.googleapis.com` (and `docs/sheets/slides.googleapis.com` for Workspace editing) and swaps the bearer for the real OAuth token from its vault.

**Why this package:** dylancaponi's and felores' Drive forks are GitHub-clone-only (not on npm), which breaks the pinned `pnpm install -g` requirement that every agent-runner CLI must satisfy (CLAUDE.md). `@piotr-agier/google-drive-mcp` is published to npm, actively maintained, and — crucially — uses the exact same two-file env-var pattern as `/add-gcal-tool`: `GOOGLE_DRIVE_OAUTH_CREDENTIALS` (OAuth keys) + `GOOGLE_DRIVE_MCP_TOKEN_PATH` (saved token). It's built on `google-auth-library@9` (same as cocal calendar), so the far-future-expiry stub is trusted without any interactive auth.

Tools exposed (surfaced as `mcp__gdrive__<name>`, exact set depends on version — run `tools/list` against the MCP server to enumerate): Drive file ops (search, read, list folders, create/rename/move/copy/delete/upload/download, export-to-PDF), plus Google Docs / Sheets / Slides editing and (optionally) Calendar tools. **Docs/Sheets/Slides editing tools additionally require the matching OneCLI app connected — see Phase 1.**

**Why this pattern:** v2's invariant is that containers never receive raw API keys (CHANGELOG 2.0.0). Same stub pattern `/add-gmail-tool` and `/add-gcal-tool` use. This skill is deliberately a sibling, not a combined "Google Workspace" skill — installs independently and removes cleanly.

## Phase 1: Pre-flight

### Verify OneCLI has Google Drive connected

```bash
onecli apps get --provider google-drive
```

Expected: `"connection": { "status": "connected" }` with scopes including `drive` / `drive.file` (and `drive.readonly`).

If not connected, tell the user:

> Open the OneCLI web UI at http://127.0.0.1:10254, go to Apps → Google Drive, and click Connect. Sign in with the Google account the agent should act as. `drive.file` (per-file access) is the safest useful scope; `drive` grants full read/write.

**Optional — Workspace editing.** The Docs/Sheets/Slides tools hit `docs.googleapis.com`, `sheets.googleapis.com`, and `slides.googleapis.com` respectively. For those tools to authorize, also connect the matching OneCLI apps (`google-docs`, `google-sheets`, `google-slides`). If the user only wants plain Drive file management, skip this — the Drive tools work with just the `google-drive` app, and the Workspace tools will simply 401 until their apps are connected.

### Verify stub credentials exist

The stub lives at `~/.gdrive-mcp/` by convention (sibling of `/add-gmail-tool`'s `~/.gmail-mcp` and `/add-gcal-tool`'s `~/.calendar-mcp`). piotr-agier defaults to `~/.config/google-drive-mcp/tokens.json` — we override via env vars below so it reads our stubs instead.

```bash
ls -la ~/.gdrive-mcp/gcp-oauth.keys.json ~/.gdrive-mcp/credentials.json 2>&1
```

If both exist with `onecli-managed`:

```bash
grep -l onecli-managed ~/.gdrive-mcp/gcp-oauth.keys.json ~/.gdrive-mcp/credentials.json
```

...skip to Phase 2. If either file has real credentials (no `onecli-managed`), **STOP** — back up and delete before proceeding.

If absent, write them:

```bash
mkdir -p ~/.gdrive-mcp
cat > ~/.gdrive-mcp/gcp-oauth.keys.json <<'EOF'
{
  "installed": {
    "client_id": "onecli-managed.apps.googleusercontent.com",
    "client_secret": "onecli-managed",
    "redirect_uris": ["http://localhost:3000/oauth2callback"]
  }
}
EOF
cat > ~/.gdrive-mcp/credentials.json <<'EOF'
{
  "access_token": "onecli-managed",
  "refresh_token": "onecli-managed",
  "token_type": "Bearer",
  "expiry_date": 99999999999999,
  "scope": "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/presentations"
}
EOF
chmod 600 ~/.gdrive-mcp/*.json
```

**Why the far-future `expiry_date`:** the server's auth check is `isExpired = Date.now() >= expiry_date - 5min`. With `99999999999999` it's never expired, so the server skips both interactive auth and token refresh — it just sends `Authorization: Bearer onecli-managed`, which OneCLI rewrites in flight. This is the identical mechanism `/add-gmail-tool` and `/add-gcal-tool` rely on. The `scope` string is cosmetic for routing but list the Drive (+ Docs/Sheets/Slides) scopes so any scope-gating in the server is satisfied.

### Verify mount allowlist covers the path

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

`~/.gdrive-mcp` must sit under an `allowedRoots` entry (e.g. `/home/<user>`). If it doesn't, tell the user to run `/manage-mounts` first.

### Check agent secret-mode

For each target agent group, confirm OneCLI will inject the Google Drive token:

```bash
onecli agents list
```

If that agent's `secretMode` is `all`, you're done — the Drive secret (and any Docs/Sheets/Slides secrets) auto-inject by host pattern. If it's `selective`, explicitly assign the relevant secrets using the safe merge pattern (`set-secrets` replaces the entire list — always read first):

```bash
DRIVE_IDS=$(onecli secrets list | jq -r '[.data[] | select(.name | test("(?i)drive|docs|sheets|slides")) | .id] | join(",")')
CURRENT=$(onecli agents secrets --id <agent-id> | jq -r '[.data[]] | join(",")')
MERGED=$(printf '%s' "$CURRENT,$DRIVE_IDS" | tr ',' '\n' | sort -u | paste -sd ',' -)
onecli agents set-secrets --id <agent-id> --secret-ids "$MERGED"
onecli agents secrets --id <agent-id>
```

## Phase 2: Apply Code Changes

### Check if already applied

```bash
grep -q 'GDRIVE_MCP_VERSION' container/Dockerfile && \
echo "ALREADY APPLIED — skip to Phase 3"
```

### Add MCP server to Dockerfile

Edit `container/Dockerfile`. Find the pinned-version ARG block and add:

```dockerfile
ARG GDRIVE_MCP_VERSION=2.2.0
```

`@piotr-agier/google-drive-mcp` declares `zod@^3.25.76` and has no `zod-to-json-schema` dependency, so it needs **no version pin** (unlike gmail-mcp). Add a standalone install block after the last pnpm global-install `RUN`, before `# ---- Entrypoint`:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@piotr-agier/google-drive-mcp@${GDRIVE_MCP_VERSION}"
```

If you'd rather share the existing gmail/calendar install block, just append `"@piotr-agier/google-drive-mcp@${GDRIVE_MCP_VERSION}"` to it — the `zod-to-json-schema@3.22.5` pin that block carries for gmail is harmless to Drive (Drive doesn't import it).

Pinned version matters — `minimumReleaseAge` in `pnpm-workspace.yaml` gates trunk installs, and CLAUDE.md requires a fixed ARG version for all Node CLIs installed into the image.

**No `TOOL_ALLOWLIST` edit needed.** `container/agent-runner/src/providers/claude.ts` derives the allow-pattern dynamically from each group's `mcpServers` map (`Object.keys(this.mcpServers).map(mcpAllowPattern)`), so registering `gdrive` in Phase 3 automatically allows `mcp__gdrive__*`.

### Rebuild the container image

```bash
./container/build.sh
```

## Phase 3: Wire Per-Agent-Group

For each agent group, persist two changes to the **central DB** (`data/v2.db`): the `mcpServers.gdrive` entry and an `additionalMounts` entry for `.gdrive-mcp`. Both flow through `materializeContainerJson` on every spawn, so editing `groups/<folder>/container.json` by hand does **not** stick — that file is regenerated from the DB.

### Register the MCP server

For each chosen `<group-id>` (use `ncl groups list` to enumerate):

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name gdrive \
  --command google-drive-mcp \
  --args '[]' \
  --env '{"GOOGLE_DRIVE_OAUTH_CREDENTIALS":"/workspace/extra/.gdrive-mcp/gcp-oauth.keys.json","GOOGLE_DRIVE_MCP_TOKEN_PATH":"/workspace/extra/.gdrive-mcp/credentials.json"}'
```

Approval behaviour depends on where you run it: from inside an agent's container `ncl` write verbs are approval-gated (admin approves before it lands); from a host operator shell with full scope, it executes immediately. Either way, the response tells you which path it took.

### Add the `.gdrive-mcp` mount

There is no `ncl groups config add-mount` verb yet (tracked in [#2395](https://github.com/nanocoai/nanoclaw/issues/2395)). Until that ships, edit the DB directly via the in-tree wrapper (`scripts/q.ts` — `setup/verify.ts:5` codifies that NanoClaw avoids depending on the `sqlite3` CLI binary, so don't shell out to it):

```bash
GROUP_ID='<group-id>'
HOST_PATH="$HOME/.gdrive-mcp"
MOUNT=$(jq -cn --arg h "$HOST_PATH" '{hostPath:$h, containerPath:".gdrive-mcp", readonly:false}')
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
  SET additional_mounts = json_insert(additional_mounts, '\$[#]', json('$MOUNT')), \
      updated_at = datetime('now') \
  WHERE agent_group_id = '$GROUP_ID';"
```

Run from your NanoClaw project root (where `data/v2.db` lives). The `$[#]` placeholder is SQLite JSON1's append-to-end notation; it's `\$`-escaped so bash doesn't arithmetic-expand it before sqlite sees it. `updated_at` is ISO-string everywhere else in the schema, so use `datetime('now')` — not `strftime('%s','now')`, which would silently mix epoch ints into a column of YYYY-MM-DD HH:MM:SS strings.

**Switch to `ncl groups config add-mount` once #2395 lands.** Update this skill at that time.

`containerPath` is relative (mount-security rejects absolute paths — additional mounts land at `/workspace/extra/<relative>`). The MCP server's env vars point at that absolute location inside the container.

**Why this can't be `groups/<folder>/container.json`:** post-migration `014-container-configs`, `materializeContainerJson` in `src/container-config.ts` rewrites that file from the DB on every spawn. Anything hand-edited there is silently overwritten on next restart.

**Same-group-as-gmail/gcal tip:** if this group already has the gmail or calendar MCP + mounts, all coexist — `ncl groups config add-mcp-server` only updates the named entry, and `json_insert` appends to `additional_mounts` without disturbing existing entries.

## Phase 4: Build and Restart

```bash
pnpm run build
```

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

Kill any existing agent containers so they respawn with the new mcpServers config:

```bash
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

## Phase 5: Verify

### Test from a wired agent

> Send: **"search my Google Drive for files named budget"** or **"list the files in my Drive root folder"**.
>
> First call takes 2–3s while the MCP server starts and OneCLI does the token exchange.

### Check logs if the tool isn't working

```bash
tail -100 logs/nanoclaw.log | grep -iE 'gdrive|drive|mcp'
```

Common signals:
- `command not found: google-drive-mcp` → image not rebuilt.
- `ENOENT ...credentials.json` → mount missing. Check the mount allowlist.
- Server logs `No access or refresh token available` or tries to open a browser → the token stub isn't being read; confirm `GOOGLE_DRIVE_MCP_TOKEN_PATH` points at the mounted `credentials.json` and that `expiry_date` is the far-future value.
- `401 Unauthorized` from `www.googleapis.com` / `drive.googleapis.com` → OneCLI isn't injecting; verify the agent's secret mode and that Google Drive is connected.
- `401` only on Docs/Sheets/Slides tools (Drive tools work) → the matching OneCLI app (`google-docs` / `google-sheets` / `google-slides`) isn't connected. Connect it in the web UI or stick to plain Drive tools.
- Agent says "I don't have Drive tools" → the `gdrive` MCP server isn't registered in this group's `mcpServers` (re-run the Phase 3 `add-mcp-server` step and restart it), or the agent-runner image is stale (`./container/build.sh`, `--no-cache` if suspicious).

## Removal

1. For each group that had Drive wired, remove the MCP server from the DB:
   ```bash
   ncl groups config remove-mcp-server --id <group-id> --name gdrive
   ```
2. Remove the `.gdrive-mcp` mount from the DB (no `remove-mount` verb yet — same #2395 dependency):
   ```bash
   pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
     SET additional_mounts = (SELECT json_group_array(value) FROM json_each(additional_mounts) \
                              WHERE json_extract(value, '\$.containerPath') != '.gdrive-mcp'), \
         updated_at = datetime('now') \
     WHERE agent_group_id = '<group-id>';"
   ```
3. Remove `GDRIVE_MCP_VERSION` ARG and the `@piotr-agier/google-drive-mcp` package from the Dockerfile install block.
4. `pnpm run build && ./container/build.sh && systemctl --user restart "$(. setup/lib/install-slug.sh && systemd_unit)"`.
5. Optional: `rm -rf ~/.gdrive-mcp/` and `onecli apps disconnect --provider google-drive`.

No `TOOL_ALLOWLIST` removal step — Phase 2 no longer edits it.

## Credits & references

- **MCP server:** [`@piotr-agier/google-drive-mcp`](https://github.com/piotr-agier/google-drive-mcp) — published to npm, actively maintained, Drive + Docs + Sheets + Slides + Calendar with OAuth auto-refresh.
- **Why not dylancaponi/felores:** both are maintained forks of Anthropic's archived `@modelcontextprotocol/server-gdrive`, but neither is published to npm (clone-and-build only), which fails the pinned `pnpm install -g` requirement for agent-runner CLIs.
- **Skill pattern:** direct sibling of [`/add-gmail-tool`](../add-gmail-tool/SKILL.md) and [`/add-gcal-tool`](../add-gcal-tool/SKILL.md); same OneCLI stub mechanism.
