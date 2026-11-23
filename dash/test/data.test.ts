import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import { runIndex } from "../src/indexer";
import { requestCost } from "../src/pricing";
import { rebuildFlags } from "../src/flags";
import { agentKit, handoffCount, overview, sessionDetail } from "../src/queries";

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "usage-dash-"));
  roots.push(root);
  const projects = join(root, "projects");
  const handoffs = join(root, "handoffs");
  const project = join(projects, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(handoffs, { recursive: true });
  process.env.DASH_PROJECTS_DIR = projects;
  process.env.DASH_HANDOFFS_DIR = handoffs;
  process.env.DASH_DB = join(root, "usage.db");
  process.env.DASH_COPILOT_ROOTS = "";
  return { root, projects, handoffs, project, dbPath: process.env.DASH_DB };
}

afterEach(() => {
  delete process.env.DASH_PROJECTS_DIR;
  delete process.env.DASH_HANDOFFS_DIR;
  delete process.env.DASH_DB;
  delete process.env.DASH_COPILOT_ROOTS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function line(value: unknown) {
  return JSON.stringify(value) + "\n";
}

function assistant(sessionId: string, requestId: string, timestamp: string, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant", sessionId, requestId, timestamp, cwd: "C:\\repo", uuid: `${requestId}-uuid`,
    message: {
      model: "claude-sonnet-5", content: [],
      usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 4 },
    }, ...extra,
  };
}

describe("incremental index", () => {
  test("deduplicates request ids across repeated lines and files with first occurrence ownership", async () => {
    const { project, dbPath } = setup();
    const first = assistant("first-session", "same-request", "2026-01-01T00:00:00Z");
    writeFileSync(join(project, "a.jsonl"), line(first) + line(first));
    writeFileSync(join(project, "b.jsonl"), line(assistant("copied-session", "same-request", "2026-01-02T00:00:00Z")));
    const db = openDb(dbPath);
    const result = await runIndex(db);
    expect(result.newRequests).toBe(1);
    expect(db.query("SELECT session_id FROM requests WHERE request_id='same-request'").get()).toEqual({ session_id: "first-session" });
    const second = await runIndex(db);
    expect(second.newRequests).toBe(0);
    db.close();
  });

  test("indexes appended complete lines and retains a partial final line", async () => {
    const { project, dbPath } = setup();
    const path = join(project, "append.jsonl");
    const second = line(assistant("append-session", "request-two", "2026-01-01T00:01:00Z"));
    writeFileSync(path, line(assistant("append-session", "request-one", "2026-01-01T00:00:00Z")) + second.slice(0, 25));
    const db = openDb(dbPath);
    expect((await runIndex(db)).newRequests).toBe(1);
    expect(Number((db.query("SELECT count(*) n FROM requests").get() as any).n)).toBe(1);
    appendFileSync(path, second.slice(25));
    expect((await runIndex(db)).newRequests).toBe(1);
    expect(Number((db.query("SELECT count(*) n FROM requests").get() as any).n)).toBe(2);
    db.close();
  });

  test("reparses a file after truncation", async () => {
    const { project, dbPath } = setup();
    const path = join(project, "truncate.jsonl");
    writeFileSync(path, line(assistant("old-session", "old-long-request-identifier", "2026-01-01T00:00:00Z")) + line(assistant("old-session", "another-old-request", "2026-01-01T00:01:00Z")));
    const db = openDb(dbPath);
    await runIndex(db);
    writeFileSync(path, line(assistant("new", "new", "2026-01-01T00:00:00Z")));
    await runIndex(db);
    expect(db.query("SELECT request_id FROM requests ORDER BY request_id").all()).toEqual([{ request_id: "new" }]);
    db.close();
  });
});

