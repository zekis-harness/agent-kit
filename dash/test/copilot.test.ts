import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { indexCopilot } from "../src/copilot";
import { usageReport } from "../src/usage";
import { environmentInfo } from "../src/environments";
import { overview } from "../src/queries";

const temporary: string[] = [];
afterEach(() => {
  delete process.env.DASH_ENVIRONMENTS_FILE;
  delete process.env.DASH_ENVIRONMENT;
  delete process.env.DASH_DEFAULT_HARNESS;
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "copilot-dash-"));
  temporary.push(root);
  const home = join(root, "copilot");
  const dir = join(home, "session-state", "s1");
  mkdirSync(dir, { recursive: true });
  return { root, home, file: join(dir, "events.jsonl"), db: openDb(join(root, "usage.db")) };
}
const line = (value: unknown) => JSON.stringify(value) + "\n";
const start = { type: "session.start", id: "start", timestamp: "2026-11-01T10:00:00Z", data: { sessionId: "s1" } };
function usage(id: string, cost = 1e11, timestamp = "2026-11-01T10:01:00Z") {
  return { type: "session.usage_record", id: `event-${id}`, timestamp, data: { usage: {
    model: "test-model", inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 30,
    outputTokens: 10, duration: 1000, cost: 2, accounting: { sourceSessionId: "s1", usageId: id, sequence: Number(id) },
    copilotUsage: { totalNanoAiu: cost }, toolCounts: { Read: 1 }, aiCreditsStatus: "complete",
  } } };
}

test("should deduplicate durable usage across roots, resumes and forked copies, not sum checkpoints", async () => {
  const { root, home, file, db } = setup();
  const data = line(start) + line(usage("1")) +
    line({ type: "session.shutdown", id: "old", data: { totalNanoAiu: 9e11, systemTokens: 20, toolDefinitionsTokens: 30, currentTokens: 100 } }) +
    line({ type: "session.shutdown", id: "new", data: { accountingSnapshot: { totalNanoAiu: 12e11 } } });
  writeFileSync(file, data);
  const copy = join(root, "copy", "session-state", "fork");
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, "events.jsonl"), data);
  await indexCopilot(db, [home, home, join(root, "copy")]);
  const report = usageReport(db, { harness: "copilot" });
  expect(report.totals.requests).toBe(1);
  expect(report.totals.cost).toBe(1);
  expect(report.sessions[0].context).toBe(100);
  expect(report.coverage?.snapshotCost).toBe(12);
  expect(report.coverage?.snapshotSum).toBe(21);
  expect(report.coverage?.snapshots).toBe(2);
  expect(report.coverage?.billingPolicy).toContain("not added");
  expect((await indexCopilot(db, [home, join(root, "copy")])).bytesRead).toBe(0);
  db.close();
});

test("should retain partial lines, append incrementally and invalidate same-size rewrites and truncations", async () => {
  const { home, file, db } = setup();
  const second = line(usage("2", 2e11));
  writeFileSync(file, line(start) + line(usage("1")) + second.slice(0, 40));
  await indexCopilot(db, [home]);
  expect(usageReport(db, {}).totals.requests).toBe(1);
  appendFileSync(file, second.slice(40));
  const appended = await indexCopilot(db, [home]);
  expect(appended.bytesRead).toBeLessThan(1000);
  expect(usageReport(db, {}).totals.cost).toBe(3);
  writeFileSync(file, line(start) + line(usage("3", 3e11)) + line(usage("4", 4e11)));
  await indexCopilot(db, [home]);
  expect(usageReport(db, {}).totals.cost).toBe(7);
  writeFileSync(file, line(start));
  await indexCopilot(db, [home]);
  expect(usageReport(db, {}).totals.cost).toBeNull();
  db.close();
});

test("should expose missing billing and ignore transcript content in persistent index", async () => {
  const { home, file, db } = setup();
  const event = usage("1");
  delete (event.data.usage as Partial<typeof event.data.usage>).copilotUsage;
  writeFileSync(file, line(start) + line(event) + line({ type: "user.message", data: { content: "PRIVATE_SENTINEL" } }));
  await indexCopilot(db, [home]);
  const report = usageReport(db, { harness: "copilot" });
  expect(report.totals.cost).toBeNull();
  expect(report.totals.unpriced).toBe(1);
  expect(report.totals.cacheRead).toBe(60);
  expect(JSON.stringify(db.query("SELECT * FROM copilot_events").all())).not.toContain("PRIVATE_SENTINEL");
  db.close();
});

