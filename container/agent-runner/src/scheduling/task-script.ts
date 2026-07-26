import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MessageInRow } from '../db/messages-in.js';
import { touchHeartbeat } from '../db/connection.js';

const SCRIPT_TIMEOUT_MS = 30_000;
const SCRIPT_KILL_GRACE_MS = 5_000;
const SCRIPT_MAX_BUFFER = 1024 * 1024;

export interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

function log(msg: string): void {
  console.error(`[task-script] ${msg}`);
}

export async function runScript(
  script: string,
  taskId: string,
  timeoutMs: number = SCRIPT_TIMEOUT_MS,
): Promise<ScriptResult | null> {
  const scriptPath = path.join('/tmp', `task-script-${taskId}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    // detached → the script gets its own process group so a timeout can kill
    // the whole tree. execFile's `timeout` option only signals bash itself,
    // and bash defers signals while a foreground child is running — so a
    // grandchild hung on e.g. a fetch with no timeout kept the exit callback
    // from ever firing and blocked the poll loop (heartbeat starvation) until
    // the host's 30-min container ceiling killed the whole session.
    const child = spawn('bash', [scriptPath], { detached: true, env: process.env });

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* process group already gone */
      }
    };

    const finish = (result: ScriptResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      clearTimeout(deadlineTimer);
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* best-effort cleanup */
      }
      resolve(result);
    };

    const termTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
    }, timeoutMs);
    const killTimer = setTimeout(() => killGroup('SIGKILL'), timeoutMs + SCRIPT_KILL_GRACE_MS);
    // Absolute backstop: resolve even if 'close' never fires (e.g. a setsid'd
    // descendant escaped the process group while holding the stdio pipes).
    const deadlineTimer = setTimeout(() => {
      log(`[${taskId}] script did not exit after kill; abandoning`);
      finish(null);
    }, timeoutMs + 2 * SCRIPT_KILL_GRACE_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < SCRIPT_MAX_BUFFER) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < SCRIPT_MAX_BUFFER) stderr += chunk.toString();
    });

    child.on('error', (err) => {
      log(`[${taskId}] spawn error: ${err.message}`);
      finish(null);
    });

    child.on('close', (code) => {
      if (stderr) {
        log(`[${taskId}] stderr: ${stderr.slice(0, 500)}`);
      }

      if (timedOut) {
        log(`[${taskId}] timed out after ${timeoutMs}ms`);
        return finish(null);
      }
      if (code !== 0) {
        log(`[${taskId}] exited with code ${code}`);
        return finish(null);
      }

      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        log(`[${taskId}] no output`);
        return finish(null);
      }

      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') {
          log(`[${taskId}] output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
          return finish(null);
        }
        finish(result as ScriptResult);
      } catch {
        log(`[${taskId}] output is not valid JSON: ${lastLine.slice(0, 200)}`);
        finish(null);
      }
    });
  });
}

/** Why a script gated its task: deliberate wakeAgent=false vs a broken script. */
export type ScriptSkipReason = 'gated' | 'error';

export interface TaskScriptOutcome {
  keep: MessageInRow[];
  skipped: Array<{ id: string; reason: ScriptSkipReason }>;
}

/**
 * Run pre-task scripts for any task messages that carry one, serially.
 * - Errors / missing output / wakeAgent=false → task id added to `skipped`,
 *   with the reason. The caller acks these as script-skips (not plain
 *   completions) so the host can count consecutive failures and back off.
 * - wakeAgent=true → content JSON is mutated to carry `scriptOutput`, so the
 *   formatter renders it into the prompt.
 * Non-task messages and tasks without scripts pass through unchanged.
 */
export async function applyPreTaskScripts(messages: MessageInRow[]): Promise<TaskScriptOutcome> {
  const keep: MessageInRow[] = [];
  const skipped: Array<{ id: string; reason: ScriptSkipReason }> = [];

  for (const msg of messages) {
    if (msg.kind !== 'task') {
      keep.push(msg);
      continue;
    }

    let content: Record<string, unknown>;
    try {
      content = JSON.parse(msg.content);
    } catch {
      keep.push(msg);
      continue;
    }

    const script = typeof content.script === 'string' ? (content.script as string) : null;
    if (!script) {
      keep.push(msg);
      continue;
    }

    log(`running script for task ${msg.id}`);
    touchHeartbeat();
    const result = await runScript(script, msg.id);
    touchHeartbeat();

    if (!result || !result.wakeAgent) {
      const reason: ScriptSkipReason = result ? 'gated' : 'error';
      log(`task ${msg.id} skipped: ${reason === 'gated' ? 'wakeAgent=false' : 'script error/no output'}`);
      skipped.push({ id: msg.id, reason });
      continue;
    }

    log(`task ${msg.id} wakeAgent=true, enriching prompt`);
    content.scriptOutput = result.data ?? null;
    keep.push({ ...msg, content: JSON.stringify(content) });
  }

  return { keep, skipped };
}
