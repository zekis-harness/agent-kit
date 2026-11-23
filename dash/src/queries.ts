import type { Database } from "bun:sqlite";
import { openDb } from "./db";
import config from "../config.json";
import { compact, money } from "./ui/format";

export type Range = "day" | "week" | "month";
export type Baseline = "all" | "14d";
export type SessionFilters = { project?: string; model?: string; kind?: "main" | "subagent" | "worker-probe"; flag?: string };
export type SessionSort = { by?: "cost" | "context" | "turns" | "duration"; direction?: "asc" | "desc" };

function cutoff(range: Range, now: Date) {
  const days = range === "day" ? 1 : range === "week" ? 7 : 30;
  return new Date(now.getTime() - days * 86400000).toISOString();
}

/** Returns aggregate spend, token, cache, flag, trend, and worst-session data for a time range. */
export function overview(range: Range, now = new Date(), db: Database = openDb()): Record<string, unknown> {
  const since = cutoff(range, now);
  const prior = cutoff(range, new Date(since));
  const totals = db.query(`SELECT coalesce(sum(coalesce(cost,known_cost)),0) cost,sum(input) input,sum(write5m+write1h+write_unknown) cacheWrite,sum(read) cacheRead,sum(output) output,count(*) requests FROM requests WHERE ts>=?`).get(since) as any;
  const previous = db.query("SELECT coalesce(sum(coalesce(cost,known_cost)),0) cost FROM requests WHERE ts>=? AND ts<?").get(prior, since) as any;
  const flagSince = "coalesce((SELECT r.ts FROM requests r WHERE r.request_id=f.request_id),s.started_at)>=?";
  const avoidable = db.query(`SELECT coalesce(sum(amount),0) amount FROM flags f JOIN sessions s ON s.id=f.session_id WHERE ${flagSince}`).get(since) as any;
  const daily = db.query("SELECT substr(ts,1,10) day,model,sum(coalesce(cost,known_cost)) cost FROM requests WHERE ts>=? GROUP BY day,model ORDER BY day,model").all(since);
  const worst = db.query(`SELECT p.id,p.title,sum(f.amount) avoidable,group_concat(DISTINCT f.type) flags
    FROM flags f JOIN sessions s ON s.id=f.session_id JOIN sessions p ON p.id=coalesce(s.parent_id,s.id)
    WHERE ${flagSince} GROUP BY p.id ORDER BY avoidable DESC LIMIT 5`).all(since);
  const openings = db.query("SELECT substr(started_at,1,10) day,avg(opening_total) tokens FROM sessions WHERE started_at>=? GROUP BY day ORDER BY day").all(since);
  const cacheTotal = Number(totals.cacheWrite || 0) + Number(totals.cacheRead || 0);
  const unpriced = Number((db.query("SELECT count(*) n FROM requests WHERE ts>=? AND cost IS NULL").get(since) as any).n);
  return { range, since, cost: totals.cost, previousCost: previous.cost, unpricedRequests: unpriced, proPlanMultiple: Number(totals.cost) / (config.proMonthlyUsd * (range === "day" ? 1 / 30 : range === "week" ? 7 / 30 : 1)), tokens: { input: totals.input || 0, cacheWrite: totals.cacheWrite || 0, cacheRead: totals.cacheRead || 0, output: totals.output || 0 }, cacheHitRate: cacheTotal ? Number(totals.cacheRead) / cacheTotal : 0, avoidable: avoidable.amount, daily, openings, worst, handoffs: handoffCount(db, since) };
}

