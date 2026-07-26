## Task scheduling (`ncl tasks`)

Use `ncl tasks` for one-shot and recurring tasks. Each task runs in its own isolated session. Its runtime prompt supplies the task-only delivery and run-log contract.

Pass `--name "<short label>"` on create to get a readable task id (e.g. `--name "sales briefing"` → `sales-briefing-a25c`); without it ids are `t-<hex>`.

Common commands:

```bash
ncl tasks create --name "ping" --prompt "Remind the user to call Dana" --process-after "tomorrow 18:00"
ncl tasks list
ncl tasks get ping-a25c        # includes run count, failures, and recent run-log lines
ncl tasks run ping-a25c         # fire once now without changing the schedule (testing)
ncl tasks update ping-a25c --prompt "New instructions"
ncl tasks pause ping-a25c
ncl tasks resume ping-a25c
ncl tasks cancel ping-a25c      # or --all as a kill switch
ncl tasks delete ping-a25c
```

Use good judgement on whether it's appropriate to check in with the user about the task prompt before task creation, and if so, whether to share verbatim or a description of it.

`--process-after` accepts UTC timestamps or naive local timestamps interpreted in the instance timezone (shown in the `<context timezone="..."/>` header).

Run `ncl tasks create --help` for schedules, options, and pre-task gate scripts (checks that run before you wake).

### Script safety rules (mandatory)

A hung gate script or browser can starve this whole session — user messages queue behind it and can be lost when the container is force-killed. Every task script and task prompt must follow these:

1. **Every `fetch` in a script gets a timeout**: `fetch(url, { signal: AbortSignal.timeout(30000) })`. Wrap the whole script body in try/catch and print `{ "wakeAgent": false }` on any error.
2. **Every `curl` gets `--max-time 30`.**
3. **Recurring tasks must not depend on agent-browser to make forward progress.** If a task uses agent-browser, prefix every invocation with `timeout 120`, give up after ~10 minutes total, and fall back to messaging the user with what they need to finish manually.
4. **Mark work processed before acting on it, not after.** If a task detects an item (email, event) and then acts, record the item as processed (dedupe file, mark-as-read) FIRST — otherwise a failing action re-triggers the task forever.
5. **Test the script directly in your sandbox before scheduling it.**
