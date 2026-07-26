---
name: add-google
description: One entrypoint to wire Google tools (Gmail, Drive/Docs/Sheets/Slides, Calendar) into agent groups via OneCLI-managed OAuth. Thin orchestrator — asks which services you want, reminds you to connect each OneCLI app, then runs the existing /add-gmail-tool, /add-gcal-tool, and /add-gdrive-tool siblings. No install logic of its own.
---

# Add Google Tools (orchestrator)

This skill is a **convenience wrapper**, not a new integration. It does not install any MCP server or edit the Dockerfile itself — it delegates to three independent sibling skills, each of which remains the single source of truth and removes cleanly:

| Service | Sibling skill | MCP package | OneCLI app(s) |
|---------|---------------|-------------|---------------|
| Gmail (read/search/send/label/draft) | [`/add-gmail-tool`](../add-gmail-tool/SKILL.md) | `@gongrzhe/server-gmail-autoauth-mcp` | `gmail` |
| Calendar (list/search/create events, free/busy) | [`/add-gcal-tool`](../add-gcal-tool/SKILL.md) | `@cocal/google-calendar-mcp` | `google-calendar` |
| Drive + Docs/Sheets/Slides (search, file ops, editing) | [`/add-gdrive-tool`](../add-gdrive-tool/SKILL.md) | `@piotr-agier/google-drive-mcp` | `google-drive` (+ `google-docs`/`google-sheets`/`google-slides` for editing) |

**There is no single "Google token."** OneCLI models each service as a separate OAuth app with its own connection, scopes, and vault secret, routed by host pattern (`gmail.googleapis.com`, `calendar.googleapis.com`, `drive/www.googleapis.com`). So each chosen service still requires its own one-time **Connect** in the OneCLI web UI. This skill just saves you from invoking three skills by hand and keeps the wiring consistent.

**Calendar overlap note:** the Drive package (`@piotr-agier`) also bundles Calendar tools. If a group gets **both** Drive and Calendar, the agent sees two calendar tool surfaces (`mcp__gdrive__*` calendar tools and `mcp__calendar__*`). That's harmless but redundant — prefer enabling Calendar via `/add-gcal-tool` only, and leave the Drive package's calendar tools unused (they 401 silently unless `google-calendar` scopes are also assigned to that secret).

## Phase 1: Decide scope

Ask the user two things:

1. **Which Google services?** Gmail, Calendar, Drive (any combination). Most "set me up with Google" requests want all three.
2. **Which agent groups?** Run `ncl groups list`. Tool surfaces are per-group — don't blanket-enable everything everywhere. Typical: the user's personal DM and CLI agents get the full set; shared/household agents get a subset (often Calendar only).

## Phase 2: Connect OneCLI apps

For each chosen service, confirm the matching OneCLI app is connected. Do this **before** running the sibling skills so their Phase 1 pre-flight checks pass:

```bash
onecli apps get --provider gmail
onecli apps get --provider google-calendar
onecli apps get --provider google-drive
# Optional, only for Drive's Docs/Sheets/Slides editing tools:
onecli apps get --provider google-docs
onecli apps get --provider google-sheets
onecli apps get --provider google-slides
```

Any that report not-connected, tell the user:

> Open the OneCLI web UI at http://127.0.0.1:10254 → Apps → `<service>` → Connect, and sign in with the Google account the agent should act as. You'll do this once per service.

Wait for the user to confirm each chosen service is connected before continuing.

## Phase 3: Run the siblings

Invoke the relevant skills, **once each**, for the chosen services. They share infrastructure cleanly — running them in any order is safe:

- Gmail → run `/add-gmail-tool`
- Calendar → run `/add-gcal-tool`
- Drive → run `/add-gdrive-tool`

Each sibling handles its own stub credentials, Dockerfile ARG + install block, per-group `mcpServers` registration, and mount wiring. They detect prior application and skip already-done steps, so re-running is safe.

**Batch the shared steps.** The siblings each end with a container rebuild + host restart. To avoid doing that 2–3 times, you may run all chosen siblings **up to (but not including) their Phase 4** — i.e. apply every Dockerfile change and every per-group `add-mcp-server` / mount edit first — then do a **single** rebuild + restart at the end:

```bash
./container/build.sh
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

If you instead let each sibling run its own Phase 4, everything still works — it's just slower (redundant rebuilds).

## Phase 4: Verify

Run the verify step from each sibling that was applied. Quick combined smoke test from a wired agent:

> - Gmail: **"list my gmail labels"**
> - Calendar: **"what's on my calendar next Monday?"**
> - Drive: **"search my Google Drive for files named budget"**

First call to each takes 2–3s while the MCP server starts and OneCLI does the token exchange. If one service 401s while others work, the issue is isolated to that service's OneCLI app connection or the agent's secret mode — debug it via that sibling's Phase 5, not here.

## Removal

There is no combined removal — remove per-service via each sibling's **Removal** section (`/add-gmail-tool`, `/add-gcal-tool`, `/add-gdrive-tool`). This is by design: the siblings install and uninstall independently.
