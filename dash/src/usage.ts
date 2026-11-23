import type { Database } from "bun:sqlite";
import { environmentConfig, withEnvironments, type EnvironmentInfo } from "./environments";

export type Harness = "all" | "claude" | "copilot";
export type UsageOptions = { environment?: string; harness?: Harness; model?: string; from?: string; to?: string; boundary?: string; baseline?: "all" | "14d" };
export type UsageCall = {
  id: string; session: string; ts: string | null; harness: Exclude<Harness, "all">; model: string;
  cost: number | null; premium: number | null; context: number | null;
  input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null;
  reasoning: number | null; duration: number | null; provenance: string; status: string | null;
  environment: string; environmentLabel: string; observedEnvironments: string[];
  title?: string | null;
};
type CopilotRow = {
  id: string; session_id: string; ts: string | null; model: string; nano: number | null;
  premium: number | null; input: number | null; output: number | null; read: number | null;
  write: number | null; duration: number | null; reasoning: number | null; provenance: string; status: string | null;
};
type ClaudeRow = {
  request_id: string; session_id: string; ts: string | null; model: string; cost: number | null;
  context_total: number; input: number; output: number; read: number; write5m: number; write1h: number; thinking: number;
  known_cost?: number | null; status?: string; write_unknown?: number;
};
const total = (rows: UsageCall[], field: keyof UsageCall) => {
  const measured = rows.map((r) => r[field]).filter((n): n is number => typeof n === "number");
  return measured.length ? measured.reduce((a, b) => a + b, 0) : null;
};
const divide = (a: number | null, b: number | null) => a != null && b != null && b > 0 ? a / b : null;
const median = (rows: number[]) => {
  const sorted = rows.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2 : null;
};
const localDay = (ts: string) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function calls(db: Database, options: UsageOptions & { session?: string }, environment: EnvironmentInfo): UsageCall[] {
  const result: UsageCall[] = [];
  const filters: string[] = [];
  const params: string[] = [];
  if (options.session) { filters.push("session_id=?"); params.push(options.session); }
  if (options.from) { filters.push("ts>=?"); params.push(options.from); }
  if (options.to) { filters.push("ts<?"); params.push(options.to); }
  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name));
  const origin = { environment: environment.id, environmentLabel: environment.label, observedEnvironments: [environment.id] };
  if (options.harness !== "claude" && tables.has("copilot_calls")) {
    for (const row of db.query(`SELECT * FROM copilot_calls${where}`).all(...params) as CopilotRow[]) {
      result.push({ id: `copilot:${row.id}`, session: row.session_id, ts: row.ts, harness: "copilot", model: row.model,
        cost: row.nano == null ? null : row.nano / 1e11, premium: row.premium, context: row.input,
        input: row.input, output: row.output, cacheRead: row.read, cacheWrite: row.write, reasoning: row.reasoning,
        duration: row.duration, provenance: row.provenance, status: row.status, ...origin });
    }
  }
  if (options.harness !== "copilot" && tables.has("requests")) {
    const titles = tables.has("sessions") ? new Map((db.query("SELECT id,title FROM sessions WHERE title IS NOT NULL").all() as { id: string; title: string }[]).map((s) => [s.id, s.title])) : new Map<string, string>();
    for (const row of db.query(`SELECT * FROM requests${where}`).all(...params) as ClaudeRow[]) {
      result.push({ id: `claude:${row.request_id}`, session: row.session_id, ts: row.ts, harness: "claude", model: row.model,
        cost: row.cost ?? row.known_cost ?? null, premium: null, context: row.context_total, input: row.context_total, output: row.output,
        cacheRead: row.read, cacheWrite: row.write5m + row.write1h + (row.write_unknown || 0), reasoning: row.thinking,
        duration: null, provenance: "claude_price_estimate", status: row.status || null, title: titles.get(row.session_id) || null, ...origin });
    }
  }
  return result.filter((row) => (!options.model || row.model === options.model) &&
    (!options.from || row.ts != null && row.ts >= options.from) && (!options.to || row.ts != null && row.ts < options.to))
    .sort((a, b) => (a.ts || "").localeCompare(b.ts || "") || a.id.localeCompare(b.id));
}

