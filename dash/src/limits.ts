import type { Database } from "bun:sqlite";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { paths } from "./db";
import { environmentConfig, requireLocalPath, withEnvironments } from "./environments";

const windows = ["five_hour", "seven_day"] as const;
type Window = typeof windows[number];
type Measurement = { used: number; resetsAt: string };
type Sample = {
  ts: string; session: string | null; model: string | null; cost: number | null;
  context: Record<string, number>; limits: Partial<Record<Window, Measurement>>;
};
type Source = { status: "available" | "unavailable"; error?: string; malformed: number; duplicates: number; signature: string };
type Options = { environment?: string; harness?: "claude" | "copilot" | "all"; from?: string; to?: string };
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function timestamp(value: unknown): string | null {
  const parsed = typeof value === "number" ? value * (value < 1e12 ? 1000 : 1) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && Math.abs(parsed) <= 8.64e15 ? new Date(parsed).toISOString() : null;
}

function sample(value: unknown): Sample | null {
  const row = record(value);
  const ts = timestamp(row.ts);
  if (!ts) return null;
  const model = typeof row.model === "string" ? row.model : record(row.model).id;
  const context: Record<string, number> = {};
  const rawContext = record(row.context_window);
  for (const key of ["used_percentage", "remaining_percentage", "context_window_size", "total_input_tokens", "total_output_tokens"]) {
    const value = number(rawContext[key]);
    if (value != null) context[key] = value;
  }
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    const value = number(record(rawContext.current_usage)[key]);
    if (value != null) context[`current_${key}`] = value;
  }
  const limits: Sample["limits"] = {};
  for (const window of windows) {
    const raw = record(record(row.rate_limits)[window]);
    const used = number(raw.used_percentage);
    const resetsAt = timestamp(raw.resets_at);
    if (used != null && used <= 100 && resetsAt) limits[window] = { used, resetsAt };
  }
  return { ts, session: typeof row.session_id === "string" ? row.session_id : null,
    model: typeof model === "string" ? model : null,
    cost: number(row.cost) ?? number(record(row.cost).total_cost_usd), context, limits };
}

