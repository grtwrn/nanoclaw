---
name: flight-checkin
description: Complete online check-in for a flight on any airline — from a check-in reminder email or a direct user request. Finds the check-in link, completes the flow for all passengers, emails boarding passes, and falls back to notifying the user with the confirmation number if anything blocks. Use when a scheduled task detects a check-in reminder or the user asks to check in for a flight.
allowed-tools: Bash(agent-browser:*), Bash(curl:*), Bash(timeout:*)
---

# Flight Check-in

Completes online check-in for a booked flight via `agent-browser`, on any airline.

## Authorization (read this first)

This skill is only authorized for two agent groups:

- `dm-with-garrett` (Garrett's WhatsApp DM — "claude")
- `whatsapp_eg-assistant` (E+G Assistant)

Your agent group is identified by the `groupName` / `assistantName` in `/workspace/agent/container.json`. If you are not one of the two above, **do not run this skill** — it contains personal passenger details. Tell the user flight check-in is only set up on Garrett's main DM or the E+G Assistant group.

## Passenger details

- Bookings are under last name **Warren** (Garrett) or **Ma** (Emily) — try Warren first, then Ma.
- Always select **all passengers** on the reservation.
- Email boarding passes to **grtwrn@gmail.com** and **emilyma18@yahoo.com.hk** when the airline offers it.

## Safety rules (mandatory — a hung browser can kill this whole session)

1. Prefix **every** `agent-browser` invocation with `timeout 120`.
2. Abandon the check-in attempt entirely after **~10 minutes** total. Fall back to notifying (below). Never retry in a loop.
3. Every `curl` gets `--max-time 30`.
4. **Mark the triggering email processed BEFORE attempting check-in** (see Dedupe below) — otherwise a failed attempt re-triggers the watcher forever.
5. Keep existing seats. **Decline all paid upsells** — bags, seat upgrades, priority boarding, insurance. If the airline *requires* a payment to complete check-in (e.g. a mandatory bag fee), stop and ask the user — never enter payment details autonomously.

## Dedupe (when triggered by the email watcher)

The hourly watcher task passes `emailId` in its script data. FIRST, before opening a browser:

1. Append the `emailId` to `/workspace/agent/.checkin_processed.json` (create as a JSON array if missing).
2. Mark the email read:
   ```bash
   curl --max-time 30 -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/EMAIL_ID/modify" \
     -H "Content-Type: application/json" -d '{"removeLabelIds":["UNREAD"]}'
   ```
3. If the email turns out not to be a real airline check-in reminder (hotel, marketing), stop silently — it is already marked processed.

## Check-in flow

1. Get the confirmation number, airline, flight, and check-in link — from the reminder email body, or by asking the user / checking workspace trip notes (`philippines_trip.md`, calendar) for a direct request.
2. Open the check-in link from the email if present; otherwise the airline's standard online check-in page.
3. Enter confirmation number + last name (Warren, then Ma).
4. Select all passengers, complete every step, keep seats, decline upsells.
5. On the boarding-pass page: email passes to both addresses above. If email isn't offered, screenshot each boarding pass and send the images to the chat.
6. Message the group: airline, flight, route, seats, sequence numbers, and where the passes went.

## Fallback (check-in failed, timed out, or blocked)

Send the group a message with: airline, flight, **confirmation number**, departure time, and the check-in link so a human can finish in under a minute. State plainly what blocked you (e.g. "airline wants a bag fee", "page timed out"). Do not retry.

## Airline notes (grow this as you learn)

- **Avelo**: check-in at `https://checkin.aveloair.com` — confirmation number + last name.
