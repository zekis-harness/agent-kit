import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../src/db";
import { runIndex } from "../src/indexer";
import { usageReport } from "../src/usage";
import { overview, sessionDetail, sessions } from "../src/queries";

const roots: string[] = [];
afterEach(() => {
  for (const key of ["DASH_PROJECTS_DIR", "DASH_HANDOFFS_DIR", "DASH_DB", "DASH_COPILOT_ROOTS"]) delete process.env[key];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

export function corpus(root: string) {
  const project = join(root, "projects", "fixture");
  mkdirSync(join(project, "main", "subagents"), { recursive: true });
  const usage = { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 60,
    cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 40 }, output_tokens: 30 };
  const assistant = (id: string, extra: Record<string, unknown> = {}, measured: Record<string, unknown> = usage) => ({
    type: "assistant", sessionId: "main", requestId: `request-${id}`, timestamp: "2026-11-05T10:00:00Z",
    cwd: "C:\\fixture", message: { id, model: "claude-sonnet-5", usage: measured, content: [] }, ...extra,
  });
  const delta = (text: string, timestamp = "2026-11-05T09:59:59Z") => ({ type: "attachment", sessionId: "main", timestamp,
    attachment: { type: "deferred_tools_delta" }, rendered: [{ content: text }] });
  const first = [
    { type: "user", sessionId: "main", uuid: "human-1", timestamp: "2026-11-05T09:59:00Z", message: { role: "user", content: "PROMPT_PRIVATE" } },
    { type: "ai-title", sessionId: "main", aiTitle: "Representative main session" },
    { type: "api-request-shape", sessionId: "main", timestamp: "2026-11-05T09:59:01Z",
      shape: { system: [{ text: "system" }], tools: [{ name: "Read" }, { name: "mcp__fixture__find", defer_loading: true }] } },
    delta("first tools"), delta("distinct tools"), delta("first tools"),
    assistant("stream", {}, { ...usage, cache_creation: undefined, output_tokens: 1 }),
    assistant("stream"), assistant("stream"),
    assistant("next", { timestamp: "2026-11-05T10:01:00Z" }),
    { type: "user", sessionId: "main", uuid: "human-2", timestamp: "2026-11-05T10:02:00Z", message: { role: "user", content: "SECOND_PRIVATE" } },
    delta("later tools are not opening", "2026-11-05T10:03:00Z"),
  ];
  const save = (path: string, values: unknown[]) => writeFileSync(path, values.map((v) => JSON.stringify(v) + "\n").join(""));
  save(join(project, "a-main.jsonl"), first);
  save(join(project, "b-resume.jsonl"), first);
  save(join(project, "main", "subagents", "agent-a.jsonl"), [
    assistant("stream", { agentId: "a", isSidechain: true }),
  ]);
  save(join(project, "main", "subagents", "agent-legacy.jsonl"), [assistant("stream")]);
  save(join(project, "d-opus.jsonl"), [
    assistant("opus", { sessionId: "opus", message: { id: "opus", model: "claude-opus-5-5", usage, content: [] } }),
  ]);
  save(join(project, "c-unknown.jsonl"), [
    assistant("unknown", { sessionId: "unknown", message: { id: "unknown", model: "future-model", usage, content: [] } }),
    assistant("incomplete", { sessionId: "incomplete", message: { id: "incomplete", model: "claude-sonnet-5", usage: { output_tokens: 3 }, content: [] } }),
    assistant("ttl", { sessionId: "ttl", message: { id: "ttl", model: "claude-sonnet-5",
      usage: { ...usage, cache_creation: undefined }, content: [] } }),
    assistant("no-request", { sessionId: "no-request", requestId: undefined }),
  ]);
  return join(root, "projects");
}

test.skipIf(!existsSync(join(import.meta.dir, "..", "..", "bin", "analyze-transcripts.mjs")))("should match the independent transcript analyzer through actual indexing and queries", async () => {
  const root = mkdtempSync(join(tmpdir(), "dash-parity-")); roots.push(root);
  const projects = corpus(root);
  process.env.DASH_PROJECTS_DIR = projects;
  process.env.DASH_HANDOFFS_DIR = join(root, "handoffs");
  process.env.DASH_DB = join(root, "usage.db");
  process.env.DASH_COPILOT_ROOTS = "";
  const pricing = { source: "dash/prices.json: documented Claude Sonnet 5 USD/MTok; unknown TTL deliberately unpriced",
    asOf: "2026-11-06", models: { "claude-sonnet-5": {
      input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 0.2,
      cache_creation_5m_input_tokens: 2.5, cache_creation_1h_input_tokens: 4,
    }, "claude-opus-5-5": {
      input_tokens: 4, output_tokens: 20, cache_read_input_tokens: 0.2,
      cache_creation_5m_input_tokens: 5, cache_creation_1h_input_tokens: 8,
    } } };
  const pricingPath = join(root, "pricing.json");
  writeFileSync(pricingPath, JSON.stringify(pricing));
  const independent = JSON.parse(execFileSync("node", [join(import.meta.dir, "..", "..", "bin", "analyze-transcripts.mjs"),
    "--root", projects, "--pricing", pricingPath], { encoding: "utf8" })) as {
      logicalAssistantMessages: number; knownCostUsd: number; tokens: Record<string, number>;
      models: Record<string, { knownCostUsd: number; tokens: Record<string, number> }>;
    };
  const db = openDb();
  try {
    await runIndex(db);
    const report = usageReport(db, { harness: "claude" });
    const measured = db.query(`SELECT count(*) requests,sum(input) input,sum(output) output,sum(read) read,
      sum(write5m) five,sum(write1h) hour,sum(write_unknown) unknownTTL,sum(known_cost) known FROM requests`).get() as {
      requests: number; input: number; output: number; read: number; five: number; hour: number; unknownTTL: number; known: number;
    };
    expect(measured.requests).toBe(independent.logicalAssistantMessages);
    expect(measured.input).toBe(independent.tokens.input_tokens);
    expect(measured.output).toBe(independent.tokens.output_tokens);
    expect(measured.read).toBe(independent.tokens.cache_read_input_tokens);
    expect(measured.five).toBe(independent.tokens.cache_creation_5m_input_tokens);
    expect(measured.hour).toBe(independent.tokens.cache_creation_1h_input_tokens);
    expect(measured.unknownTTL).toBe(independent.tokens.cache_creation_unknown_input_tokens);
    expect(measured.known).toBeCloseTo(independent.knownCostUsd, 12);
    for (const group of report.models) {
      expect(group.cost ?? 0).toBeCloseTo(independent.models[group.model].knownCostUsd, 12);
    }
    expect(report.totals.cost).toBeCloseTo(independent.knownCostUsd, 12);
    expect(report.totals.unpriced).toBe(3);
    expect(report.sessions.map((s) => s.cost)).toEqual(report.sessions.map((s) => s.cost).sort((a, b) => (b ?? -1) - (a ?? -1)));
    const detail = sessionDetail("main", db) as { session: { turns: number; peak_context: number; title: string }; points: { output: number }[] };
    expect(detail.session).toMatchObject({ turns: 2, peak_context: 360, title: "Representative main session" });
    expect(detail.points.map((r) => r.output)).toEqual([30, 30]);
    expect(report.sessions.find((s) => s.session === "main/a")?.requests).toBe(1);
    expect(report.sessions.find((s) => s.session === "main/legacy")?.requests).toBe(1);
    expect(report.sessions.find((s) => s.session === "main")?.models).toEqual(["claude-sonnet-5"]);
    expect(report.sessions.find((s) => s.session === "main")?.provenance).toEqual(["claude_price_estimate"]);
    expect(overview("month", new Date("2026-11-06T00:00:00Z"), db).cost).toBeCloseTo(independent.knownCostUsd, 12);
    const legacy = sessions({}, {}, db) as { id: string; rolled_cost: number; total_cost: number }[];
    expect(legacy[0].id).toBe("main");
    expect(legacy.reduce((n, r) => n + (r.total_cost || 0), 0)).toBeCloseTo(independent.knownCostUsd, 12);
    expect((await runIndex(db)).newRequests).toBe(0);
    console.log(`Parity: ${measured.requests} logical messages; known USD ${measured.known.toFixed(8)}; independent ${independent.knownCostUsd.toFixed(8)}`);
  } finally { db.close(); }
});

test("should accumulate distinct opening deltas and exclude exact streamed or resumed replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "dash-opening-")); roots.push(root);
  process.env.DASH_PROJECTS_DIR = corpus(root);
  process.env.DASH_HANDOFFS_DIR = join(root, "handoffs");
  process.env.DASH_DB = join(root, "usage.db");
  process.env.DASH_COPILOT_ROOTS = "";
  const db = openDb();
  try {
    await runIndex(db);
    const rows = db.query("SELECT component,chars,tokens FROM opening WHERE session_id='main'").all() as { component: string; chars: number; tokens: number }[];
    const shapeChars = JSON.stringify({ name: "mcp__fixture__find", defer_loading: true }).length;
    expect(rows.find((r) => r.component === "deferred_tools")?.chars).toBe(shapeChars + "first tools".length + "distinct tools".length);
    expect(rows.reduce((n, r) => n + r.tokens, 0)).toBeCloseTo(360, 10);
  } finally { db.close(); }
});
