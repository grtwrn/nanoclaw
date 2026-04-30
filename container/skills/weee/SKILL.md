---
name: weee
description: Order groceries from Weee! (sayweee.com). Use when the user asks to order groceries, restock, or buy specific items from Weee. Browses, fills cart, and stops at checkout for explicit user confirmation.
allowed-tools: Bash(agent-browser:*)
---

# Order from Weee!

Drives sayweee.com via `agent-browser` to add items to the user's cart. The user reviews and confirms before any purchase is placed.

## Authorization (read this first)

This skill is only authorized for two agent groups:

- `dm-with-garrett` (Garrett's WhatsApp DM — "claude")
- `whatsapp_eg-assistant` (E+G Assistant)

Your agent group is identified by the `groupName` / `assistantName` in `/workspace/agent/container.json`. If you are not one of the two above, **do not run this skill**. Politely tell the user that grocery ordering is only set up on Garrett's main DM or the E+G Assistant group and suggest they message one of those instead. Do not try to order from another group's auth file or work around this.

(Structural backstop: `weee-auth.json` only exists in the two authorized groups' workspaces, so any unauthorized attempt will fail at `state load` anyway. The rule above exists so you don't waste turns trying.)

**Hard rule: never click the final "Place Order" / "Pay" button without the user explicitly confirming the order in chat first.** Always stop at the cart review screen, summarize what's in the cart and the total, and ask the user to confirm. A typo in a quantity should not become a $400 charge.

## Auth state

Login is held in a Playwright storageState file at `/workspace/agent/weee-auth.json`. This persists across container restarts.

**Each session, before opening Weee:**

```bash
agent-browser state load /workspace/agent/weee-auth.json
agent-browser open https://www.sayweee.com
agent-browser snapshot -i
```

Check the snapshot — if you see "Sign In" / "Log In" buttons instead of an account menu, the state is expired or missing. Walk the user through phone-based login (below). **Do not attempt Google SSO** — Google blocks automated browsers and the flow will fail.

### First-time login / re-login (phone + SMS)

1. From the Weee landing page, find and click "Sign In" / "Log In".
2. Pick the **phone number** option (not Google, not email — phone is the only one that works in agent-browser).
3. Look up the user's phone number in `/workspace/extra/shared/contacts.md` first. If it's set, confirm before submitting: "Send the SMS code to (XXX) XXX-1234?" If the file is missing or the phone field is empty, ask the user, then save it back to that file (it's read-write) so future sessions don't need to ask.
4. Fill the phone field, submit, and wait for the SMS code field to appear.
5. Tell the user: "Sent. What's the code?" — then wait for their next message.
6. Type the code (usually 6 digits), submit, and `agent-browser wait --load networkidle`.
7. Snapshot to confirm you're logged in (account menu visible, no more sign-in CTA).
8. **Save state immediately:**

   ```bash
   agent-browser state save /workspace/agent/weee-auth.json
   ```

9. Confirm to the user that login is saved and you're ready to take orders.

If something goes wrong mid-flow (captcha appears, code rejected, page errors), screenshot it (`agent-browser screenshot /workspace/agent/weee-login-debug.png`), tell the user what you see, and ask how to proceed. Don't retry blindly — Weee rate-limits SMS sends.

## Ordering flow

1. **Load state and open the site** (above).
2. **Find each item** — use the search bar (`agent-browser find placeholder "Search" type "<item>"`, then Enter). Snapshot, identify the right product. If the user specified a brand/size, match it. **If there are multiple plausible matches and the user wasn't specific, do not silently pick — show options and ask.**

   ### How to present options

   Two styles are supported. Pick whichever the user has previously preferred (check `/workspace/extra/shared/contacts.md` or `CLAUDE.local.md` for a `weee_choice_style` note). If neither is set yet, **demo both** on the first ambiguous item this session and ask the user which they prefer, then save the answer for future runs.

   **Style A — per-product photos.** For each option (cap at 4 to avoid spam), screenshot just that product's card and send as a separate photo with a caption:

   ```bash
   agent-browser screenshot --selector ".product-card-1" /workspace/agent/weee-opt-1.png
   ```

   Caption: `"Option 1: Kikkoman Soy Sauce, 16oz — $5.49 — https://sayweee.com/product/12345"`. Repeat for options 2-4. Then a final text message: `"Which one?"`.

   **Style B — composite screenshot.** One screenshot of the whole search-results row plus a numbered text caption:

   ```bash
   agent-browser screenshot --selector ".search-results" /workspace/agent/weee-opts.png
   ```

   Caption:
   > "1. Kikkoman, 16oz — $5.49 — https://...
   > 2. Pearl River Bridge, 16.9oz — $3.99 — https://...
   > 3. Lee Kum Kee Premium, 16.9oz — $6.99 — https://...
   > Which?"

   Always include direct product links so the user can tap to see ingredients/reviews on Weee. Wait for the user's pick (number or brand name) before clicking Add. Fall back to "cheapest per-unit and note it" only if the user says "you pick" or "doesn't matter."

   When the user picks a style after the demo, save it: append a line `weee_choice_style: A` (or `B`) to `/workspace/extra/shared/contacts.md`.
3. **Add to cart** — click "Add" on the product card. Confirm via snapshot that cart count incremented.
4. **Repeat for each item** the user requested.
5. **Open the cart** — navigate to the cart page. Snapshot.
6. **Summarize back to the user** in chat:
   - Each line item: name, qty, price
   - Subtotal, delivery fee, tax, total
   - Delivery slot if shown
7. **Wait for explicit confirmation** ("yes, place it", "go ahead", etc.). Anything ambiguous → ask again. If the user wants changes, make them and re-summarize.
8. **Only then** click through checkout to the final place-order button. Capture the confirmation page (`agent-browser screenshot weee-confirmation.png` saved to `/workspace/agent/`) and report the order number.

## When something is unavailable

If an item is out of stock, don't pick a substitute silently. List unavailable items in the cart summary and ask the user how to handle each: skip, substitute (with your suggestion), or wait.

## Notes

- Weee's product pages can be slow — use `agent-browser wait --load networkidle` after navigation before snapshotting.
- The "Add" button sometimes opens a quantity modal first; check the snapshot rather than assuming a single click is enough.
- Don't use `agent-browser eval` to bypass UI — Weee likely has client-side validation that the cart relies on, and side-stepping it is a good way to end up with a stuck order.
