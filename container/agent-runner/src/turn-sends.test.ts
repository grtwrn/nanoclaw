/**
 * Two-door delivery in chat sessions.
 *
 * `send_message` (mid-turn) and final-text `<message to>` blocks both deliver.
 * An agent that acknowledges with the tool and then repeats itself in the
 * final block must not deliver the same text to the user twice.
 *
 * The doors live in different processes, so the coupling under test is via
 * outbound.db — these tests exercise the real tool handler, not a stub.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { sendMessage } from './mcp-tools/core.js';
import { dispatchResultText } from './poll-loop.js';
import { resetTurnSends } from './turn-sends.js';
import type { RoutingContext } from './formatter.js';

const chatRouting: RoutingContext = {
  platformId: 'telegram:99',
  channelType: 'telegram',
  threadId: null,
  inReplyTo: 'in-1',
  taskRun: false,
};

function seedDestination(name = 'family', channelType = 'telegram', platformId = 'telegram:99'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

function deliveredTexts(): string[] {
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'chat')
    .map((m) => JSON.parse(m.content).text);
}

beforeEach(() => {
  initTestSessionDb();
  seedDestination();
  resetTurnSends();
});

afterEach(() => {
  closeSessionDb();
});

describe('duplicate suppression across delivery doors', () => {
  it('drops a final-text block that echoes a send_message from the same turn', async () => {
    await sendMessage.handler({ to: 'family', text: 'Added — Yakushima is on the list.' });
    const { sent } = dispatchResultText('<message to="family">Added — Yakushima is on the list.</message>', chatRouting);

    expect(deliveredTexts()).toEqual(['Added — Yakushima is on the list.']);
    // Counted as sent — the content did reach the user, so the "not delivered"
    // nudge must not fire and produce a third copy.
    expect(sent).toBe(1);
  });

  it('ignores whitespace differences between the two doors', async () => {
    await sendMessage.handler({ to: 'family', text: 'On it —  opening   Weee now' });
    dispatchResultText('<message to="family">On it — opening Weee now</message>', chatRouting);

    expect(deliveredTexts()).toHaveLength(1);
  });

  it('still delivers a final block that says something new', async () => {
    await sendMessage.handler({ to: 'family', text: 'On it — opening Weee now' });
    const { sent } = dispatchResultText('<message to="family">Cart is built, 12 items.</message>', chatRouting);

    expect(deliveredTexts()).toEqual(['On it — opening Weee now', 'Cart is built, 12 items.']);
    expect(sent).toBe(1);
  });

  it('does not suppress the same text sent to a different destination', async () => {
    seedDestination('work', 'slack', 'slack:C1');
    await sendMessage.handler({ to: 'family', text: 'Standup at 10.' });
    dispatchResultText('<message to="work">Standup at 10.</message>', chatRouting);

    expect(deliveredTexts()).toHaveLength(2);
  });

  it('delivers the same text again in a later turn', async () => {
    await sendMessage.handler({ to: 'family', text: 'Done!' });
    resetTurnSends(); // next turn — the user asked again

    dispatchResultText('<message to="family">Done!</message>', chatRouting);
    expect(deliveredTexts()).toEqual(['Done!', 'Done!']);
  });

  it('suppresses a second send_message with the same text in one turn', async () => {
    await sendMessage.handler({ to: 'family', text: 'Reminder: pizza at 7.' });
    const second = await sendMessage.handler({ to: 'family', text: 'Reminder: pizza at 7.' });

    expect(deliveredTexts()).toEqual(['Reminder: pizza at 7.']);
    // Reported as success — an error would invite the agent to retry.
    expect(second.content[0].text).toContain('Already sent');
  });

  it('delivers rather than suppresses when the turn boundary is unknown', async () => {
    await sendMessage.handler({ to: 'family', text: 'Only copy' });
    // No watermark: a container killed mid-turn must never silence the next one.
    getOutboundDb().prepare("DELETE FROM session_state WHERE key = 'turn_start_seq'").run();

    dispatchResultText('<message to="family">Only copy</message>', chatRouting);
    expect(deliveredTexts()).toHaveLength(2);
  });

  it('suppresses a repeat of a final block within one turn', () => {
    const { sent } = dispatchResultText(
      '<message to="family">Same thing</message><message to="family">Same thing</message>',
      chatRouting,
    );

    expect(deliveredTexts()).toEqual(['Same thing']);
    expect(sent).toBe(2);
  });
});