test("should read SQLite read-only, deduplicate reimports and prefer durable records for overlapping sessions", async () => {
  const { home, file, db } = setup();
  const source = new Database(join(home, "session-store.db"));
  source.exec(`CREATE TABLE assistant_usage_events(id INTEGER PRIMARY KEY,session_id TEXT,turn_index INTEGER,
    agent_id TEXT,parent_tool_call_id TEXT,model TEXT,input_tokens INTEGER,output_tokens INTEGER,
    cache_read_tokens INTEGER,cache_write_tokens INTEGER,total_nano_aiu INTEGER,request_multiplier REAL,
    duration_ms REAL,created_at TEXT)`);
  source.exec(`INSERT INTO assistant_usage_events VALUES
    (1,'historic',1,NULL,NULL,'test-model',100,10,60,30,200000000000,2,1000,'2026-10-01T10:00:00Z'),
    (2,'historic',1,NULL,NULL,'test-model',100,10,60,30,200000000000,2,1000,'2026-10-01T10:00:00Z'),
    (3,'s1',1,NULL,NULL,'test-model',100,10,60,30,100000000000,2,1000,'2026-11-01T10:01:00.001Z')`);
  source.close();
  writeFileSync(file, line(start) + line(usage("1")));
  await indexCopilot(db, [home]);
  const report = usageReport(db, { harness: "copilot", boundary: "2026-11-01T00:00:00Z" });
  expect(report.totals.cost).toBe(3);
  expect(report.totals.requests).toBe(2);
  expect(report.coverage?.sqliteDuplicates).toBe(1);
  expect(report.coverage?.sqliteOverlapRows).toBe(1);
  expect(report.comparison?.before.requests).toBe(1);
  expect(report.comparison?.after.requests).toBe(1);
  await indexCopilot(db, [home]);
  expect(usageReport(db, {}).totals.cost).toBe(3);
  db.close();
});

test("should leave an unknown Copilot rollout unset and apply explicit half-open date ranges", async () => {
  const { home, file, db } = setup();
  writeFileSync(file, line(start) + line(usage("1")) + line(usage("2", 2e11, "2026-11-03T10:00:00Z")));
  await indexCopilot(db, [home]);
  expect(usageReport(db, { harness: "copilot" }).comparison).toBeNull();
  const report = usageReport(db, { harness: "copilot", from: "2026-11-02T00:00:00Z", to: "2026-11-04T00:00:00Z", boundary: "2026-11-03T00:00:00Z" });
  expect(report.totals.cost).toBe(2);
  expect(report.comparison?.before.cost).toBeNull();
  expect(report.comparison?.after.costPerRequest).toBe(2);
  db.close();
});

test("should remove configured-out sources and preserve malformed-line coverage on the next scan", async () => {
  const { home, file, db } = setup();
  writeFileSync(file, line(start) + line(usage("1")) + "{invalid}\n");
  await indexCopilot(db, [home]);
  expect(usageReport(db, {}).coverage?.malformed).toBe(1);
  await indexCopilot(db, [home]);
  expect(usageReport(db, {}).coverage?.malformed).toBe(1);
  await indexCopilot(db, []);
  expect(usageReport(db, {}).totals.requests).toBe(0);
  db.close();
});

test("should not choose a silent billing winner for conflicting durable identities", async () => {
  const { home, file, db } = setup();
  writeFileSync(file, line(start) + line(usage("1")) + line(usage("1", 2e11)));
  await indexCopilot(db, [home]);
  const report = usageReport(db, {});
  expect(report.totals.requests).toBe(1);
  expect(report.totals.cost).toBeNull();
  expect(report.coverage?.conflictingRecords).toBe(1);
  db.close();
});

