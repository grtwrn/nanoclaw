## Task scheduling (`schedule_task`)

For any recurring task, use `schedule_task`. This is the scheduling path — tasks persist across sessions and restarts, and support the pre-task `script` hook described below.

To inspect or change existing tasks, use `list_tasks` (returns one row per series with the stable id) and `update_task` / `cancel_task` / `pause_task` / `resume_task`. Prefer `update_task` over cancel + reschedule.

Frequent recurring scheduled tasks — more than a few times a day — consume API credits and can risk account restrictions. You can add a `script` that runs first, and you will only be called when the check passes.

### How it works

1. Provide a bash `script` alongside the `prompt` when scheduling
2. When the task fires, the script runs first
3. Script returns: `{ "wakeAgent": true/false, "data": {...} }`
4. If `wakeAgent: false` — nothing happens, task waits for next run
5. If `wakeAgent: true` — claude receives the script's data + prompt and handles

### Script safety rules (mandatory)

A hung script or browser can starve this whole session — user messages queue behind it and can be lost when the container is force-killed. Every task script and task prompt must follow these:

1. **Every `fetch` in a script gets a timeout**: `fetch(url, { signal: AbortSignal.timeout(30000) })`. Wrap the whole script body in try/catch and print `{ "wakeAgent": false }` on any error.
2. **Every `curl` gets `--max-time 30`.**
3. **Recurring tasks must not depend on agent-browser to make forward progress.** If a task uses agent-browser, prefix every invocation with `timeout 120`, give up after ~10 minutes total, and fall back to messaging the user with what they need to finish manually.
4. **Mark work processed before acting on it, not after.** If a task detects an item (email, event) and then acts, record the item as processed (dedupe file, mark-as-read) FIRST — otherwise a failing action re-triggers the task forever.

### Always test your script first

Before scheduling, run the script directly to verify it works:

```bash
bash -c 'node --input-type=module -e "
  try {
    const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\", { signal: AbortSignal.timeout(30000) });
    const prs = await r.json();
    console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
  } catch { console.log(JSON.stringify({ wakeAgent: false })); }
"'
```

### When NOT to use scripts

If a task requires your judgment every time (daily briefings, reminders, reports), skip the script — just use a regular prompt. Do not attempt to do things like sentiment analysis or advanced nlp in scripts.

### Frequent task guidance

If a user wants a task to run more than a few times a day and a script can't be used:

- Explain that each time the task fires it uses API credits and risks rate limits
- Suggest adjusting the task requirements in a way that will allow you to use a script
- If the user needs an LLM to evaluate data, suggest using an API key with direct Anthropic API calls inside the script
- Help the user find the minimum viable frequency