/** Returns filtered session summaries in the requested stable sort order. */
export function sessions(filters: SessionFilters = {}, sort: SessionSort = {}, db: Database = openDb()): unknown[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.project) { where.push("s.project=?"); params.push(filters.project); }
  if (filters.kind) { where.push("s.kind=?"); params.push(filters.kind); }
  if (filters.model) { where.push("EXISTS(SELECT 1 FROM requests r WHERE r.session_id=s.id AND r.model=?)"); params.push(filters.model); }
  if (filters.flag) { where.push("EXISTS(SELECT 1 FROM flags f WHERE f.session_id=s.id AND f.type=?)"); params.push(filters.flag); }
  const columns = { cost: "rolled_cost", context: "s.peak_context", turns: "s.turns", duration: "julianday(s.ended_at)-julianday(s.started_at)" };
  const order = columns[sort.by || "cost"];
  const direction = sort.direction === "asc" ? "ASC" : "DESC";
  return db.query(`SELECT s.*,
    CASE WHEN s.total_cost IS NULL AND NOT EXISTS(SELECT 1 FROM sessions c WHERE c.parent_id=s.id AND c.total_cost IS NOT NULL) THEN NULL
      ELSE coalesce(s.total_cost,0)+CASE WHEN s.parent_id IS NULL THEN coalesce((SELECT sum(coalesce(c.total_cost,0)) FROM sessions c WHERE c.parent_id=s.id),0) ELSE 0 END END rolled_cost,
    s.unpriced_requests+CASE WHEN s.parent_id IS NULL THEN coalesce((SELECT sum(c.unpriced_requests) FROM sessions c WHERE c.parent_id=s.id),0) ELSE 0 END rolled_unpriced,
    coalesce((SELECT sum(amount) FROM flags f WHERE f.session_id=s.id OR (s.parent_id IS NULL AND f.session_id IN (SELECT id FROM sessions c WHERE c.parent_id=s.id))),0) avoidable,
    (SELECT group_concat(DISTINCT type) FROM flags f WHERE f.session_id=s.id OR (s.parent_id IS NULL AND f.session_id IN (SELECT id FROM sessions c WHERE c.parent_id=s.id))) flag_types,
    (SELECT group_concat(DISTINCT model) FROM requests r WHERE r.session_id=s.id) models,
    (SELECT count(*) FROM sessions c WHERE c.parent_id=s.id) subagent_count
    FROM sessions s ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} ${direction},s.id`).all(...params as any[]);
}

/** Returns request points, opening context, flags, top tool results, and every tool call for one session. */
export function sessionDetail(id: string, db: Database = openDb()): Record<string, unknown> | null {
  const session = db.query("SELECT * FROM sessions WHERE id=?").get(id);
  if (!session) return null;
  const points = db.query("SELECT r.*,(SELECT json_group_array(json_object('type',type,'amount',amount)) FROM flags f WHERE f.request_id=r.request_id) flags FROM requests r WHERE session_id=? ORDER BY ts,request_id").all(id);
  const results = db.query("SELECT * FROM tool_results WHERE session_id=? ORDER BY token_est DESC LIMIT 10").all(id);
  const calls = db.query("SELECT * FROM tool_calls WHERE session_id=? ORDER BY ts").all(id);
  const opening = db.query("SELECT component,name,chars,tokens FROM opening WHERE session_id=? AND component<>'skill' ORDER BY tokens DESC").all(id);
  const subagents = db.query("SELECT id,title,turns,total_cost,peak_context,unpriced_requests FROM sessions WHERE parent_id=? ORDER BY started_at,id").all(id);
  return { session, points, results, calls, opening, subagents };
}

/** Returns per-session opening component splits and end-of-first-prompt context. */
export function openingContext(db: Database = openDb()): unknown[] {
  return db.query("SELECT s.id,s.title,s.started_at,s.opening_total,s.context_end_first,o.component,o.name,o.tokens FROM sessions s LEFT JOIN opening o ON o.session_id=s.id AND o.component<>'skill' ORDER BY s.started_at,o.tokens DESC").all();
}

type Verdict = "better" | "worse" | "same" | null;
type Better = "lower" | "higher" | null;
type Format = "money" | "money3" | "tokens" | "percent" | "number";
type Row = { key: string; group: string; label: string; explain: string; before: number | null; after: number | null; beforeText: string; afterText: string; verdict: Verdict };

const FAR_FUTURE = "9999";
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const ratio = (top: number, bottom: number) => bottom ? top / bottom : null;