test("should keep Claude and Copilot identities and billing bases separate", async () => {
  const { home, file, db } = setup();
  writeFileSync(file, line(start) + line(usage("1")));
  await indexCopilot(db, [home]);
  db.exec(`INSERT INTO requests(request_id,session_id,ts,model,input,write5m,write1h,read,output,thinking,web_search,context_total,cost) VALUES('1','s1','2026-11-01T10:01:00Z','claude-sonnet-5',10,20,0,30,4,0,0,60,0.5)`);
  const report = usageReport(db, { harness: "all" });
  expect(report.totals.requests).toBe(2);
  expect(report.totals.cost).toBe(1.5);
  expect(report.sessions.map((s) => s.id).sort()).toEqual(["local:claude:s1", "local:copilot:s1"]);
  expect(usageReport(db, { harness: "claude" }).totals.cost).toBe(0.5);
  expect(usageReport(db, { model: "test-model" }).availableModels).toHaveLength(2);
  db.close();
});

test("should preserve legacy Claude defaults and isolate read-only personal indexes and rollout dates", async () => {
  const { root, home, file, db } = setup();
  writeFileSync(file, line(start) + line(usage("1")));
  await indexCopilot(db, [home]);
  const insertClaude = (target: Database, id: string, cost: number) => target.query(`INSERT INTO requests(request_id,session_id,ts,model,input,write5m,write1h,read,output,thinking,web_search,context_total,cost) VALUES(?,?,'2026-11-01T10:01:00Z','claude-sonnet-5',10,20,0,30,4,0,0,60,?)`).run(id, "claude-session", cost);
  insertClaude(db, "shared", 0.5);
  const legacy = overview("month", new Date("2026-11-06T00:00:00Z"), db);
  const personalPath = join(root, "personal.db");
  const personal = openDb(personalPath);
  insertClaude(personal, "shared", 0.5);
  insertClaude(personal, "personal-only", 2);
  personal.close();
  const original = readFileSync(personalPath);
  const configPath = join(root, "environments.json");
  writeFileSync(configPath, JSON.stringify([
    { id: "personal", label: "Personal", index: personalPath, claudeBoundary: "2026-10-01T00:00:00Z" },
    { id: "unavailable", label: "Not on this machine" },
  ]));
  process.env.DASH_ENVIRONMENTS_FILE = configPath;
  expect(environmentInfo().defaultHarness).toBe("claude");
  expect(overview("month", new Date("2026-11-06T00:00:00Z"), db)).toEqual(legacy);
  expect(usageReport(db, { harness: "claude" }).totals.cost).toBe(0.5);
  expect(usageReport(db, { harness: "copilot" }).totals.cost).toBe(1);
  const combined = usageReport(db, { environment: "all", harness: "all" });
  expect(combined.totals.requests).toBe(3);
  expect(combined.totals.cost).toBe(3.5);
  expect(combined.duplicateCopies).toBe(1);
  expect(usageReport(db, { environment: "personal", harness: "claude" }).boundary).toBe("2026-10-01T00:00:00.000Z");
  expect(usageReport(db, { environment: "personal", harness: "copilot" }).boundary).toBeNull();
  expect(usageReport(db, { environment: "unavailable" }).totals.cost).toBeNull();
  expect(readFileSync(personalPath)).toEqual(original);
  db.close();
});

test("should read newly appended SQLite WAL rows without writing to the source", async () => {
  const { home, db } = setup();
  const source = new Database(join(home, "session-store.db"));
  source.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE assistant_usage_events(id INTEGER PRIMARY KEY,session_id TEXT,model TEXT,total_nano_aiu INTEGER,created_at TEXT);
    INSERT INTO assistant_usage_events VALUES(1,'wal','test',100000000000,'2026-11-01T10:00:00Z')`);
  await indexCopilot(db, [home]);
  expect(usageReport(db, {}).totals.cost).toBe(1);
  source.exec("INSERT INTO assistant_usage_events VALUES(2,'wal','test',200000000000,'2026-11-01T10:01:00Z')");
  await indexCopilot(db, [home]);
  expect(usageReport(db, {}).totals.cost).toBe(3);
  expect(source.query("SELECT count(*) n FROM assistant_usage_events").get()).toEqual({ n: 2 });
  source.close();
  db.close();
});

test("should reject network index configuration instead of opening a remote source", () => {
  const { root, db } = setup();
  const config = join(root, "environments.json");
  writeFileSync(config, JSON.stringify([{ id: "remote", label: "Remote", index: "\\\\server\\share\\usage.db" }]));
  process.env.DASH_ENVIRONMENTS_FILE = config;
  expect(() => environmentInfo()).toThrow("not network paths");
  db.close();
});
