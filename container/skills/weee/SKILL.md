---
name: weee
description: Order groceries from Weee! (sayweee.com). Use when the user asks to order groceries, restock, or buy specific items from Weee. Browses, fills cart, and stops at checkout for explicit user confirmation.
allowed-tools: Bash(agent-browser:*), Bash(ncl:*), Bash(timeout:*), Bash(date:*), Read, Write, Edit, mcp__gmail__*, mcp__nanoclaw__send_message, mcp__nanoclaw__send_file
---

# Order from Weee!

Drives sayweee.com via `agent-browser` to add items to the user's cart. The user reviews and confirms before any purchase is placed.

## STOP — the browser gate (check this before anything else)

**Never run an `agent-browser` command against Weee from a chat session. No exceptions, no size threshold.**

Opening the browser takes minutes even for one item, and a chat session that is driving the browser cannot answer anything else — the user's follow-ups queue silently behind it and the chat looks dead.

Before your first `agent-browser` command, answer one question: **was this turn started by a `weee-cart` task prompt?**

- **Yes** → you are the cart run. Take the lock and proceed with the flow below.
- **No** → you are in the chat. Do **not** touch the browser. Resolve the item list with the user first (that part is fine to do in chat — it needs no browser), then hand the run off:

  ```bash
  ncl tasks create --name weee-cart \
    --prompt "weee-cart task. Build the Weee cart using the weee skill. Items: <full resolved list>. Requested by <who> in this group. Report the cart summary and total back to the group when done, or say what you are blocked on." \
    --process-after "$(date -Iseconds)"
  ```

  Then say one line — *"Starting the cart in the background, I'll report back — ask me anything meanwhile"* — and **end your turn.**

This applies to "just add milk" exactly as much as to a full week's list. A one-item run still blocks the chat for minutes, which is the whole problem.

## Authorization

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

Check the snapshot — if you see "Sign In" / "Log In" buttons instead of an account menu, the state is expired or missing. Log in as **Emily** (the account is hers) using the email-first flow below. **Do not attempt Google SSO** — Google blocks automated browsers and the flow will fail.

### First-time login / re-login (email-first, as Emily)

The account belongs to **Emily Ma**. Prefer **email verification** over SMS — announce which route you're taking before you start.

**Step 0 — read the account file first.** `Read /workspace/agent/.weee/account.md`. It records the account email, which inbox codes land in, and the history of what worked. If `Account email` is still `unknown`, you cannot start with the email path: open the sign-in page, choose the email option, and read the **masked** address Weee displays (e.g. `em***@yahoo.com.hk`). That masked hint tells you which inbox the code will reach. Write what you learn back to `account.md` before going further — a login you don't record is one the next session repeats.

1. From the Weee landing page, find and click "Sign In" / "Log In" (`agent-browser find text "Sign In" click`).
2. Pick the **email** option and enter the account email from Step 0.
3. Submit and wait for the code field. The masked address decides the next step:
   - **Code goes to grtwrn@gmail.com** → fetch it yourself with the gmail MCP tools: search for a Weee verification email from the last ~5 minutes, read the 6-digit code, enter it. No human needed — but say in chat that you're doing it ("Code sent to Garrett's Gmail — grabbing it now").
   - **Code goes to an inbox you can't read** (Emily's Yahoo/Yale) → you must ask a human. Send a **plain message** with `send_message`:

     > "Weee sent a login code to em***@yahoo.com.hk — Emily, paste it here and I'll finish logging in."

     Then **end your turn.** Do not poll, do not sleep, do not loop waiting for it. You are woken automatically when they reply, and the code will be in your next batch of messages.

     **Do not use `send_card` or `ask_user_question` for this.** A verification code is free-text input: `send_card` returns immediately without collecting a response, and `ask_user_question` is for picking between fixed options. Asking with the wrong primitive is how this skill previously stalled for 20 minutes.
