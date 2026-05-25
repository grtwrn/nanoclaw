import net from 'net';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { addMember } from '../src/modules/permissions/db/agent-group-members.js';
import { getUserRoles, grantRole } from '../src/modules/permissions/db/user-roles.js';
import { initGroupFilesystem } from '../src/group-init.js';

const FOLDER = 'bigweld-specialist';
const NAME = 'Bigweld Specialist';
const USER_ID = 'telegram:8692103053';
const PLATFORM_ID = 'telegram:8692103053';
const WELCOME =
  'System instruction: run /welcome to introduce yourself to the user on this new channel.';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(initDb(path.join(DATA_DIR, 'v2.db')));
  const now = new Date().toISOString();

  let ag = getAgentGroupByFolder(FOLDER);
  if (!ag) {
    createAgentGroup({
      id: generateId('ag'),
      name: NAME,
      folder: FOLDER,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(FOLDER)!;
    console.log(`Created agent group: ${ag.id} (${FOLDER})`);
  } else {
    console.log(`Reusing agent group: ${ag.id} (${FOLDER})`);
  }
  initGroupFilesystem(ag, {
    instructions:
      `# ${NAME}\n\n` +
      `You are ${NAME}, a NanoClaw specialist agent. ` +
      'When the user first reaches out (or you receive a system welcome prompt), introduce yourself briefly and ask what they need. Keep replies concise.',
  });

  const roles = getUserRoles(USER_ID);
  const alreadyOwner = roles.some((r) => r.role === 'owner' && r.agent_group_id === null);
  if (!alreadyOwner) {
    grantRole({
      user_id: USER_ID,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now,
    });
    console.log(`Granted owner to ${USER_ID}`);
  }
  addMember({ user_id: USER_ID, agent_group_id: ag.id, added_by: null, added_at: now });

  const dmMg = getMessagingGroupByPlatform('telegram', PLATFORM_ID);
  if (!dmMg) throw new Error(`Messaging group not found for ${PLATFORM_ID}`);
  const existing = getMessagingGroupAgentByPair(dmMg.id, ag.id);
  if (existing) {
    console.log(`Wiring already exists: ${existing.id}`);
  } else {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: dmMg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`Wired ${dmMg.id} -> ${ag.id}`);
  }

  await sendWelcome(dmMg.channel_type, dmMg.platform_id);
  console.log('Welcome queued.');
}

function sendWelcome(channelType: string, platformId: string): Promise<void> {
  const sockPath = path.join(DATA_DIR, 'cli.sock');
  return new Promise<void>((resolve, reject) => {
    const socket = net.connect(sockPath);
    let settled = false;
    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {}
      err ? reject(err) : resolve();
    };
    socket.once('error', (err) => settle(new Error(`CLI socket: ${err.message}`)));
    socket.once('connect', () => {
      const payload =
        JSON.stringify({
          text: WELCOME,
          senderId: USER_ID,
          sender: NAME,
          to: { channelType, platformId, threadId: platformId },
        }) + '\n';
      socket.write(payload, (err) => {
        if (err) return settle(err);
        setTimeout(() => settle(null), 50);
      });
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
