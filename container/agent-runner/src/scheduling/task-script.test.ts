/**
 * Container leg of the script-failure backoff chain, tested at unit level so
 * the e2e suite doesn't need a live multi-sweep scenario for it:
 *
 *   script error → applyPreTaskScripts skips with reason 'error'
 *   → markScriptSkipped acks `script-skip:error` in outbound.db
 *   (gated → plain 'completed': the monitor working as designed).
 *
 * The host leg (ack → FAILED run → streak backoff) is pinned in
 * src/db/session-db.test.ts and src/modules/scheduling/recurrence.test.ts —
 * both sides pin the literal 'script-skip:error'; if either renames it, its
 * own test goes red.
 */
import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { getPendingMessages, markScriptSkipped } from '../db/messages-in.js';
import { applyPreTaskScripts, runScript } from './task-script.js';

describe('runScript', () => {
  test('parses wakeAgent JSON from a normal script', async () => {
    const result = await runScript(
      `echo '{"wakeAgent": true, "data": {"x": 1}}'`,
      `test-ok-${Date.now()}`,
    );
    expect(result).toEqual({ wakeAgent: true, data: { x: 1 } });
  });

  test('returns null on non-zero exit', async () => {
    const result = await runScript(`exit 3`, `test-exit-${Date.now()}`);
    expect(result).toBeNull();
  });

  // Regression: a grandchild that hangs must not block the poll loop forever.
  // execFile's `timeout` option only signalled bash, which defers signals
  // while a foreground child runs — the promise never resolved and the
  // container starved its heartbeat until the host's 30-min ceiling kill.
  test('kills a hanging grandchild at the timeout', async () => {
    const start = Date.now();
    const result = await runScript(
      // node ignores nothing but never exits on its own; bash would have
      // deferred a bash-only SIGTERM until node exited (never).
      `node -e 'setInterval(() => {}, 1000)'`,
      `test-hang-${Date.now()}`,
      500,
    );
    expect(result).toBeNull();
    expect(Date.now() - start).toBeLessThan(6_000);
  });

  test(
    'SIGKILLs a process tree that traps SIGTERM',
    async () => {
      const start = Date.now();
      const result = await runScript(
        `trap '' TERM\nnode -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'`,
        `test-trap-${Date.now()}`,
        500,
      );
      expect(result).toBeNull();
      // termTimer (0.5s) + kill grace (5s) is the worst case before SIGKILL.
      expect(Date.now() - start).toBeLessThan(12_000);
    },
    { timeout: 20_000 },
  );
});

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertTask(id: string, script: string) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
       VALUES (?, 'task', datetime('now'), 'pending', 1, ?)`,
    )
    .run(id, JSON.stringify({ prompt: 'monitor', script }));
}

const ackStatus = (id: string): string | undefined =>
  (getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as { status: string } | undefined)
    ?.status;

describe('script-skip ack chain (container leg)', () => {
  it('an erroring script skips with reason "error" and acks script-skip:error', async () => {
    insertTask('t-err', 'echo boom >&2; exit 1');
    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());

    expect(keep).toHaveLength(0);
    expect(skipped).toEqual([{ id: 't-err', reason: 'error' }]);

    markScriptSkipped(skipped);
    expect(ackStatus('t-err')).toBe('script-skip:error');
  });

  it('a deliberate wakeAgent=false gate acks plain completed — never backs off', async () => {
    insertTask('t-gated', 'echo \'{"wakeAgent": false}\'');
    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());

    expect(keep).toHaveLength(0);
    expect(skipped).toEqual([{ id: 't-gated', reason: 'gated' }]);

    markScriptSkipped(skipped);
    expect(ackStatus('t-gated')).toBe('completed');
  });

  it('wakeAgent=true keeps the task and enriches the prompt with script data', async () => {
    insertTask('t-wake', 'echo \'{"wakeAgent": true, "data": {"alerts": 2}}\'');
    const { keep, skipped } = await applyPreTaskScripts(getPendingMessages());

    expect(skipped).toHaveLength(0);
    expect(keep).toHaveLength(1);
    expect(JSON.parse(keep[0].content).scriptOutput).toEqual({ alerts: 2 });
  });
});