function showValue(value: number | null, format: Format) {
  if (value == null) return "No data";
  if (format === "money") return money(value);
  if (format === "money3") return `$${value.toFixed(3)}`;
  if (format === "percent") return `${(value * 100).toFixed(1)}%`;
  if (format === "tokens") return compact(value);
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function verdictOf(before: number | null, after: number | null, better: Better): Verdict {
  if (!better || before == null || after == null) return null;
  if (before === after) return "same";
  if (before === 0) return (after > 0) === (better === "higher") ? "better" : "worse";
  const change = (after - before) / Math.abs(before);
  if (Math.abs(change) <= 0.05) return "same";
  return (change < 0) === (better === "lower") ? "better" : "worse";
}

function periodStats(db: Database, from: string, to: string) {
  const usage = db.query(`SELECT count(*) requests,count(coalesce(cost,known_cost)) priced,coalesce(sum(coalesce(cost,known_cost)),0) spend,coalesce(sum(output),0) output,
    coalesce(sum(read),0) cacheRead,coalesce(sum(write5m+write1h+write_unknown),0) cacheWrite,count(DISTINCT date(ts,'localtime')) days,
    coalesce(sum(CASE WHEN model LIKE '%opus%' THEN coalesce(cost,known_cost) END),0) opusSpend,coalesce(sum(model LIKE '%opus%'),0) opusRequests,
    min(ts) first,max(ts) last FROM requests WHERE ts>=? AND ts<?`).get(from, to) as any;
  const sessionRows = db.query(`SELECT s.opening_total opening,s.context_end_first firstPrompt,s.peak_context peak,s.continued_from_path continued,
    coalesce(s.total_cost,0)+coalesce((SELECT sum(c.total_cost) FROM sessions c WHERE c.parent_id=s.id),0) cost
    FROM sessions s WHERE s.kind='main' AND s.turns>0 AND s.started_at>=? AND s.started_at<?`).all(from, to) as any[];
  const flagRows = db.query(`SELECT f.type,sum(f.amount) amount,count(*) n FROM flags f JOIN sessions s ON s.id=f.session_id
    LEFT JOIN requests r ON r.request_id=f.request_id WHERE coalesce(r.ts,s.started_at)>=? AND coalesce(r.ts,s.started_at)<? GROUP BY f.type`).all(from, to) as any[];
  const flag = (type: string) => flagRows.find((row) => row.type === type) || { amount: 0, n: 0 };
  const delegated = (db.query("SELECT count(*) n FROM tool_calls WHERE name IN ('Agent','Task') AND ts>=? AND ts<?").get(from, to) as any).n as number;
  return { ...usage, sessions: sessionRows, flag, delegated };
}

function openingPartsBetween(db: Database, from: string, to: string) {
  const rows = db.query(`SELECT o.session_id,o.component,o.tokens FROM opening o JOIN sessions s ON s.id=o.session_id
    WHERE s.kind='main' AND o.component<>'skill' AND s.started_at>=? AND s.started_at<?`).all(from, to) as any[];
  const count = new Set(rows.map((row) => row.session_id)).size;
  const totals: Record<string, number> = {};
  for (const row of rows) {
    const part = row.component === "mcp_instructions" || row.component.startsWith("mcp:") ? "mcp" : ["instructions", "skills", "builtin_tools", "system_prompt"].includes(row.component) ? row.component : "other";
    totals[part] = (totals[part] || 0) + row.tokens;
  }
  return (part: string) => count ? (totals[part] || 0) / count : null;
}

/** Returns the before-and-after comparison around the agent-kit start, plus worker jobs. */
export function agentKit(db: Database = openDb(), baseline: Baseline = "all"): Record<string, unknown> {
  const start = config.agentKitStart;
  const from = baseline === "14d" ? new Date(Date.parse(start) - 14 * 86400000).toISOString() : "";
  const before = periodStats(db, from, start);
  const after = periodStats(db, start, FAR_FUTURE);
  const partsFrom = from > config.openingPartsComparableFrom ? from : config.openingPartsComparableFrom;
  const partsBefore = openingPartsBetween(db, partsFrom, start);
  const partsAfter = openingPartsBetween(db, start, FAR_FUTURE);
  const openings = (stats: typeof before) => stats.sessions.map((s: any) => s.opening).filter((n: any) => n != null);
  const peakOver = (stats: typeof before) => ratio(stats.sessions.filter((s: any) => s.peak > config.ranPastHandoffContextTokens).length, stats.sessions.length);
  const perDay = (stats: typeof before, value: number) => ratio(value, stats.days);
  const hitRate = (stats: typeof before) => ratio(stats.cacheRead, stats.cacheRead + stats.cacheWrite);

  const rows: Row[] = [];
  const add = (group: string, key: string, label: string, explain: string, format: Format, better: Better, measure: (stats: typeof before) => number | null) => {
    const [b, a] = [measure(before), measure(after)];
    rows.push({ key, group, label, explain, before: b, after: a, beforeText: showValue(b, format), afterText: showValue(a, format), verdict: verdictOf(b, a, better) });
  };
  const partsFromText = new Date(partsFrom).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const partsNote = `Average per session. Before covers only sessions since ${partsFromText}, when this split became measurable.`;
  const part = (key: string, label: string, explain: string, name: string, better: Better) => add("Opening", key, label, `${explain} ${partsNote}`, "tokens", better, (s) => s === before ? partsBefore(name) : partsAfter(name));

  add("Cost", "spend", "Total spend", "API-equivalent dollars in each period. The periods differ in length, so this is context, not a score.", "money", null, (s) => s.spend);
  add("Cost", "days", "Days used", "Days with at least one request.", "number", null, (s) => s.days);
  add("Cost", "spend_per_day", "Spend per day used", "Total spend divided by days used.", "money", "lower", (s) => perDay(s, s.spend));
  add("Cost", "requests_per_day", "Requests per day used", "How much was sent to the model. More is not good or bad on its own.", "number", null, (s) => perDay(s, s.requests));
  add("Cost", "cost_per_request", "Cost per request", "Average price of one trip to the model.", "money3", "lower", (s) => ratio(s.spend, s.priced));
  add("Cost", "cost_per_1k_output", "Cost per 1K tokens of output", "What you pay for each unit of work the model produces.", "money3", "lower", (s) => ratio(s.spend * 1000, s.output));
  add("Cost", "sessions", "Sessions", "Main sessions started, not counting subagents or workers.", "number", null, (s) => s.sessions.length);
  add("Cost", "mean_session_cost", "Average cost per session", "Not scored: handoffs split one long session into several, so this falls without saving anything.", "money", null, (s) => ratio(s.sessions.reduce((n: number, row: any) => n + row.cost, 0), s.sessions.length));
  add("Cost", "median_session_cost", "Typical cost per session", "The middle session. Not scored, for the same reason.", "money", null, (s) => median(s.sessions.map((row: any) => row.cost)));
  add("Opening", "median_opening", "Tokens at session start", "Typical size of what is loaded before you type anything. It is re-read on every request.", "tokens", "lower", (s) => median(openings(s)));
  add("Opening", "median_first_prompt", "Tokens after the first prompt", "Typical size once the first prompt has been answered.", "tokens", "lower", (s) => median(s.sessions.map((row: any) => row.firstPrompt).filter((n: any) => n != null)));
  part("opening_instructions", "Instructions", "CLAUDE.md and memory.", "instructions", "lower");
  part("opening_skills", "Skills list", "Names and descriptions of available skills.", "skills", "lower");
  part("opening_mcp", "Connected servers (MCP)", "Tools and instructions from connected servers.", "mcp", "lower");
  part("opening_builtin", "Built-in tools", "Set by Claude Code, so not credited to agent-kit.", "builtin_tools", null);
  part("opening_system", "System prompt", "Set by Claude Code, so not credited to agent-kit.", "system_prompt", null);
  add("Opening", "unused_cost_per_day", "Loaded but never used, per day", "Estimate of what servers and skills that went unused cost to carry.", "money", "lower", (s) => perDay(s, s.flag("loaded_never_used").amount));
  add("Context", "median_peak", "Largest size a session reached", "Typical peak. Bigger sessions cost more on every request.", "tokens", "lower", (s) => median(s.sessions.map((row: any) => row.peak)));
  add("Context", "over_200k_share", "Sessions that passed 200K", "Share of sessions that grew past 200K tokens.", "percent", "lower", peakOver);
  add("Context", "handoff_sessions", "Sessions continued from a handoff", "A session that picked up from a written handoff instead of growing further.", "number", null, (s) => s.sessions.filter((row: any) => row.continued).length);
  add("Context", "past_handoff_per_day", "Lost by running too long, per day", "Estimate of the extra cost of staying past the point where a handoff was due.", "money", "lower", (s) => perDay(s, s.flag("ran_past_handoff").amount));
  add("Context", "oversized_per_day", "Lost to oversized tool results, per day", "Estimate of the cost of carrying one very large tool result through later requests.", "money", "lower", (s) => perDay(s, s.flag("oversized_tool_result").amount));
  add("Cache", "cache_hit", "Cache hit rate", "Share of cached context that was reused rather than written again.", "percent", "higher", hitRate);
  add("Cache", "cache_write_per_request", "Cache writes per request", "Tokens written to the cache on an average request. Writes cost far more than reads.", "tokens", "lower", (s) => ratio(s.cacheWrite, s.requests));
  add("Cache", "cold_per_day", "Cold restarts per day", "A session sat idle until its cache expired, then rebuilt it at the write price.", "number", "lower", (s) => perDay(s, s.flag("cold_rebuild").n));
  add("Cache", "cold_cost_per_day", "Lost to cold restarts, per day", "Estimate of the extra cost of those rebuilds.", "money", "lower", (s) => perDay(s, s.flag("cold_rebuild").amount));
  add("Models", "opus_share", "Opus share of spend", "Opus is the most expensive model. Moving routine work off it is the kit's main way to save.", "percent", "lower", (s) => ratio(s.opusSpend, s.spend));
  add("Models", "opus_request_share", "Opus share of requests", "The same question counted in requests rather than dollars.", "percent", "lower", (s) => ratio(s.opusRequests, s.requests));
  add("Delegation", "delegated_calls", "Subagent calls", "Times a session handed work to a subagent. Periods differ in length.", "number", null, (s) => s.delegated);
  add("Delegation", "delegated_per_100", "Subagent calls per 100 requests", "The same count, adjusted for how much was sent.", "number", "higher", (s) => ratio(s.delegated * 100, s.requests));

  const row = (key: string) => rows.find((item) => item.key === key)!;
  const move = (key: string) => `${row(key).beforeText} to ${row(key).afterText}`;
  const recentOpening = median(openings(periodStats(db, partsFrom, start)));
  const card = (key: string, question: string, lead: Record<"better" | "worse" | "same", string>, tail: string) => {
    const item = row(key);
    return { key, question, metric: item.label, beforeText: item.beforeText, afterText: item.afterText, verdict: item.verdict, sentence: `${item.verdict ? lead[item.verdict] : "Not enough data yet."} ${tail}` };
  };
  const cards = [
    card("cost_per_1k_output", "Is each dollar buying more?", { better: "Yes. The same output costs less than it did.", worse: "No. The same output costs more than it did.", same: "No real change in what a dollar buys." }, `Cost per request went ${move("cost_per_request")}.`),
    card("spend_per_day", "Am I spending less?", { better: "Yes. Spend per day used is down.", worse: "No. Spend per day used went up.", same: row("cost_per_request").verdict === "better" ? "The bill is flat, and it buys more work." : "No. Spend per day used has not dropped." }, `Cost per request went ${move("cost_per_request")}, while requests per day went ${move("requests_per_day")}.`),
    card("median_opening", "Do sessions start lighter?", { better: "Yes. Less is loaded before you type.", worse: "No. More is loaded before you type.", same: "No real change in what is loaded before you type." }, `In the sessions just before agent-kit, from ${partsFromText}, it was ${showValue(recentOpening, "tokens")}.`),
    card("over_200k_share", "Do sessions stay small?", { better: "Yes. Far fewer sessions run long.", worse: "No. More sessions run long.", same: "No real change in how many sessions run long." }, `Handoff sessions went ${move("handoff_sessions")}, and those split long work into shorter sessions.`),
    card("opus_share", "Are cheaper models doing more?", { better: "Yes. Opus takes a smaller share of spend.", worse: "No. Opus takes a bigger share of spend, the opposite of what the kit aims for.", same: "No. Opus takes about the same share of spend." }, `Subagent calls went ${move("delegated_calls")}.`),
    card("cold_cost_per_day", "Is the cache staying warm?", { better: "Yes. Less is lost to cold restarts each day.", worse: "No. More is lost to cold restarts each day.", same: "About the same is lost to cold restarts each day." }, `Cold restarts per day went ${move("cold_per_day")}. Cache hit rate went ${move("cache_hit")}.`),
  ];

  const openingDays = db.query(`SELECT date(started_at,'localtime') day,opening_total tokens,started_at>=? isAfter FROM sessions
    WHERE kind='main' AND opening_total IS NOT NULL AND started_at>=? ORDER BY started_at`).all(start, from) as any[];
  const byDay = new Map<string, { after: boolean; tokens: number[] }>();
  for (const item of openingDays) {
    const day = byDay.get(item.day) || { after: !!item.isAfter, tokens: [] };
    day.tokens.push(item.tokens);
    byDay.set(item.day, day);
  }
  const buckets = db.query(`SELECT CAST((julianday(ts)-julianday(?))/7+100000 AS INTEGER)-100000 bucket,sum(coalesce(cost,known_cost))/count(coalesce(cost,known_cost)) costPerRequest FROM requests
    WHERE ts>=? AND cost IS NOT NULL GROUP BY bucket ORDER BY bucket`).all(start, from) as any[];
  const allSpend = db.query("SELECT model,sum(coalesce(cost,known_cost)) spend FROM requests GROUP BY model ORDER BY spend DESC,model").all() as any[];
  const named = allSpend.slice(0, 7).map((item) => item.model as string);
  const shareOf = (stats: typeof before, range: [string, string]) => {
    const models = db.query("SELECT model,sum(coalesce(cost,known_cost)) spend FROM requests WHERE ts>=? AND ts<? GROUP BY model").all(...range) as any[];
    return (model: string | null) => models.filter((item) => model ? item.model === model : !named.includes(item.model)).reduce((n, item) => n + (ratio(item.spend || 0, stats.spend) || 0), 0);
  };
  const shareBefore = shareOf(before, [from, start]);
  const shareAfter = shareOf(after, [start, FAR_FUTURE]);
  const partNames: Array<[string, string]> = [["system_prompt", "System prompt"], ["builtin_tools", "Built-in tools"], ["mcp", "Connected servers (MCP)"], ["skills", "Skills list"], ["instructions", "Instructions"], ["other", "Other"]];
  const charts = {
    openingByDay: [...byDay].map(([day, value]) => ({ day, after: value.after, tokens: median(value.tokens) })),
    openingParts: partNames.map(([key, label]) => ({ key, label, before: partsBefore(key) || 0, after: partsAfter(key) || 0 })),
    costPerRequest: buckets.map((item) => ({ weekOf: new Date(Date.parse(start) + item.bucket * 7 * 86400000).toISOString().slice(0, 10), after: item.bucket >= 0, cost: item.costPerRequest })),
    modelShare: [...named.map((model) => ({ model: model.replace(/^claude-/, "").replace(/-\d{8}$/, ""), before: shareBefore(model), after: shareAfter(model) })), ...(allSpend.length > 7 ? [{ model: "Other", before: shareBefore(null), after: shareAfter(null) }] : [])],
    partsFrom,
  };

  const changes = (config.agentKitChanges as { date: string; change: string; metrics: string[] }[]).map((change) => ({ date: change.date, change: change.change, results: change.metrics.map((key) => ({ label: row(key).label, beforeText: row(key).beforeText, afterText: row(key).afterText, verdict: row(key).verdict })) }));

  const runs = db.query(`SELECT r.run,r.ts,r.harness,r.tier,r.model,r.cwd,r.brief,r.cost_usd,r.duration_s,r.status,v.outcome
    FROM ledger_runs r LEFT JOIN ledger_verdicts v USING(run) ORDER BY r.ts DESC`).all() as any[];
  const baseName = (path: string | null) => path ? path.split(/[\\/]/).filter(Boolean).at(-1) || null : null;
  const isProbe = (item: any) => /agent-kit-probe-/i.test(item.brief || item.cwd || "") || /^probe-/i.test(baseName(item.brief) || "");
  const jobs = runs.filter((item) => !isProbe(item)).map((item) => ({ run: item.run, name: baseName(item.brief)?.replace(/\.md$/i, "") || "Unnamed job", repo: baseName(item.cwd), harness: item.harness, model: item.model, ts: item.ts, durationSeconds: item.duration_s, cost: item.cost_usd, status: item.status, outcome: item.outcome }));

  const summary = (stats: typeof before) => ({ first: stats.first, last: stats.last, days: stats.days, requests: stats.requests, sessions: stats.sessions.length });
  return { baseline, start, period: { before: summary(before), after: summary(after), earlyData: after.days < 14 }, cards, rows, charts, changes, jobs, probeCount: runs.length - jobs.length };
}

/** Returns the number of sessions whose first human prompt continues a recorded handoff. */
export function handoffCount(db: Database = openDb(), since = ""): number {
  return Number((db.query("SELECT count(*) n FROM sessions WHERE continued_from_path IS NOT NULL AND coalesce(started_at,'')>=?").get(since) as any).n);
}

/** Returns sessions that continued from a handoff and the session that wrote it. */
export function handoffs(db: Database = openDb()): unknown[] {
  return db.query(`SELECT s.id,s.title,s.started_at,s.continued_from_path,s.writer_session_id,
    w.title writer_title FROM sessions s LEFT JOIN sessions w ON w.id=s.writer_session_id
    WHERE s.continued_from_path IS NOT NULL ORDER BY s.started_at DESC`).all();
}
