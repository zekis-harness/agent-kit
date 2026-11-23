import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Only durable per-call records are counted. Shutdown/checkpoint snapshots are never calls.
export function newUsage(events, previous = []) {
  const seen = new Map(previous.map(record => [record.key, record.fingerprint]));
  const records = [];
  for (const event of events) {
    if (event.type !== 'session.usage_record') continue;
    const usage = event.data?.usage;
    const identity = usage?.accounting;
    if (!identity?.sourceSessionId || !Number.isInteger(identity.sequence) || !identity.usageId) {
      throw new Error('Usage record lacks durable identity; coverage unknown.');
    }
    const key = JSON.stringify([identity.sourceSessionId, identity.sequence, identity.usageId]);
    const fingerprint = JSON.stringify([usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.copilotUsage?.totalNanoAiu, usage.aiCreditsStatus]);
    if (seen.has(key)) {
      if (seen.get(key) !== fingerprint) throw new Error('Conflicting duplicate usage identity.');
      continue;
    }
    seen.set(key, fingerprint);
    records.push({ key, fingerprint, usage });
  }
  const total = field => records.length && records.every(record => Number.isFinite(record.usage[field]) && record.usage[field] >= 0)
    ? records.reduce((sum, record) => sum + record.usage[field], 0) : null;
  const priced = records.length && records.every(record =>
    record.usage.aiCreditsStatus === 'complete' && Number.isFinite(record.usage.copilotUsage?.totalNanoAiu) && record.usage.copilotUsage.totalNanoAiu >= 0);
  return {
    identities: [...previous, ...records.map(({ key, fingerprint }) => ({ key, fingerprint }))],
    input_tokens: total('inputTokens'), output_tokens: total('outputTokens'),
    cache_read_tokens: total('cacheReadTokens'), cache_write_tokens: total('cacheWriteTokens'),
    cost_usd: priced ? records.reduce((sum, record) => sum + record.usage.copilotUsage.totalNanoAiu, 0) / 1e11 : null,
    usage_records: records.length
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [eventsPath, seenPath, outputPath] = process.argv.slice(2);
  const events = readFileSync(eventsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const previous = existsSync(seenPath) ? JSON.parse(readFileSync(seenPath, 'utf8')) : [];
  const { identities, ...usage } = newUsage(events, previous);
  writeFileSync(outputPath, JSON.stringify(usage));
  writeFileSync(seenPath, JSON.stringify(identities));
}