test("prices 5m and 1h writes independently and leaves unknown models unpriced", () => {
  const usage = { input: 1_000_000, write5m: 1_000_000, write1h: 1_000_000, read: 1_000_000, output: 1_000_000, webSearch: 2 };
  expect(requestCost("claude-sonnet-5", usage)).toBeCloseTo(18.72, 8);
  expect(requestCost("claude-haiku-5-5", { input: 0, write5m: 0, write1h: 100_001, read: 0, output: 0, webSearch: 0 })).toBeCloseTo(0.100001, 8);
  expect(requestCost("future-model", usage)).toBeNull();
});

test("computes all four waste flag types", () => {
  const { dbPath } = setup();
  const db = openDb(dbPath);
  db.query("INSERT INTO sessions(id,kind) VALUES('flags','main')").run();
  const insert = db.query(`INSERT INTO requests(request_id,session_id,ts,model,input,write5m,write1h,read,output,thinking,web_search,context_total,cost) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 5; i++) insert.run(`past-${i}`, "flags", `2026-01-01T${String(i * 2).padStart(2, "0")}:00:00Z`, "claude-sonnet-5", 1, 0, i === 1 ? 30000 : 0, 210000, 1, 0, 0, 210001 + (i === 1 ? 30000 : 0), 1);
  db.query("INSERT INTO tool_results(session_id,ts,source_uuid,tool_name,mcp_server,token_est) VALUES('flags','2025-12-31T23:00:00Z','u','Read',NULL,12000)").run();
  db.query("INSERT INTO opening(session_id,component,name,chars,tokens) VALUES('flags','mcp:unused','unused',100,5000)").run();
  rebuildFlags(db);
  const types = (db.query("SELECT DISTINCT type FROM flags ORDER BY type").all() as any[]).map((x) => x.type);
  expect(types).toEqual(["cold_rebuild", "loaded_never_used", "oversized_tool_result", "ran_past_handoff"]);
  expect((db.query("SELECT min(amount) n FROM flags").get() as any).n).toBeGreaterThan(0);
  db.close();
});

test("windows avoidable cost by request time and handoffs by session start", () => {
  const { dbPath } = setup();
  const db = openDb(dbPath);
  db.query("INSERT INTO sessions(id,kind,started_at) VALUES('old','main','2026-01-01T00:00:00Z'),('new','main','2026-01-09T00:00:00Z')").run();
  db.query("UPDATE sessions SET continued_from_path='x.md' WHERE id IN ('old','new')").run();
  const insert = db.query(`INSERT INTO requests(request_id,session_id,ts,model,input,write5m,write1h,read,output,thinking,web_search,context_total,cost) VALUES(?,?,?,?,0,0,0,0,0,0,0,0,5)`);
  insert.run("old-early", "old", "2026-01-01T00:00:00Z", "claude-sonnet-5");
  insert.run("old-late", "old", "2026-01-09T00:00:00Z", "claude-sonnet-5");
  const flag = db.query("INSERT INTO flags(session_id,request_id,type,amount,token_amount) VALUES(?,?,?,?,0)");
  flag.run("old", "old-early", "cold_rebuild", 1);
  flag.run("old", "old-late", "cold_rebuild", 2);
  flag.run("old", null, "loaded_never_used", 4);
  flag.run("new", null, "loaded_never_used", 8);
  const report = overview("week", new Date("2026-01-10T00:00:00Z"), db) as any;
  expect(report.avoidable).toBe(10);
  expect(report.handoffs).toBe(1);
  db.close();
});

test("splits opening context by character share and stores end-of-first-prompt context", async () => {
  const { project, dbPath } = setup();
  const records = [
    { type: "user", sessionId: "opening", timestamp: "2026-01-01T00:00:00Z", cwd: "C:\\repo", message: { role: "user", content: "first" } },
    { type: "api-request-shape", sessionId: "opening", timestamp: "2026-01-01T00:00:01Z", shape: { system: [{ type: "text", text: "system" }], tools: [{ name: "Read", description: "builtin", input_schema: {} }, { name: "mcp__docs__find", description: "remote", input_schema: {} }] } },
    { type: "attachment", sessionId: "opening", timestamp: "2026-01-01T00:00:02Z", attachment: { type: "instructions" }, rendered: [{ content: "memory" }] },
    assistant("opening", "opening-one", "2026-01-01T00:00:03Z", { message: { model: "claude-sonnet-5", content: [], usage: { input_tokens: 10, cache_creation_input_tokens: 60, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 40 }, cache_read_input_tokens: 30, output_tokens: 1 } } }),
    { type: "user", sessionId: "opening", timestamp: "2026-01-01T00:01:00Z", cwd: "C:\\repo", message: { role: "user", content: "second" } },
    assistant("opening", "opening-two", "2026-01-01T00:01:01Z"),
  ];
  writeFileSync(join(project, "opening.jsonl"), records.map(line).join(""));
  const db = openDb(dbPath);
  await runIndex(db);
  const components = db.query("SELECT component,tokens FROM opening WHERE session_id='opening'").all() as any[];
  expect(components.map((x) => x.component).sort()).toEqual(["builtin_tools", "instructions", "mcp:docs", "system_prompt"]);
  expect(components.reduce((n, x) => n + x.tokens, 0)).toBeCloseTo(100, 8);
  expect((db.query("SELECT context_end_first FROM sessions WHERE id='opening'").get() as any).context_end_first).toBe(100);
  db.close();
});

test("links handoffs to writers and classifies main, subagent, and worker-probe sessions", async () => {
  const { project, dbPath } = setup();
  const target = join(tmpdir(), "tester", ".agent-handoffs", "handoff.md");
  const writer = assistant("writer", "writer-request", "2026-01-01T00:00:00Z", { message: { model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "write-1", name: "Write", input: { file_path: target } }] } });
  const continuation = { type: "user", sessionId: "continued", timestamp: "2026-01-02T00:00:00Z", cwd: "C:\\repo", message: { role: "user", content: `Read ${target} and continue from "Next step".` } };
  const worker = assistant("worker", "worker-request", "2026-01-03T00:00:00Z", { cwd: join(tmpdir(), "probe") });
  writeFileSync(join(project, "main.jsonl"), line(writer) + line(continuation) + line(assistant("continued", "continued-request", "2026-01-02T00:00:01Z")) + line(worker));
  const subdir = join(project, "sub-session", "subagents");
  mkdirSync(subdir, { recursive: true });
  writeFileSync(join(subdir, "agent.jsonl"), line(assistant("sub", "sub-request", "2026-01-04T00:00:00Z")));
  const db = openDb(dbPath);
  await runIndex(db);
  expect(handoffCount(db)).toBe(1);
  expect(db.query("SELECT continued_from_path,writer_session_id FROM sessions WHERE id='continued'").get()).toEqual({ continued_from_path: target, writer_session_id: "writer" });
  expect(db.query("SELECT id,kind FROM sessions WHERE id IN ('writer','sub/agent','worker') ORDER BY id").all()).toEqual([{ id: "sub/agent", kind: "subagent" }, { id: "worker", kind: "worker-probe" }, { id: "writer", kind: "main" }]);
  db.close();
});

test("indexes ledger verdicts and whitelists statusline numeric metadata", async () => {
  const { handoffs, dbPath } = setup();
  writeFileSync(join(handoffs, "ledger.jsonl"), [
    { type: "dispatch", run: "accepted-run", ts: "2026-01-01T00:00:00Z", harness: "claude", tier: "build", model: "m", cwd: "C:\\temp", session_id: "s", cost_usd: 3, duration_s: 4, status: "done" },
    { type: "verdict", run: "accepted-run", outcome: "accepted", ts: "2026-01-01T01:00:00Z" },
    { type: "dispatch", run: "unjudged-run", ts: "2026-01-02T00:00:00Z", harness: "claude", tier: "build", model: "m", cost_usd: 2, brief: "C:\\tasks\\fix-thing.md" },
    { type: "dispatch", run: "probe-run", ts: "2026-01-03T00:00:00Z", harness: "claude", tier: "chore", model: "m", brief: "C:\\Temp\\agent-kit-probe-1\\probe-claude-chore.md" },
  ].map(line).join(""));
  mkdirSync(join(handoffs, ".state"), { recursive: true });
  const status = `{ "ts": "2026-01-01", "model": "m", "cost": 1 }`;
  writeFileSync(join(handoffs, ".state", "statusline.jsonl"), status + "\n");
  const db = openDb(dbPath);
  await runIndex(db);
  const report = agentKit(db) as any;
  expect(report.jobs.map((x: any) => [x.run, x.name, x.outcome])).toEqual([["unjudged-run", "fix-thing", null], ["accepted-run", "Unnamed job", "accepted"]]);
  expect(report.probeCount).toBe(1);
  expect(JSON.parse((db.query("SELECT json FROM statusline").get() as any).json)).toMatchObject({ ts: "2026-01-01T00:00:00.000Z", model: "m", cost: 1 });
  db.close();
});

test("never writes prompt, assistant, or tool-result content into SQLite bytes", async () => {
  const { project, dbPath } = setup();
  cpSync(join(import.meta.dir, "fixtures", "privacy.jsonl"), join(project, "privacy.jsonl"));
  const db = openDb(dbPath);
  await runIndex(db);
  expect((sessionDetail("privacy-session", db) as any).results[0].token_est).toBeGreaterThan(0);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const bytes = readFileSync(dbPath).toString("utf8");
  expect(bytes).not.toContain("PROMPT_SECRET_NEVER_STORE");
  expect(bytes).not.toContain("ASSISTANT_SECRET_NEVER_STORE");
  expect(bytes).not.toContain("RESULT_SECRET_NEVER_STORE");
});

test("keeps subagent requests in their own session linked to the parent", async () => {
  const { project, dbPath } = setup();
  writeFileSync(join(project, "parent.jsonl"), line(assistant("parent", "parent-request", "2026-01-01T00:00:00Z")));
  const subdir = join(project, "parent", "subagents");
  mkdirSync(subdir, { recursive: true });
  writeFileSync(join(subdir, "agent-a1.jsonl"), line(assistant("parent", "sub-request", "2026-01-01T00:00:05Z", { agentId: "a1", isSidechain: true })));
  const db = openDb(dbPath);
  await runIndex(db);
  expect(db.query("SELECT id,parent_id,kind,turns FROM sessions ORDER BY id").all()).toEqual([
    { id: "parent", parent_id: null, kind: "main", turns: 1 },
    { id: "parent/a1", parent_id: "parent", kind: "subagent", turns: 1 },
  ]);
  db.close();
});

test("prices dated model ids with their base rates", () => {
  const usage = { input: 1_000_000, write5m: 0, write1h: 0, read: 0, output: 0, webSearch: 0 };
  expect(requestCost("claude-haiku-4-5-20251001", usage)).toBeCloseTo(1, 8);
});

test("estimates tool result tokens from the model-facing content, with a flat cost per image", async () => {
  const { project, dbPath } = setup();
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(500_000) } };
  const result = { type: "user", sessionId: "img", timestamp: "2026-01-01T00:00:01Z", sourceToolAssistantUUID: "x", toolUseResult: { type: "image", file: { base64: "A".repeat(500_000) } },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "a".repeat(1000) }, image] }] } };
  writeFileSync(join(project, "img.jsonl"), line(assistant("img", "img-request", "2026-01-01T00:00:00Z")) + line(result));
  const db = openDb(dbPath);
  await runIndex(db);
  expect((db.query("SELECT token_est FROM tool_results WHERE session_id='img'").get() as any).token_est).toBeCloseTo(1000 * 0.3 + 1600, 6);
  db.close();
});