4. If the email flow breaks in the browser (field won't advance, captcha, no email option offered), fall back to **phone/SMS**: enter the account phone from `account.md`, then ask for the texted code the same way as above — plain message, end your turn. Note the failure in `account.md` so future sessions know email was flaky that day.
5. Type the code, submit, and `agent-browser wait --load networkidle`.
6. Snapshot to confirm you're logged in (account menu visible, no more sign-in CTA).
7. **Save state immediately:**

   ```bash
   agent-browser state save /workspace/agent/weee-auth.json
   ```

8. Confirm to the group that login is saved and you're ready to take orders.

**One-time improvement worth suggesting** (once, not every session): if the account's email turns out to be one no agent can read, suggest that Emily add/switch the Weee account email to `grtwrn@gmail.com` in Weee account settings — then future logins need no human at all. Record the outcome in `/workspace/agent/.weee/account.md`.

If something goes wrong mid-flow (captcha appears, code rejected, page errors), screenshot it (`agent-browser screenshot /workspace/agent/weee-debug.png`), tell the group what you see, and ask how to proceed. Don't retry blindly — Weee rate-limits code sends.

## Handing off to the cart task

The gate at the top of this file decides *whether* you hand off. This section is the detail.

- Resolve the item list **in chat first**, before creating the task. Picking between products needs the user, and a task that has to stop and ask has lost most of the benefit. Ambiguous items are fine to leave for the task only if the user said "you pick".
- `--process-after` needs a real timestamp with an offset — `$(date -Iseconds)` gives one. Natural-language times like `"now"` or `"tomorrow 18:00"` are **rejected** by the parser, despite what `ncl tasks create --help` shows.
- Check the lock before creating a task (below) — never queue a second cart run while one is live.
- Once created, end your turn. The task reports into this group on its own; you stay free for other questions.

### Browser exclusivity (mandatory)

Every session in this agent group shares one workspace, so `weee-auth.json` and the browser profile are shared. Two sessions driving agent-browser at once will clobber each other's login — that is exactly how a session ends up "expired" with a cleared cart mid-run.

**Only one Weee browser run at a time, ever.**

- The run that owns the browser writes `/workspace/agent/.weee/cart-run.lock` containing its task id and an ISO timestamp, and deletes it when finished — including on failure.
- Before any `agent-browser` command against Weee, read that file. If it exists and is newer than 30 minutes, **do not touch the browser**: tell the user a cart run is already in progress and offer to answer something else.
- If it exists but is older than 30 minutes, treat it as stale from a killed run, delete it, and carry on.
- Never start a second cart task while the lock is held. This box has limited RAM — two Chromium containers at once risks the agent being killed mid-run.

## Ordering flow

1. **Load state and open the site** (above).
2. **Find each item** — use the search bar (`agent-browser find placeholder "Search" type "<item>"`, then Enter). Snapshot, identify the right product. If the user specified a brand/size, match it. **If there are multiple plausible matches and the user wasn't specific, do not silently pick — show options and ask.**

   ### How to present options

   Two styles are supported. Pick whichever the user has previously preferred — `weee_choice_style` in `/workspace/agent/.weee/account.md`. If it isn't set yet, **demo both** on the first ambiguous item this session and ask the user which they prefer, then save the answer there for future runs.

   Note there is **no way to screenshot a single element** — `agent-browser screenshot` takes the viewport, and `--full` takes the whole page. There is no `--selector` flag. Crop by scrolling, or use text.

   **Style A — per-product photos.** For each option (cap at 4 to avoid spam), scroll so that product is on screen, then capture the viewport and send it as a photo with a caption:

   ```bash
   agent-browser scroll down 400
   agent-browser screenshot /workspace/agent/weee-opt-1.png
   ```

   Caption: `"Option 1: Kikkoman Soy Sauce, 16oz — $5.49 — https://sayweee.com/product/12345"`. Repeat for options 2-4. Then a final text message: `"Which one?"`.

   **Style B — composite screenshot.** One full-page capture of the search results plus a numbered text caption:

   ```bash
   agent-browser screenshot --full /workspace/agent/weee-opts.png
   ```

   Caption:
   > "1. Kikkoman, 16oz — $5.49 — https://...
   > 2. Pearl River Bridge, 16.9oz — $3.99 — https://...
   > 3. Lee Kum Kee Premium, 16.9oz — $6.99 — https://...
   > Which?"

   Always include direct product links so the user can tap to see ingredients/reviews on Weee. Wait for the user's pick (number or brand name) before clicking Add. Fall back to "cheapest per-unit and note it" only if the user says "you pick" or "doesn't matter."

   When the user picks a style after the demo, save it: set `weee_choice_style: A` (or `B`) in `/workspace/agent/.weee/account.md`. All durable Weee facts live in that one file — don't scatter them into `contacts.md` or `CLAUDE.local.md`.
3. **Add to cart** — click "Add" on the product card. Confirm via snapshot that cart count incremented.
4. **Repeat for each item** the user requested.
5. **Open the cart** — navigate to the cart page. Snapshot.
6. **Summarize back to the user** in chat:
   - Each line item: name, qty, price
   - Subtotal, delivery fee, tax, total
   - Delivery slot if shown
7. **Wait for explicit confirmation** ("yes, place it", "go ahead", etc.). Anything ambiguous → ask again. If the user wants changes, make them and re-summarize.
8. **Only then** click through checkout to the final place-order button. Capture the confirmation page (`agent-browser screenshot /workspace/agent/weee-confirmation.png`) and report the order number.

## When something is unavailable

If an item is out of stock, don't pick a substitute silently. List unavailable items in the cart summary and ask the user how to handle each: skip, substitute (with your suggestion), or wait.

## Don't go silent on a long run

This applies **inside the cart task** — it has its own session, but the user still watches the same chat and still can't tell a working agent from a dead one.

- **Send a short progress message roughly every 5 items or every ~3 minutes**, whichever comes first: "Got through the sauces, working on produce now." One line, no play-by-play.
- If you hit something that will take a while (re-login, a slow page, a search that keeps missing), say so when it happens rather than after.
- If you are blocked on a human (a code, a product choice), send the ask and **end your turn**. Never hold the turn open waiting.
- Release `/workspace/agent/.weee/cart-run.lock` before you finish — on the success path *and* on every failure path.

## Element refs and stale snapshots

Weee is a client-rendered app: refs from `snapshot -i` go stale as soon as the page updates, and there are **no stable CSS class names to rely on** — don't invent selectors. Work semantically:

```bash
agent-browser find placeholder "Search" type "scallions"
agent-browser press Enter
agent-browser wait --load networkidle
agent-browser snapshot -i          # re-snapshot; refs from before Enter are dead
```

Use `agent-browser find role button click --name "Add"` and `find text "..." click` in preference to refs where you can, and re-snapshot after every navigation, search, or cart change. If a ref click fails, re-snapshot rather than retrying the same ref.

Scope a noisy page with `snapshot -s "<selector>"` only if you have confirmed that selector exists on the live page in this session.

## Screenshot hygiene

Debug captures accumulate in the workspace forever — a single bad session left 45 PNGs behind. Reuse a small fixed set of names rather than inventing one per attempt:

- `/workspace/agent/weee-debug.png` — whatever you're currently diagnosing
- `/workspace/agent/weee-cart.png` — cart review
- `/workspace/agent/weee-confirmation.png` — post-order proof (keep this one)

Overwrite freely. Delete `weee-debug.png` and any `weee-opt-*.png` when the run ends.

## Notes

- Weee's product pages can be slow — use `agent-browser wait --load networkidle` after navigation before snapshotting.
- The "Add" button sometimes opens a quantity modal first; check the snapshot rather than assuming a single click is enough.
- Don't use `agent-browser eval` to bypass UI — Weee likely has client-side validation that the cart relies on, and side-stepping it is a good way to end up with a stuck order.
- **Never write an unbounded wait loop.** See the "Waiting for a custom condition" section of the `agent-browser` skill — a bare polling loop wedges the whole agent turn and swallows the user's later messages. Always cap with `timeout` *and* a max-attempts counter.