function sessionRows(rows: UsageCall[]) {
  const grouped = new Map<string, UsageCall[]>();
  for (const row of rows) {
    const key = `${row.environment}:${row.harness}:${row.session}`;
    const list = grouped.get(key) || [];
    list.push(row);
    grouped.set(key, list);
  }
  return [...grouped].map(([id, list]) => ({
    id, session: list[0].session, title: list[0].title || null, harness: list[0].harness, environment: list[0].environment, environmentLabel: list[0].environmentLabel, cost: total(list, "cost"),
    requests: list.length, unpriced: list.filter((r) => r.cost == null || r.status === "partial").length,
    context: list.some((r) => r.context != null) ? list.reduce((peak, r) => Math.max(peak, r.context ?? 0), 0) : null,
    opening: list[0].context, first: list[0].ts, last: list.at(-1)?.ts ?? null,
    duration: total(list, "duration"), models: [...new Set(list.map((r) => r.model))],
    provenance: [...new Set(list.map((r) => r.provenance))],
  })).sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || a.id.localeCompare(b.id));
}

function stats(rows: UsageCall[]) {
  const sessions = sessionRows(rows);
  const priced = rows.filter((r) => r.cost != null);
  const cost = total(rows, "cost");
  const days = new Set(rows.filter((r) => r.ts).map((r) => localDay(r.ts!))).size;
  const cached = rows.filter((r) => r.cacheRead != null && r.input != null);
  return {
    requests: rows.length, priced: priced.length, unpriced: rows.filter((r) => r.cost == null || r.status === "partial").length, sessions: sessions.length, days,
    partialCost: rows.filter((r) => r.status === "partial").length,
    cost, costPerRequest: divide(cost, priced.length), costPerDay: divide(cost, days),
    requestsPerDay: divide(rows.length, days), sessionsPerDay: divide(sessions.length, days),
    premium: total(rows.filter((r) => r.harness === "copilot"), "premium"),
    input: total(rows, "input"), output: total(rows, "output"),
    cacheRead: total(rows, "cacheRead"), cacheWrite: total(rows, "cacheWrite"),
    cacheHit: divide(total(cached, "cacheRead"), total(cached, "input")),
    cacheMeasured: cached.length, duration: total(rows, "duration"), durationMeasured: rows.filter((r) => r.duration != null).length,
    medianOpening: median(sessions.map((s) => s.opening).filter((n): n is number => n != null)),
    medianPeak: median(sessions.map((s) => s.context).filter((n): n is number => n != null)),
    contextMeasured: rows.filter((r) => r.context != null).length,
    first: rows.find((r) => r.ts)?.ts ?? null, last: [...rows].reverse().find((r) => r.ts)?.ts ?? null,
  };
}
export type UsageStats = ReturnType<typeof stats>;

