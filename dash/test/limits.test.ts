import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { runIndex } from "../src/indexer";
import { limitReport } from "../src/limits";
import { createApiHandler } from "../src/api";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { LimitPanel } from "../src/ui/limits";
import { environmentConfig } from "../src/environments";

const roots: string[] = [];
afterEach(() => {
  for (const key of ["DASH_PROJECTS_DIR", "DASH_HANDOFFS_DIR", "DASH_DB", "DASH_COPILOT_ROOTS", "DASH_ENVIRONMENTS_FILE", "DASH_ENVIRONMENT"]) delete process.env[key];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "dash-limits-")); roots.push(root);
  const handoffs = join(root, "handoffs");
  mkdirSync(join(handoffs, ".state"), { recursive: true });
  process.env.DASH_PROJECTS_DIR = join(root, "no-projects");
  process.env.DASH_HANDOFFS_DIR = handoffs;
  process.env.DASH_DB = join(root, "usage.db");
  process.env.DASH_COPILOT_ROOTS = "";
  return { root, path: join(handoffs, ".state", "statusline.jsonl"), db: openDb() };
}
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row) + "\n").join("");
function sample(hour: number, five: number, seven: number, reset = "2026-11-05T15:00:00Z") {
  return {
    ts: `2026-11-05T${String(hour).padStart(2, "0")}:00:00Z`, session_id: `s-${hour}`, model: { id: "claude-sonnet-5" },
    cost: { total_cost_usd: hour / 10 }, context_window: { used_percentage: hour, total_input_tokens: 100 },
    rate_limits: { five_hour: { used_percentage: five, resets_at: reset },
      seven_day: { used_percentage: seven, resets_at: "2026-11-10T00:00:00Z" } },
    prompt: "PRIVATE_STATUS_PROMPT", arbitrary: { secret: "PRIVATE_STATUS_SECRET" },
  };
}

test("should distinguish absent or sparse limit data from a measured zero", async () => {
  const { path, db } = setup();
  try {
    await runIndex(db);
    expect(limitReport(db).environments[0].status).toBe("unavailable");
    const unavailable = renderToStaticMarkup(createElement(LimitPanel, { data: limitReport(db) }));
    expect(unavailable).toContain("Missing data is not 0%");
    writeFileSync(path, jsonl([sample(10, 0, 0)]));
    await runIndex(db);
    const report = limitReport(db).environments[0];
    expect(report.status).toBe("available");
    expect(report.windows.five_hour.latest?.used).toBe(0);
    expect(report.windows.five_hour.burnPoints).toBeNull();
    expect(report.windows.five_hour.validIntervals).toBe(0);
  } finally { db.close(); }
});

test("should not choose a quota winner at conflicting timestamps or reuse a seven-day reset", async () => {
  const { path, db } = setup();
  const third = sample(12, 30, 2);
  third.rate_limits.seven_day.resets_at = "2026-11-17T00:00:00Z";
  const fourth = sample(13, 35, 4);
  fourth.rate_limits.seven_day.resets_at = "2026-11-17T00:00:00Z";
  writeFileSync(path, jsonl([sample(10, 20, 40), sample(11, 25, 42), third,
    fourth, { ...fourth, rate_limits: { ...fourth.rate_limits, five_hour: { ...fourth.rate_limits.five_hour, used_percentage: 40 } }, session_id: "conflicting-session" },
    { ...fourth, session_id: "third-session" }]));
  try {
    await runIndex(db);
    const report = limitReport(db).environments[0];
    expect(report.windows.five_hour).toMatchObject({ burnPoints: 10, validIntervals: 2, conflicts: 1, latest: null });
    expect(report.windows.seven_day).toMatchObject({ burnPoints: 4, validIntervals: 2, resets: 1 });
  } finally { db.close(); }
});

test("should accept numeric reset timestamps and label measured flat burn as zero", async () => {
  const { path, db } = setup();
  const first = sample(10, 0, 0), second = sample(11, 0, 0);
  const numeric = [first, second].map((row) => ({ ...row, rate_limits: {
    five_hour: { used_percentage: 0, resets_at: Date.parse(row.rate_limits.five_hour.resets_at) / 1000 },
  } }));
  writeFileSync(path, jsonl(numeric));
  try {
    await runIndex(db);
    expect(limitReport(db).environments[0].windows.five_hour).toMatchObject({ burnPoints: 0, pointsPerHour: 0, validIntervals: 1 });
    rmSync(path);
    await runIndex(db);
    expect(limitReport(db).environments[0].status).toBe("unavailable");
    expect(limitReport(db).environments[0].samples).toBe(0);
  } finally { db.close(); }
});

