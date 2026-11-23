import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiHandler } from "../src/api";
import { openDb } from "../src/db";
import { indexCopilot } from "../src/copilot";

let root = "";
let db: Database;
let argv: string[][];
let api: ReturnType<typeof createApiHandler>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "usage-api-"));
  db = openDb(join(root, "usage.db"));
  await indexCopilot(db, []);
  db.query(`INSERT INTO sessions(id,title,project,cwd,kind,started_at,ended_at,turns,total_cost,peak_context,opening_total,context_end_first)
    VALUES('parent','Fixture','C:\\repo','C:\\repo','main','2026-11-05T00:00:00Z','2026-11-05T01:00:00Z',1,1.5,100,60,70)`).run();
  db.query("INSERT INTO requests(request_id,session_id,ts,model,input,write5m,write1h,read,output,thinking,web_search,context_total,cost) VALUES('request','parent','2026-11-05T00:00:01Z','claude-sonnet-5',10,20,0,30,4,0,0,60,1.5)").run();
  db.query("INSERT INTO opening(session_id,component,name,chars,tokens) VALUES('parent','system_prompt','',100,60)").run();
  db.query("INSERT INTO tool_calls(session_id,ts,name) VALUES('parent','2026-11-05T00:00:02Z','Read')").run();
  db.query("INSERT INTO tool_results(session_id,ts,tool_name,token_est) VALUES('parent','2026-11-05T00:00:03Z','Read',25)").run();
  db.query("INSERT INTO flags(session_id,request_id,type,amount) VALUES('parent','request','cold_rebuild',.5)").run();
  db.query("INSERT INTO sessions(id,parent_id,title,project,cwd,kind,started_at,ended_at,turns,total_cost,unpriced_requests,peak_context) VALUES('parent/a1','parent','Child','C:\\repo','C:\\repo','subagent','2026-11-05T00:10:00Z','2026-11-05T00:20:00Z',2,2,1,80)").run();
  db.query("INSERT INTO ledger_runs(run,ts,harness,tier,model,cost_usd) VALUES('known','2026-11-05T00:00:00Z','claude','build','m',2)").run();
  db.query("INSERT INTO sessions(id,title,kind,started_at,continued_from_path,writer_session_id) VALUES('continued','Continued','main','2026-11-05T02:00:00Z','C:\\handoff.md','parent')").run();
  argv = [];
  api = createApiHandler(db, async (args) => { argv.push(args); return { exitCode: 0 }; }, "C:\\repo");
});

test("session summaries nest subagents and roll their cost into the parent", async () => {
  const response = await api(new Request("http://127.0.0.1:4319/api/sessions?sort=cost"));
  const rows = (await response.json() as any).sessions;
  expect(rows.find((row: any) => row.id === "parent")).toMatchObject({ rolled_cost: 3.5, rolled_unpriced: 1, subagent_count: 1 });
  expect(rows.find((row: any) => row.id === "parent/a1")).toMatchObject({ parent_id: "parent", rolled_cost: 2 });
});

afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

describe("GET API shapes", () => {
  test.each([
    ["/api/overview?range=week", ["range", "cost", "tokens", "daily", "worst"]],
    ["/api/sessions?sort=cost", ["sessions"]],
    ["/api/sessions/parent", ["session", "points", "opening", "results", "calls", "subagents"]],
    ["/api/opening", ["rows"]],
    ["/api/agent-kit", ["period", "cards", "rows", "charts", "changes", "jobs", "probeCount"]],
    ["/api/agent-kit?baseline=14d", ["period", "cards", "rows", "charts", "changes", "jobs", "probeCount"]],
    ["/api/handoffs", ["handoffs"]],
    ["/api/usage?harness=claude", ["totals", "coverage", "comparison", "models", "sessions"]],
    ["/api/usage/sessions/claude%3Aparent", ["totals", "points", "breakdowns", "tools"]],
    ["/api/environment", ["current", "defaultHarness", "environments"]],
  ])("returns %s", async (path, keys) => {
    const response = await api(new Request(`http://127.0.0.1:4319${path}`));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    for (const key of keys) expect(body).toHaveProperty(key);
  });

  test.each([
    "/api/usage?harness=invalid", "/api/usage?baseline=invalid", "/api/usage?from=invalid",
    "/api/usage?from=2026-11-06&to=2026-11-01",
    "/api/usage?from=2026-11-03&boundary=2026-11-01",
    "/api/usage?environment=unknown",
  ])("should reject invalid usage filters: %s", async (path) => {
    expect((await api(new Request(`http://127.0.0.1:4319${path}`))).status).toBe(400);
  });
});

test("verdict rejects unknown runs", async () => {
  const response = await api(new Request("http://127.0.0.1:4319/api/verdict", { method: "POST", headers: { origin: "http://127.0.0.1:4319", "content-type": "application/json" }, body: JSON.stringify({ run: "unknown", outcome: "accepted" }) }));
  expect(response.status).toBe(404);
  expect(argv).toHaveLength(0);
});

test("verdict rejects a non-local Origin", async () => {
  const response = await api(new Request("http://127.0.0.1:4319/api/verdict", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ run: "known", outcome: "accepted" }) }));
  expect(response.status).toBe(403);
  expect(argv).toHaveLength(0);
});

test("verdict passes an argv array to the runner", async () => {
  const response = await api(new Request("http://127.0.0.1:4319/api/verdict", { method: "POST", headers: { origin: "http://localhost:4319", "content-type": "application/json" }, body: JSON.stringify({ run: "known", outcome: "rework" }) }));
  expect(response.status).toBe(200);
  expect(argv).toEqual([["pwsh", "-NoProfile", "-File", join("C:\\repo", "bin", "verdict.ps1"), "-Run", "known", "-Outcome", "rework"]]);
});

test("rejects requests whose Host is not local (DNS rebinding)", async () => {
  const response = await api(new Request("http://127.0.0.1:4319/api/overview", { headers: { host: "evil.example:4319" } }));
  expect(response.status).toBe(403);
});

test("should serve consistent GET snapshots from a read-only HTTP connection", async () => {
  const reader = new Database(join(root, "usage.db"), { readonly: true });
  try {
    const handler = createApiHandler(reader, async () => ({ exitCode: 0 }));
    const response = await handler(new Request("http://127.0.0.1:4319/api/usage?harness=claude"));
    expect(response.status).toBe(200);
    expect((await response.json()).totals).toMatchObject({ requests: 1, cost: 1.5 });
  } finally { reader.close(); }
});