export function usageReport(db: Database, options: UsageOptions = {}) {
  return withEnvironments(db, (sources, environments) => {
  const selectedEnvironment = options.environment || environmentConfig().current.id;
  const selected = sources.filter((s) => selectedEnvironment === "all" || s.environment.id === selectedEnvironment);
  const unique = new Map<string, UsageCall>();
  const sourceRows = new Map<string, UsageCall[]>();
  let duplicateCopies = 0;
  const environmentConflicts = new Set<string>();
  for (const source of selected) {
    const measured = calls(source.db, { ...options, model: undefined }, source.environment);
    sourceRows.set(source.environment.id, measured);
    for (const row of measured) {
      const prior = unique.get(row.id);
      if (prior) {
        duplicateCopies++;
        if (!prior.observedEnvironments.includes(row.environment)) prior.observedEnvironments.push(row.environment);
        if (prior.cost !== row.cost) {
          environmentConflicts.add(row.id);
          prior.cost = null;
          prior.status = "conflicting environment copies";
        }
      } else unique.set(row.id, { ...row, observedEnvironments: [...row.observedEnvironments] });
    }
  }
  const allRows = [...unique.values()].sort((a, b) => (a.ts || "").localeCompare(b.ts || "") || a.id.localeCompare(b.id));
  const rows = allRows.filter((r) => !options.model || r.model === options.model);
  const coverageRow = db.query("SELECT json FROM copilot_meta WHERE key='coverage'").get() as { json: string } | null;
  const coverage = coverageRow ? JSON.parse(coverageRow.json) as {
    files: number; observedSessions: number; sessionsWithoutCalls: number; snapshots: number; snapshotCost: number;
    snapshotSum: number; sqliteDuplicates: number; sqliteRows: number; sqliteRawCost: number; sqliteOverlapRows: number;
    sqliteOverlapCost: number; malformed: number; conflictingRecords: number; indexedAt: string; billingPolicy: string;
  } : null;
  const selectedConfig = environments.find((e) => e.id === selectedEnvironment);
  const boundary = options.boundary || (options.harness === "claude" ? selectedConfig?.claudeBoundary :
    options.harness === "copilot" ? selectedConfig?.copilotBoundary : null) || null;
  let comparison: { boundary: string; from: string | null; to: string | null; before: UsageStats; after: UsageStats } | null = null;
  if (boundary) {
    const preceding = new Date(boundary);
    preceding.setDate(preceding.getDate() - 14);
    const baselineFrom = options.baseline === "14d" ? preceding.toISOString() : options.from;
    const before = rows.filter((r) => r.ts && r.ts < boundary && (!baselineFrom || r.ts >= baselineFrom));
    const after = rows.filter((r) => r.ts && r.ts >= boundary);
    comparison = { boundary, from: baselineFrom || null, to: options.to || null, before: stats(before), after: stats(after) };
  }
  const modelGroups = new Map<string, UsageCall[]>();
  const dayGroups = new Map<string, UsageCall[]>();
  for (const row of rows) {
    const model = `${row.environment}:${row.harness}:${row.model}`;
    const modelList = modelGroups.get(model) || [];
    modelList.push(row);
    modelGroups.set(model, modelList);
    if (row.ts) {
      const day = localDay(row.ts);
      const dayList = dayGroups.get(day) || [];
      dayList.push(row);
      dayGroups.set(day, dayList);
    }
  }
  const aggregate = stats(rows);
  const indexError = db.query("SELECT json FROM copilot_meta WHERE key='refresh_error'").get() as { json: string } | null;
  const models = [...modelGroups].map(([id, list]) => ({
    id, model: list[0].model, harness: list[0].harness, environment: list[0].environmentLabel, ...stats(list),
    requestShare: divide(list.length, rows.length), spendShare: divide(total(list, "cost"), aggregate.cost),
    before: boundary ? stats(list.filter((r) => r.ts && r.ts < boundary && (!comparison?.from || r.ts >= comparison.from))) : null,
    after: boundary ? stats(list.filter((r) => r.ts && r.ts >= boundary)) : null,
  })).sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1));
  return { options, totals: aggregate, coverage: selectedEnvironment === environmentConfig().current.id || selectedEnvironment === "all" ? coverage : null,
    environments, selectedEnvironment, duplicateCopies, environmentConflicts: environmentConflicts.size,
    sourceCoverage: selected.flatMap((source) => {
      const hasMeta = source.db.query("SELECT name FROM sqlite_master WHERE name='copilot_meta'").get();
      const meta = hasMeta ? source.db.query("SELECT json FROM copilot_meta WHERE key='coverage'").get() as { json: string } | null : null;
      const manifest = meta ? JSON.parse(meta.json) as { sessionsWithoutCalls?: number; indexedAt?: string } : null;
      return (["claude", "copilot"] as const).map((harness) => ({
        environment: source.environment.label, harness,
        unmeasuredSessions: harness === "copilot" ? manifest?.sessionsWithoutCalls ?? null : null,
        indexedAt: harness === "copilot" ? manifest?.indexedAt ?? null : null,
        ...stats((sourceRows.get(source.environment.id) || []).filter((r) => r.harness === harness && (!options.model || r.model === options.model))),
      }));
    }),
    comparison, boundary, indexError: indexError?.json || null,
    availableModels: [...new Map(allRows.map((r) => [`${r.harness}:${r.model}`, { harness: r.harness, model: r.model }])).values()],
    units: "Copilot: reported USD = nano-AIU / 1e11; 1 AI credit = $0.01. Claude: API-equivalent USD estimate, not subscription charges. Premium-request multipliers are separate, never dollars or AI credits.",
    warnings: [
      "Observed model requests and sessions are not completed or accepted tasks. No task outcomes are inferred.",
      "Before/after is correlation, not an estimate of Agent-kit savings. Model/harness mixture, task complexity, missing history and activity level can change results.",
      "Days used are active local calendar days. Today is partial. Session opening means the first observed request in the selected range, not necessarily a fresh session.",
      "Copilot input includes cache reads/writes; they are not added again. Cache reuse is read tokens / measured prompt input. Missing measurements remain unknown.",
      "Model groups use the recorded response model, not a per-token allocation of any mixed-model billing details.",
      "Claude known USD includes priced components of incomplete calls. Unknown cache-write TTL, missing usage and unknown prices are not filled in. Calls marked partial are lower bounds, not complete cost; known-amount and incomplete-call counts can overlap.",
      "Environment indexes are local only. External indexes are read-only; unavailable environments are not fetched. Duplicate request identities across environments count once in the combined view, with the current environment preferred.",
      ...(coverage && options.harness !== "claude" ? ["Copilot historical coverage is partial: snapshots are not requests. Older/resumed sessions may lack per-call data. SQLite overlap is withheld, not silently added. Snapshot diagnostics cover all indexed history, not the current filters."] : []),
    ],
    models, daily: [...dayGroups].map(([day, list]) => ({ day, ...stats(list) })),
    harnesses: (["claude", "copilot"] as const).map((harness) => ({ harness, ...stats(rows.filter((r) => r.harness === harness)) })),
    sessions: sessionRows(rows),
  };
  });
}
export type UsageReport = ReturnType<typeof usageReport>;