test("should measure each window independently without treating resets or gaps as burn", async () => {
  const { path, db } = setup();
  const rows = [sample(10, 20, 40), sample(11, 25, 42), sample(12, 2, 44, "2026-11-05T17:00:00Z"),
    { ...sample(13, 3, 45, "2026-11-05T17:00:00Z"), rate_limits: {} },
    sample(14, 4, 48, "2026-11-05T17:00:00Z")];
  writeFileSync(path, jsonl([rows[0], rows[0], ...rows.slice(1)]) + "{bad}\n");
  try {
    await runIndex(db);
    const report = limitReport(db).environments[0];
    expect(report.samples).toBe(5);
    expect(report.duplicates).toBe(1);
    expect(report.malformed).toBe(1);
    expect(report.windows.five_hour).toMatchObject({ burnPoints: 5, pointsPerHour: 5, validIntervals: 1, resets: 1, missing: 1, measuredHours: 1 });
    expect(report.windows.seven_day).toMatchObject({ burnPoints: 4, pointsPerHour: 2, validIntervals: 2, resets: 0, missing: 1, measuredHours: 2 });
    expect(report.latest).toMatchObject({ model: "claude-sonnet-5", cost: 1.4, context: { used_percentage: 14, total_input_tokens: 100 } });
    const before = readFileSync(path);
    await runIndex(db);
    expect(readFileSync(path)).toEqual(before);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(readFileSync(process.env.DASH_DB!).toString()).not.toContain("PRIVATE_STATUS_");
    const api = createApiHandler(db, async () => ({ exitCode: 0 }));
    const response = await api(new Request("http://127.0.0.1:4319/api/limits?harness=claude"));
    expect(response.status).toBe(200);
    expect((await response.json()).environments[0].windows.five_hour.burnPoints).toBe(5);
  } finally { db.close(); }
});

test("should retain regressions, expired windows and filtered single-sample coverage honestly", async () => {
  const { path, db } = setup();
  writeFileSync(path, jsonl([sample(10, 30, 50), sample(11, 20, 52), sample(16, 40, 54)]));
  try {
    await runIndex(db);
    const full = limitReport(db).environments[0].windows.five_hour;
    expect(full.burnPoints).toBeNull();
    expect(full.regressions).toBe(1);
    expect(full.expiredIntervals).toBe(1);
    const selected = limitReport(db, { from: "2026-11-05T11:00:00Z", to: "2026-11-05T12:00:00Z" }).environments[0];
    expect(selected.samples).toBe(1);
    expect(selected.windows.seven_day.burnPoints).toBeNull();
  } finally { db.close(); }
});

test("should keep environments and harnesses separate with optional read-only statusline sources", async () => {
  const { root, path, db } = setup();
  const other = join(root, "personal-status.jsonl");
  const config = join(root, "environments.json");
  writeFileSync(other, jsonl([sample(10, 70, 10), sample(11, 80, 11)]));
  writeFileSync(path, jsonl([sample(10, 10, 30), sample(11, 12, 31)]));
  const configText = JSON.stringify([{ id: "personal", label: "Personal", statusline: "personal-status.jsonl" }, { id: "missing", label: "Missing" }]);
  writeFileSync(config, configText);
  process.env.DASH_ENVIRONMENTS_FILE = config;
  const bytes = readFileSync(other);
  try {
    await runIndex(db);
    const report = limitReport(db, { environment: "all", harness: "all" });
    expect(report.environments.map((e) => [e.id, e.harness, e.windows.five_hour.burnPoints])).toEqual([
      ["local", "claude", 2], ["personal", "claude", 10], ["missing", "claude", null],
    ]);
    expect(limitReport(db, { harness: "copilot" }).environments[0].status).toBe("unsupported");
    expect(limitReport(db, { environment: "personal" }).environments[0].windows.five_hour.latest?.used).toBe(80);
    expect(readFileSync(other)).toEqual(bytes);
    expect(readFileSync(config, "utf8")).toBe(configText);
    appendFileSync(other, jsonl([sample(12, 90, 12)]));
    await runIndex(db);
    expect(limitReport(db, { environment: "personal" }).environments[0].windows.five_hour.burnPoints).toBe(20);
  } finally { db.close(); }
});

test("should reject network statusline sources before attempting any source IO", () => {
  const { root, db } = setup();
  const config = join(root, "environments.json");
  process.env.DASH_ENVIRONMENTS_FILE = config;
  try {
    for (const statusline of ["https://example.invalid/statusline.jsonl", "\\\\server\\share\\statusline.jsonl"]) {
      writeFileSync(config, JSON.stringify([{ id: "remote", label: "Not local", statusline }]));
      expect(() => environmentConfig()).toThrow("must be local files");
    }
  } finally { db.close(); }
});
