---
name: shop-hyperbrowser
description: Order from Shop (shop.app) using Hyperbrowser as the stealth browser provider. PRIMARY skill for Shop ordering — try this first. Native Cloudflare Turnstile + CAPTCHA solving. If Hyperbrowser fails or its key is missing, fall back to the `shop` skill (Browserbase).
allowed-tools: Bash(agent-browser:*), Bash(curl:*), Bash(jq:*)
---

# Shop via Hyperbrowser

Drives sayweee.com — wait, **shop.app** — via `agent-browser` connected to a Hyperbrowser remote Chrome session with native Cloudflare Turnstile + CAPTCHA solving. This is the **primary** skill for Shop ordering. The older `shop` skill (using Browserbase) is the fallback.

## Authorization (read this first)

Authorized for:

- `dm-with-garrett` (Garrett's WhatsApp DM — "claude")
- `whatsapp_eg-assistant` (E+G Assistant)

If you're not in one of those groups, decline and redirect.

## Hard rule

**Never click "Buy now" / "Place order" / "Pay" without explicit user confirmation in chat first.** Always stop at cart review, summarize line items + total, ask. A typo doesn't become a charge.

## Browser: Hyperbrowser session

The Hyperbrowser API key lives at `/workspace/extra/.hyperbrowser/token` (one line, no quotes). If missing, **fall back to the `shop` skill** (which uses Browserbase) — don't try to proceed without it.

Use a dedicated session named `shop-hb` so this is isolated from any other browser work.

### Connect at the start of every session

```bash
HB_TOKEN=$(cat /workspace/extra/.hyperbrowser/token)

# Create a new session with stealth + CAPTCHA-solving enabled.
# NOTE: If this exact endpoint URL doesn't work on first try, check the
# current docs at https://docs.hyperbrowser.ai/ — Hyperbrowser has rotated
# their API base in the past. The shape of the request stays the same.
HB_RESP=$(curl -sS -X POST https://app.hyperbrowser.ai/api/v2/sessions \
  -H "x-api-key: $HB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"useStealth": true, "solveCaptchas": true}')

# Response includes wsEndpoint (the CDP URL Playwright/agent-browser connects to).
HB_WS=$(echo "$HB_RESP" | jq -r '.wsEndpoint // .data.wsEndpoint // empty')

if [ -z "$HB_WS" ]; then
  echo "Hyperbrowser session create failed:"
  echo "$HB_RESP" | head -20
  # Tell the user the API call failed (auth? endpoint?). Suggest fallback to shop skill.
  exit 1
fi

agent-browser connect "$HB_WS" --session shop-hb
```

If the create call returns a 401/403, the API key is bad — tell the user. If it returns something other than a recognizable success, paste the response to the user (sanitize the token first) and **fall back to the `shop` skill**.

### Every subsequent agent-browser command MUST include `--session shop-hb`

```bash
agent-browser state load /workspace/agent/shop-hb-auth.json --session shop-hb
agent-browser open https://shop.app --session shop-hb
agent-browser snapshot -i --session shop-hb
```

If you forget the flag, you fall back to the default local Chrome and Cloudflare blocks you immediately.

## Auth state

Login state lives at `/workspace/agent/shop-hb-auth.json` (separate from the Browserbase fallback's `shop-auth.json` — they may end up in different account states; keep them separate).

If state is missing/expired, walk through email login:

1. Click "Continue with email" on shop.app.
2. Look up user's email in `/workspace/extra/shared/contacts.md` (Garrett's is `grtwrn@gmail.com`).
3. Submit. Wait ~10 seconds.
4. Use Gmail MCP (`mcp__gmail__search_threads` or similar) to find the most recent message from `shop.app` or `noreply@shop.app`. Extract the 6-digit code.
5. Type the code, submit, `agent-browser wait --load networkidle --session shop-hb`.
6. Snapshot to confirm logged in.
7. **Save state immediately:** `agent-browser state save /workspace/agent/shop-hb-auth.json --session shop-hb`

**Do NOT attempt passkey/WebAuthn** — fails on remote Chrome anyway.

## Common tasks

### Track a delivery

Load state, open shop.app, navigate to "Orders" / "Deliveries", find the order, report status + ETA.

### Browse / search

If multiple plausible matches and the user wasn't specific, ask — don't silently pick. Send screenshots or product links so the user can choose.

### Place an order (the actual reason this skill exists)

Walk through the merchant's checkout (Shop is an aggregator — many "buy" actions redirect to the merchant's actual site). At the final review, summarize and **wait for explicit user confirmation** before clicking the place-order button.

## Cleanup

Hyperbrowser sessions cost money per minute they're alive. When done with the order, close the session:

```bash
agent-browser close --session shop-hb
# Optional explicit terminate via API if the close didn't:
# curl -sS -X POST https://app.hyperbrowser.ai/api/v2/sessions/$SESSION_ID/stop -H "x-api-key: $HB_TOKEN"
```

## When this skill fails

If the Hyperbrowser session create fails, or stealth doesn't pass the Cloudflare check, or you're rate-limited, **call out the failure and try the fallback `shop` skill** (which uses Browserbase). Do not retry Hyperbrowser more than twice in one turn — costs add up.

## Notes

- Hyperbrowser pay-per-minute pricing means closing sessions when done matters. Don't leave them dangling.
- `useStealth: true` is the basic stealth tier. `useUltraStealth: true` exists but requires enterprise plan — don't try.
- Pages can be slow — use `agent-browser wait --load networkidle --session shop-hb` after navigation.
