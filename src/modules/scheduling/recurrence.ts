/**
 * Sweep hook for recurring tasks.
 *
 * Every sweep tick, find `messages_in` rows that are `completed` AND still
 * have a `recurrence` cron expression. For each, compute the next run via
 * cron-parser, insert a fresh pending row (copying series_id forward), then
 * clear the recurrence on the original so it isn't re-cloned next tick.
 *
 * Called from `src/host-sweep.ts` inside `MODULE-HOOK:scheduling-recurrence`.
 * When scheduling ships inline (current state through PR #7), the hook is a
 * direct dynamic import. When scheduling moves to the modules branch in
 * PR #8, the install skill re-fills the marker on install.
 */
import type Database from 'better-sqlite3';

import { TIMEZONE } from '../../config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { clearRecurrence, getCompletedRecurring, hasLiveSeriesRow, insertRecurrence } from './db.js';

export async function handleRecurrence(inDb: Database.Database, session: Session): Promise<void> {
  const recurring = getCompletedRecurring(inDb);

  // Group completed-recurring rows by series so each series spawns at most one
  // next occurrence per tick. Spawning per-row let a series fork into two
  // independent chains (two completed-with-recurrence rows → two new pending
  // rows), which then double-fired forever — the source of duplicate task/
  // reminder notifications. Processing per-series + the hasLiveSeriesRow guard
  // both prevents new forks and converges any existing fork back to one chain.
  const bySeries = new Map<string, typeof recurring>();
  for (const msg of recurring) {
    const group = bySeries.get(msg.series_id);
    if (group) group.push(msg);
    else bySeries.set(msg.series_id, [msg]);
  }

  for (const [seriesId, group] of bySeries) {
    try {
      // If a live occurrence already exists for this series, a chain is already
      // running — don't spawn another. Just retire the recurrence on the
      // completed rows so they aren't reconsidered next tick.
      if (hasLiveSeriesRow(inDb, seriesId)) {
        for (const msg of group) clearRecurrence(inDb, msg.id);
        log.info('Recurrence already has a live occurrence; skipped spawn', {
          seriesId,
          retired: group.map((m) => m.id),
          sessionId: session.id,
        });
        continue;
      }

      const msg = group[0];
      const { CronExpressionParser } = await import('cron-parser');
      // Interpret the cron expression in the user's timezone. v1 did this
      // (src/v1/task-scheduler.ts:20-49); without it, a task written "0 9 * * *"
      // by an agent running in a user's local TZ fires at 09:00 UTC instead of
      // 09:00 user-local.
      const interval = CronExpressionParser.parse(msg.recurrence, { tz: TIMEZONE });
      const nextRun = interval.next().toISOString();
      const prefix = msg.kind === 'task' ? 'task' : 'msg';
      const newId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      insertRecurrence(inDb, msg, newId, nextRun);
      // Retire recurrence on every completed row in the series, not just the one
      // we spawned from, so a pre-existing fork can't re-spawn on the next tick.
      for (const m of group) clearRecurrence(inDb, m.id);

      log.info('Inserted next recurrence', {
        originalId: msg.id,
        newId,
        seriesId,
        nextRun,
        retired: group.map((m) => m.id),
        sessionId: session.id,
      });
    } catch (err) {
      log.error('Failed to compute next recurrence', {
        seriesId,
        recurrence: group[0]?.recurrence,
        err,
      });
    }
  }
}