export async function indexLimits(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS limit_sources(environment TEXT PRIMARY KEY,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS limit_samples(environment TEXT NOT NULL,ts TEXT NOT NULL,json TEXT NOT NULL,fingerprint TEXT NOT NULL,
    PRIMARY KEY(environment,fingerprint)); CREATE INDEX IF NOT EXISTS limit_samples_time ON limit_samples(environment,ts)`);
  const config = environmentConfig();
  const configured = [config.current, ...config.others.filter((e) => e.statusline)];
  const retained = new Set(configured.map((e) => e.id));
  for (const row of db.query("SELECT environment FROM limit_sources").all() as { environment: string }[]) {
    if (!retained.has(row.environment)) db.transaction(() => {
      db.query("DELETE FROM limit_sources WHERE environment=?").run(row.environment);
      db.query("DELETE FROM limit_samples WHERE environment=?").run(row.environment);
    })();
  }
  let changed = false;
  for (const environment of configured) {
    const file = environment.statusline || join(paths().handoffs, ".state", "statusline.jsonl");
    requireLocalPath(file);
    const stat = existsSync(file) ? statSync(file) : null;
    const signature = JSON.stringify([file, stat?.dev, stat?.ino, stat?.birthtimeMs, stat?.size, stat?.mtimeMs]);
    const prior = db.query("SELECT json FROM limit_sources WHERE environment=?").get(environment.id) as { json: string } | null;
    const previous = prior ? JSON.parse(prior.json) as Source : null;
    if (previous?.signature === signature && !previous.error) continue;
    const state: Source = { status: stat ? "available" : "unavailable", malformed: 0, duplicates: 0, signature };
    const samples = new Map<string, Sample>();
    if (stat) {
      const stream = createReadStream(file, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          let value: unknown;
          try { value = JSON.parse(line); } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            state.malformed++; continue;
          }
          const safe = sample(value);
          if (!safe) { state.malformed++; continue; }
          const digest = createHash("sha256").update(JSON.stringify(safe)).digest("hex");
          if (samples.has(digest)) state.duplicates++;
          samples.set(digest, safe);
        }
      } catch (error) {
        state.status = "unavailable";
        state.error = `Cannot read local statusline: ${error instanceof Error ? error.message : String(error)}`;
        console.error(state.error);
        samples.clear();
      } finally { lines.close(); stream.destroy(); }
    }
    db.transaction(() => {
      db.query("DELETE FROM limit_samples WHERE environment=?").run(environment.id);
      const insert = db.query("INSERT INTO limit_samples(environment,ts,json,fingerprint) VALUES(?,?,?,?)");
      for (const [digest, value] of samples) insert.run(environment.id, value.ts, JSON.stringify(value), digest);
      db.query("INSERT OR REPLACE INTO limit_sources(environment,json) VALUES(?,?)").run(environment.id, JSON.stringify(state));
      if (environment.id === config.current.id) {
        db.run("DELETE FROM statusline");
        const status = db.query("INSERT INTO statusline(pos,json) VALUES(?,?)");
        let pos = 0;
        for (const value of samples.values()) status.run(pos++, JSON.stringify(value));
      }
    })();
    changed = true;
  }
  return changed;
}

function measure(samples: Sample[], window: Window) {
  let previous: (Measurement & { ts: string }) | null = null;
  let latest: (Measurement & { ts: string }) | null = null;
  let burn = 0, measuredHours = 0, validIntervals = 0, resets = 0, regressions = 0, missing = 0, expiredIntervals = 0, conflicts = 0;
  const observations = new Map<string, Measurement | null>();
  const conflicting = new Set<string>();
  for (const sample of samples) {
    const value = sample.limits[window];
    if (!value) missing++;
    const prior = observations.get(sample.ts);
    if (value && prior && (value.used !== prior.used || value.resetsAt !== prior.resetsAt)) conflicting.add(sample.ts);
    observations.set(sample.ts, conflicting.has(sample.ts) ? null : value || prior || null);
  }
  conflicts = conflicting.size;
  for (const [ts, value] of observations) {
    if (!value) { previous = null; if (conflicting.has(ts)) latest = null; continue; }
    const current = { ...value, ts };
    latest = current;
    if (previous) {
      const hours = (Date.parse(current.ts) - Date.parse(previous.ts)) / 3600000;
      if (previous.resetsAt !== current.resetsAt) resets++;
      else if (current.ts >= current.resetsAt || previous.ts >= previous.resetsAt) expiredIntervals++;
      else if (current.used < previous.used) regressions++;
      else {
        burn += current.used - previous.used;
        measuredHours += hours;
        validIntervals++;
      }
    }
    previous = current;
  }
  return { latest, burnPoints: validIntervals ? burn : null, pointsPerHour: measuredHours ? burn / measuredHours : null,
    measuredHours, validIntervals, resets, regressions, missing, expiredIntervals, conflicts };
}

export function limitReport(db: Database, options: Options = {}) {
  const from = options.from ? new Date(options.from).toISOString() : null;
  const to = options.to ? new Date(options.to).toISOString() : null;
  return withEnvironments(db, (sources, environments) => {
    const config = environmentConfig();
    const selected = options.environment || config.current.id;
    return {
      range: { from, to },
      policy: "Claude subscription observations, not USD or Copilot credits. Burn is percentage-point change only between adjacent valid samples in the same reset window. Resets, missing samples, regressions, conflicts and expired windows are excluded. Sparse samples cannot measure unobserved burn. No universal dollar conversion or model allocation is inferred.",
      environments: environments.filter((e) => selected === "all" || e.id === selected).map((environment) => {
        let sourceDb = db;
        let state: Source | null = null;
        const hasTable = (index: Database, table: string) => !!index.query("SELECT name FROM sqlite_master WHERE name=?").get(table);
        if (hasTable(db, "limit_sources")) {
          const row = db.query("SELECT json FROM limit_sources WHERE environment=?").get(environment.id) as { json: string } | null;
          state = row ? JSON.parse(row.json) : null;
        }
        let sourceId = environment.id;
        if (!state) {
          const external = sources.find((s) => s.environment.id === environment.id && !s.environment.current);
          if (external && hasTable(external.db, "limit_sources")) {
            sourceDb = external.db;
            const states = sourceDb.query("SELECT environment,json FROM limit_sources").all() as { environment: string; json: string }[];
            if (states.length === 1) { sourceId = states[0].environment; state = JSON.parse(states[0].json); }
          }
        }
        const rows = state && hasTable(sourceDb, "limit_samples") ? sourceDb.query(`SELECT json FROM limit_samples WHERE environment=?
          ${from ? "AND ts>=?" : ""} ${to ? "AND ts<?" : ""} ORDER BY ts,fingerprint`)
          .all(sourceId, ...[from, to].filter((v): v is string => !!v)) as { json: string }[] : [];
        const samples = options.harness === "copilot" ? [] : rows.map((r) => JSON.parse(r.json) as Sample);
        const measured = { five_hour: measure(samples, "five_hour"), seven_day: measure(samples, "seven_day") };
        const available = !!measured.five_hour.latest || !!measured.seven_day.latest;
        return { id: environment.id, label: environment.label, harness: "claude" as const,
          status: options.harness === "copilot" ? "unsupported" : state?.status === "available" && available ? "available" : "unavailable",
          error: state?.error || null, samples: samples.length, malformed: state?.malformed ?? 0, duplicates: state?.duplicates ?? 0,
          latest: samples.at(-1) || null, windows: measured };
      }),
    };
  });
}
export type LimitReport = ReturnType<typeof limitReport>;
