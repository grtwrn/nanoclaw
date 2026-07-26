import { describe, expect, test } from 'bun:test';
import { runScript } from './task-script.js';

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
