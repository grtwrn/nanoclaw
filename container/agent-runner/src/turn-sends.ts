/**
 * Turn boundaries for cross-door duplicate suppression.
 *
 * Chat sessions have two delivery doors: the `send_message` MCP tool
 * (available mid-turn, for acknowledgments before slow work) and
 * `<message to="name">` blocks in the final text. Both write a `chat` row to
 * outbound.db, and nothing connected them — so an agent that acknowledged
 * with `send_message` and then repeated the same content in its final block
 * delivered the same message to the user twice.
 *
 * Task sessions closed one door instead: final-text blocks are inert there
 * (see `dispatchResultText`). Chat sessions need both doors open, so the
 * final-text door checks whether it is about to re-send something this turn
 * already delivered.
 *
 * The MCP tools run in a SEPARATE process (`bun run mcp-tools/index.ts` over
 * stdio), so in-memory state cannot be shared between the doors. outbound.db
 * is the shared record — both processes write to it — and the turn boundary
 * is a sequence-number watermark rather than a timestamp, so the check never
 * depends on clock granularity.
 *
 * Scope is deliberately a single turn. The same text in a later turn is a
 * genuine repeat — the user asked again, or a reminder legitimately fires
 * twice — and must always deliver.
 */
import { getMaxOutboundSeq, getOutboundChatSince } from './db/messages-out.js';
import { getTurnStartSeq, setTurnStartSeq } from './db/session-state.js';

/** Whitespace-insensitive but otherwise exact — near-duplicates still deliver. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Start a new turn. Call when new input reaches the agent, not on retries. */
export function resetTurnSends(): void {
  setTurnStartSeq(getMaxOutboundSeq());
}

/**
 * Has this exact text already gone to this destination during this turn —
 * via `send_message` or an earlier block in the same final response?
 *
 * Returns false when the turn boundary is unknown: without it there is no
 * way to tell an echo from a legitimate repeat, and delivering twice beats
 * silently swallowing a message.
 */
export function wasSentThisTurn(channelType: string, platformId: string, text: string): boolean {
  const turnStartSeq = getTurnStartSeq();
  if (turnStartSeq === null) return false;
  const wanted = normalize(text);
  return getOutboundChatSince(turnStartSeq, channelType, platformId).some((sent) => normalize(sent) === wanted);
}