export function usageDetail(db: Database, id: string) {
  return withEnvironments(db, (sources) => {
  const parts = id.split(":");
  const environment = ["claude", "copilot"].includes(parts[0]) ? environmentConfig().current.id : parts.shift()!;
  const harness = parts.shift()!;
  const session = parts.join(":");
  if (!["claude", "copilot"].includes(harness) || !session) return null;
  const source = sources.find((s) => s.environment.id === environment);
  if (!source) return null;
  const rows = calls(source.db, { harness: harness as Harness, session }, source.environment);
  if (!rows.length) return null;
  const breakdowns: { ts: string | null; system: number | null; tools: number | null; context: number | null }[] = [];
  const tools: Record<string, number> = {};
  if (harness === "copilot") {
    const seen = new Set<string>();
    const hasEvents = source.db.query("SELECT name FROM sqlite_master WHERE name='copilot_events'").get();
    for (const row of (hasEvents ? source.db.query("SELECT json FROM copilot_events WHERE session_id=? ORDER BY pos").all(session) : []) as { json: string }[]) {
      const e = JSON.parse(row.json) as { id: string; ts: string | null; system: number | null; tools: number | null; context: number | null };
      if (!seen.has(e.id) && (e.system != null || e.tools != null)) breakdowns.push(e);
      seen.add(e.id);
    }
    for (const row of source.db.query("SELECT tools FROM copilot_calls WHERE session_id=?").all(session) as { tools: string }[]) {
      for (const [name, count] of Object.entries(JSON.parse(row.tools) as Record<string, number>)) tools[name] = (tools[name] || 0) + count;
    }
  }
  return { id, harness, session, environment: source.environment.label, totals: stats(rows), points: rows, breakdowns,
    tools: Object.entries(tools).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) };
  });
}
