---
name: shop
description: Order from Shop (shop.app) — Shopify's consumer shopping app. Track deliveries, browse stores, reorder past purchases. Use when the user asks to shop, order, reorder, or check delivery status on Shop.
allowed-tools: Bash(agent-browser:*)
---

# Shop (shop.app)

Drives shop.app via `agent-browser` to browse, reorder, and check deliveries on the user's Shop account. The user reviews and confirms before any purchase is placed.

## Authorization (read this first)

This skill is only authorized for two agent groups:

- `dm-with-garrett` (Garrett's WhatsApp DM — "claude")
- `whatsapp_eg-assistant` (E+G Assistant)

Your agent group is identified by the `groupName` / `assistantName` in `/workspace/agent/container.json`. If you are not one of the two above, **do not run this skill**. Politely tell the user that Shop ordering is only set up on Garrett's main DM or the E+G Assistant group and suggest they message one of those instead.

(Structural backstop: `shop-auth.json` only exists in the two authorized groups' workspaces.)

**Hard rule: never click "Buy now" / "Place order" / "Pay" without the user explicitly confirming the order in chat first.** Always stop at cart/checkout review, summarize line items + total, and ask. A typo doesn't become a charge.

## Browser: use Browserbase, not local Chrome

Shop.app sits behind Cloudflare bot protection, which detects local headless Chromium instantly. **You must connect to Browserbase (a hosted stealth browser service) for this skill — local Chrome will fail at the first page load.**

Use a dedicated session named `shop` so this is fully isolated from any other browser work (e.g. Weee, which uses the default local-Chrome session and must NOT be disturbed).

### Connect at the start of every session

The Browserbase API key lives at `/workspace/extra/.browserbase/token` (one line, no quotes, no trailing newline). If the file is missing, tell the user: "Shop needs a Browserbase API key — drop it at `~/NanoClaw2/.browserbase/token` on the host." Don't try to proceed without it.

```bash
BB_TOKEN=$(cat /workspace/extra/.browserbase/token)
# Create a new Browserbase session and grab its CDP URL:
BB_SESSION=$(curl -sS -X POST https://api.browserbase.com/v1/sessions \
  -H "x-bb-api-key: $BB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}')
BB_CDP=$(echo "$BB_SESSION" | jq -r '.connectUrl')
agent-browser connect "$BB_CDP" --session shop
```

If `connectUrl` is null/empty, the API key is invalid or you're out of free-tier minutes — tell the user and stop.

After that, **every subsequent agent-browser command for this skill MUST include `--session shop`**:

```bash
agent-browser state load /workspace/agent/shop-auth.json --session shop
agent-browser open https://shop.app --session shop
agent-browser snapshot -i --session shop
```

(If you forget the flag, you'll fall back to the default local Chrome and Cloudflare will block you.)

## Auth state

Login is held in a Playwright storageState file at `/workspace/agent/shop-auth.json`. Persists across container restarts.

If you see "Sign In" / "Continue" instead of an account avatar, the state is missing or expired. Walk through login (below).

### First-time login / re-login

Shop offers email-based and phone-based login. **Prefer email** — you have Gmail MCP, so you can fetch the code yourself and the user doesn't have to copy anything. Only fall back to SMS if email fails.

**Do NOT attempt passkey/WebAuthn login** — it will not work in headless Chromium and will burn auth attempts.

#### Email flow (preferred — hands-off)

1. From shop.app, click "Sign in" / "Continue with email".
2. Look up the user's email in `/workspace/extra/shared/contacts.md`. Confirm before submitting if unsure.
3. Fill the email field, submit. Shop sends a 6-digit code (or magic link) to the inbox.
4. Wait ~10 seconds, then use the Gmail MCP to search for the most recent message from `shop.app` or `noreply@shop.app`:

   ```
   ToolSearch query: select:mcp__claude_ai_Gmail__search_threads
   Then call it with q: "from:shop.app newer_than:1h"
   ```

5. Read the message body, extract the code (usually a 6-digit number) or the magic-link URL.
6. If it's a code: type it into the code input. If it's a magic link: `agent-browser open <link>`.
7. `agent-browser wait --load networkidle`, then snapshot to confirm logged in.
8. **Save state immediately:**

   ```bash
   agent-browser state save /workspace/agent/shop-auth.json
   ```

9. Confirm to the user: "Logged into Shop and saved."

#### Phone flow (fallback)

Same shape as the Weee skill: pick "Continue with phone," fill number from `contacts.md`, ask the user for the SMS code, type it, save state.

If something fails (captcha, code rejected, page errors), screenshot to `/workspace/agent/shop-login-debug.png`, tell the user what you see, ask how to proceed. Don't retry blindly — Shop rate-limits.

## Common tasks

### Track a delivery

1. Load state, open shop.app.
2. Navigate to "Orders" or "Deliveries" (snapshot to find the link).
3. Find the order in question. Report status, expected delivery date, last tracking event.

### Reorder a past purchase

1. Load state, open shop.app, go to order history.
2. Find the order/item the user mentioned.
3. Click "Buy again" or equivalent. This usually adds to a cart on the merchant's site (Shop is an aggregator, not the seller).
4. Follow the checkout flow on the merchant site, summarize cart + total, **wait for explicit confirmation** before placing the order.

### Browse / search

1. Use the search bar. If multiple plausible options and the user wasn't specific, **ask** — don't silently pick. Send screenshots or links so the user can choose.

## Notes

- Shop is an aggregator. Many "purchases" actually happen on the underlying merchant's site (which Shop opens or embeds). Auth state for shop.app does *not* transfer to those sites — separate logins may be needed there.
- Pages can be slow — use `agent-browser wait --load networkidle` after navigation.
- Don't use `agent-browser eval` to bypass UI — Shop has client-side checks that the cart relies on.
