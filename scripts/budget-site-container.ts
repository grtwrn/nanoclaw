/**
 * Dedicated always-on budget site container.
 *
 * Serves groups/budget/budget-server (the budget agent's own workspace) on
 * host port 3456, 24/7 — decoupled from the ephemeral budget agent container,
 * which spawns per-task and dies when idle. The budget agent edits the files;
 * this container serves them live.
 *
 * Reuses the OneCLI "budget" agent identity (secretMode: all), so the server's
 * `Authorization: Bearer onecli-managed` YNAB calls get the real token injected
 * by the OneCLI proxy — exactly like an agent container. The proxy env + CA
 * cert are applied via the same `onecli.applyContainerConfig()` path the host
 * uses in src/container-runner.ts.
 *
 * Run:   pnpm exec tsx scripts/budget-site-container.ts
 *
 * The container uses `--restart unless-stopped`, so it survives reboots as long
 * as the docker daemon starts on boot. Re-run this script to recreate it after
 * the agent image changes or if the OneCLI proxy token rotates. Static files in
 * public/ are served live (no restart needed); server.mjs changes require
 * `docker restart nanoclaw-budget-site`.
 */
import { execFileSync } from 'child_process';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { CONTAINER_IMAGE, GROUPS_DIR, ONECLI_API_KEY, ONECLI_URL, TIMEZONE } from '../src/config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs } from '../src/container-runtime.js';

const CONTAINER_NAME = 'nanoclaw-budget-site';
const AGENT_IDENTIFIER = 'ag-1781708761996-7v65g7'; // budget agent group id
// Mount the whole group dir so the backend can read budget_config.json and
// persist the email-derived ledger under groups/budget/data/.
const SITE_DIR = path.join(GROUPS_DIR, 'budget');
const PORT = '3456';

async function main(): Promise<void> {
  const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

  // Idempotent — the OneCLI "budget" agent already exists; this is a no-op safety net.
  await onecli.ensureAgent({ name: 'budget', identifier: AGENT_IDENTIFIER });

  // Remove any prior instance so this script is rerunnable.
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', CONTAINER_NAME], { stdio: 'pipe' });
  } catch {
    /* nothing to remove */
  }

  const args: string[] = ['run', '-d', '--restart', 'unless-stopped', '--name', CONTAINER_NAME];
  args.push('-e', `TZ=${TIMEZONE}`);
  // Placeholder so flyctl-style tools don't bail; OneCLI proxy substitutes real auth per host pattern.
  args.push('-e', 'FLY_API_TOKEN=onecli-managed');

  // OneCLI proxy + CA cert — identical wiring to agent containers (container-runner.ts).
  const applied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: AGENT_IDENTIFIER });
  if (!applied) throw new Error('OneCLI gateway not applied — refusing to launch budget site container');

  // host.docker.internal mapping (the proxy URL targets it).
  args.push(...hostGatewayArgs());

  // Match host uid/gid so the mounted workspace is readable (mirrors container-runner.ts).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  args.push('-p', `${PORT}:${PORT}`);
  args.push('-v', `${SITE_DIR}:/site`);

  args.push('--entrypoint', 'bash');
  args.push(CONTAINER_IMAGE);
  args.push('-c', 'cd /site/budget-server && exec bun server.mjs');

  const id = execFileSync(CONTAINER_RUNTIME_BIN, args, { encoding: 'utf8' }).trim();
  console.log(`budget site container started: ${id.slice(0, 12)} (name ${CONTAINER_NAME})`);
  console.log(`serving ${SITE_DIR} on 0.0.0.0:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
