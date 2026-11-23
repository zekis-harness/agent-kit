import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newUsage } from '../bin/eval-usage.mjs';
const record = (sequence, changes = {}) => ({ type: 'session.usage_record', data: { usage: {
  accounting: { sourceSessionId: 'session', sequence, usageId: `usage-${sequence}` },
  inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 20,
  copilotUsage: { totalNanoAiu: 1e9 }, aiCreditsStatus: 'complete', ...changes
} } });
test('should count durable identities once, never shutdown or checkpoint snapshots', () => {
  const first = newUsage([record(1), record(1), { type: 'session.shutdown', data: { totalNanoAiu: 1e12 } }]);
  assert.equal(first.input_tokens, 100);
  assert.equal(first.cost_usd, 0.01);
  const next = newUsage([record(1), record(2), record(2), { type: 'session.usage_checkpoint' }], first.identities);
  assert.equal(next.usage_records, 1);
  assert.equal(next.input_tokens, 100);
  assert.equal(next.cost_usd, 0.01);
});
test('should retain unknown cost and tokens rather than fabricating zero coverage', () => {
  assert.equal(newUsage([]).cost_usd, null);
  assert.equal(newUsage([]).input_tokens, null);
  assert.equal(newUsage([record(1, { copilotUsage: undefined })]).cost_usd, null);
  assert.equal(newUsage([record(1, { aiCreditsStatus: 'pending' })]).cost_usd, null);
  assert.equal(newUsage([record(1, { inputTokens: undefined })]).input_tokens, null);
  assert.equal(newUsage([record(1, { inputTokens: -1 })]).input_tokens, null);
  assert.equal(newUsage([record(1, { copilotUsage: { totalNanoAiu: -1 } })]).cost_usd, null);
});
test('should reject conflicting durable identities and legacy records without identity', () => {
  assert.throws(() => newUsage([record(1), record(1, { inputTokens: 101 })]), /Conflicting/);
  assert.throws(() => newUsage([record(1, { accounting: undefined })]), /coverage unknown/);
});
