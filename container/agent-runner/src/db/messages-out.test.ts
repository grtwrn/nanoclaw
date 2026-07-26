/**
 * Regression coverage for the ack-reaction bug: the host namespaces
 * messages_in.id as `<platformId>:<agentGroupId>` (router.ts
 * `messageIdForAgent`) so fan-out can't collide on the PRIMARY KEY. That
 * namespace was leaking into add_reaction / edit_message targets, so channels
 * were asked to react to a message id that doesn't exist on the platform and
 * dropped the reaction without an error.
 */
import { describe, expect, test } from 'bun:test';

import { stripAgentGroupNamespace } from './messages-out.js';

describe('stripAgentGroupNamespace', () => {
  test('strips the agent-group suffix the router appends', () => {
    expect(stripAgentGroupNamespace('AC6BB0B0E85D3E126D1A3CA6912321AC:ag-1776976018324-bxbm4t')).toBe(
      'AC6BB0B0E85D3E126D1A3CA6912321AC',
    );
  });

  test('strips a uuid-shaped agent-group suffix', () => {
    expect(
      stripAgentGroupNamespace('3EB06B22FDCFC8C2:ag-1e1a5f6e-2b3c-4d5e-8f90-a1b2c3d4e5f6'),
    ).toBe('3EB06B22FDCFC8C2');
  });

  test('keeps colons that belong to the platform id itself', () => {
    // Telegram ids are "<chatId>:<messageId>" — only a trailing ag- segment goes.
    expect(stripAgentGroupNamespace('6037840640:42:ag-1776976018324-bxbm4t')).toBe('6037840640:42');
    expect(stripAgentGroupNamespace('6037840640:42')).toBe('6037840640:42');
  });

  test('leaves an un-namespaced id untouched', () => {
    expect(stripAgentGroupNamespace('AC6BB0B0E85D3E126D1A3CA6912321AC')).toBe(
      'AC6BB0B0E85D3E126D1A3CA6912321AC',
    );
    expect(stripAgentGroupNamespace('msg-1785105788611-weiqiy')).toBe('msg-1785105788611-weiqiy');
  });
});
