import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, openSync, closeSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import config from "../config.json";
import { expandHome } from "./db";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown) => typeof value === "string" ? value : null;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const iso = (value: unknown) => {
  const parsed = typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

export type CopilotCall = {
  id: string; session: string; ts: string | null; model: string;
  input: number | null; output: number | null; read: number | null; write: number | null;
  nano: number | null; premium: number | null; duration: number | null; reasoning: number | null;
  status: string | null; tools: Record<string, number>; provenance: "usage_record" | "usage_sqlite";
  sourceSession?: string | null;
};
type IndexedEvent = {
  id: string; session: string; ts: string | null; kind: string; call?: CopilotCall;
  nano?: number | null; system?: number | null; tools?: number | null; context?: number | null;
  status?: string | null;
};
type FileState = { path: string; size: number; mtime: number; offset: number; identity: string; guard: string; errors: number };

export function copilotRoots() {
  const configured = process.env.DASH_COPILOT_ROOTS;
  return configured !== undefined ? configured.split(";").filter(Boolean) :
    [process.env.COPILOT_HOME, ...config.sources.copilotHomes.map(expandHome)].filter((x): x is string => !!x);
}

function schema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copilot_files(
      path TEXT PRIMARY KEY,size INTEGER,mtime REAL,offset INTEGER,identity TEXT,guard TEXT,errors INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS copilot_events(
      source TEXT,pos INTEGER,event_id TEXT,session_id TEXT,kind TEXT,json TEXT,PRIMARY KEY(source,pos)
    );
    CREATE INDEX IF NOT EXISTS copilot_events_id ON copilot_events(event_id);
    CREATE TABLE IF NOT EXISTS copilot_sqlite(
      source TEXT,row_id INTEGER,fingerprint TEXT,json TEXT,PRIMARY KEY(source,row_id)
    );
    CREATE TABLE IF NOT EXISTS copilot_calls(
      id TEXT PRIMARY KEY,session_id TEXT,ts TEXT,model TEXT,input REAL,output REAL,read REAL,
      write REAL,nano REAL,premium REAL,duration REAL,reasoning REAL,status TEXT,tools TEXT,provenance TEXT
    );
    CREATE INDEX IF NOT EXISTS copilot_calls_session ON copilot_calls(session_id,ts);
    CREATE TABLE IF NOT EXISTS copilot_meta(key TEXT PRIMARY KEY,json TEXT);
  `);
  if (!(db.query("PRAGMA table_info(copilot_files)").all() as { name: string }[]).some((c) => c.name === "errors")) {
    db.exec("ALTER TABLE copilot_files ADD COLUMN errors INTEGER DEFAULT 0");
  }
  const version = db.query("SELECT json FROM copilot_meta WHERE key='parser'").get() as { json: string } | null;
  if (version?.json !== "1") {
    db.exec("DELETE FROM copilot_files; DELETE FROM copilot_events; DELETE FROM copilot_sqlite; DELETE FROM copilot_meta;");
    db.query("INSERT INTO copilot_meta VALUES('parser','1')").run();
  }
}

function parseEvent(line: string, session: string, pos: number): IndexedEvent | null {
  const e = object(JSON.parse(line));
  const data = object(e.data);
  const kind = text(e.type);
  const ts = iso(e.timestamp);
  const id = text(e.id) || hash(line);
  if (kind === "session.start") return { id, session: text(data.sessionId) || session, ts, kind };
  if (kind === "session.usage_record") {
    const u = object(data.usage);
    const accounting = object(u.accounting);
    const billing = object(u.copilotUsage);
    const tools: Record<string, number> = {};
    for (const [name, count] of Object.entries(object(u.toolCounts))) {
      if (number(count) != null) tools[name] = Number(count);
    }
    return { id, session, ts, kind, call: {
      id: text(accounting.usageId) || text(u.apiCallId) || id || `${session}:${pos}`,
      session, ts, model: text(u.model) || "unknown",
      input: number(u.inputTokens), output: number(u.outputTokens), read: number(u.cacheReadTokens),
      write: number(u.cacheWriteTokens), nano: number(billing.totalNanoAiu), premium: number(u.cost),
      duration: number(u.duration), reasoning: number(u.reasoningTokens), status: text(u.aiCreditsStatus),
      sourceSession: text(accounting.sourceSessionId),
      tools, provenance: "usage_record",
    } };
  }
  if (kind === "session.shutdown" || kind === "session.usage_checkpoint") {
    const snapshot = object(data.accountingSnapshot);
    return { id, session, ts, kind, nano: number(snapshot.totalNanoAiu ?? data.totalNanoAiu),
      status: text(snapshot.aiCreditsStatus), system: number(data.systemTokens),
      tools: number(data.toolDefinitionsTokens), context: number(data.currentTokens) };
  }
  return null;
}

function guard(fd: number, offset: number) {
  const head = Buffer.alloc(Math.min(2048, offset));
  const tail = Buffer.alloc(Math.min(2048, offset));
  readSync(fd, head, 0, head.length, 0);
  readSync(fd, tail, 0, tail.length, Math.max(0, offset - tail.length));
  return hash(Buffer.concat([head, tail]));
}

async function indexFile(db: Database, path: string) {
  const stat = statSync(path);
  const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  let state = db.query("SELECT * FROM copilot_files WHERE path=?").get(path) as FileState | null;
  const fd = openSync(path, "r");
  let bytesRead = 0, malformed = 0;
  try {
    const reset = state && (process.env.DASH_COPILOT_RESCAN === "1" || stat.size < state.size ||
      state.identity !== identity || guard(fd, state.offset) !== state.guard ||
      (stat.size === state.size && stat.mtimeMs !== state.mtime));
    if (reset) {
      db.query("DELETE FROM copilot_events WHERE source=?").run(path);
      state = null;
    }
    let offset = state?.offset || 0;
    if (state && stat.size === state.size && stat.mtimeMs === state.mtime) return { bytesRead, malformed };
    const sid = basename(resolve(path, ".."));
    let session = (db.query("SELECT session_id FROM copilot_events WHERE source=? AND kind='session.start' ORDER BY pos LIMIT 1").get(path) as { session_id: string } | null)?.session_id || sid;
    const insert = db.query("INSERT OR REPLACE INTO copilot_events VALUES(?,?,?,?,?,?)");
    // Bounded reads avoid holding a GB history in memory. Only complete lines advance the cursor.
    while (offset < stat.size) {
      const buffer = Buffer.alloc(Math.min(4 * 1024 * 1024, stat.size - offset));
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      if (read === 0) break;
      bytesRead += read;
      const end = buffer.subarray(0, read).lastIndexOf(10);
      if (end < 0) {
        // A single large transcript event is not usage data; skip it in bounded chunks once terminated.
        let scan = offset + read, newline = -1;
        while (scan < stat.size && newline < 0) {
          const next = Buffer.alloc(Math.min(1024 * 1024, stat.size - scan));
          const count = readSync(fd, next, 0, next.length, scan);
          if (count === 0) break;
          bytesRead += count;
          newline = next.subarray(0, count).indexOf(10);
          if (newline >= 0) offset = scan + newline + 1;
          else scan += count;
        }
        if (newline < 0) break;
        malformed++;
        continue;
      }
      db.transaction(() => {
        let pos = offset;
        for (const part of buffer.subarray(0, end + 1).toString("utf8").split(/(?<=\n)/)) {
          if (!part) continue;
          try {
            const event = parseEvent(part, session, pos);
            if (event) {
              if (event.kind === "session.start") session = event.session;
              insert.run(path, pos, event.id, event.session, event.kind, JSON.stringify(event));
            }
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            malformed++;
          }
          pos += Buffer.byteLength(part);
        }
      })();
      offset += end + 1;
    }
    db.query("INSERT OR REPLACE INTO copilot_files VALUES(?,?,?,?,?,?,?)").run(path, stat.size, stat.mtimeMs, offset, identity, guard(fd, offset), (state?.errors || 0) + malformed);
    return { bytesRead, malformed };
  } finally { closeSync(fd); }
}

type UsageRow = {
  id: number; session_id: string; model: string; input_tokens: number | null; output_tokens: number | null;
  turn_index: number | null; agent_id: string | null; parent_tool_call_id: string | null; reasoning_tokens: number | null;
  cache_read_tokens: number | null; cache_write_tokens: number | null; total_nano_aiu: number | null;
  request_multiplier: number | null; duration_ms: number | null; created_at: string;
};
function indexSqlite(db: Database, path: string) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  const wal = existsSync(`${path}-wal`) ? statSync(`${path}-wal`) : null;
  const signature = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.size}:${stat.mtimeMs}:${wal?.size}:${wal?.mtimeMs}`;
  const key = `sqlite:${path}`;
  const prior = db.query("SELECT json FROM copilot_meta WHERE key=?").get(key) as { json: string } | null;
  if (process.env.DASH_COPILOT_RESCAN !== "1" && prior?.json === JSON.stringify(signature)) return;
  const source = new Database(path, { readonly: true });
  try {
    const columns = source.query("PRAGMA table_info(assistant_usage_events)").all() as { name: string }[];
    if (!columns.length) return;
    if (!["id", "session_id"].every((name) => columns.some((c) => c.name === name))) {
      throw new Error("Unsupported Copilot usage schema: id and session_id columns are required");
    }
    const wanted = ["id", "session_id", "turn_index", "agent_id", "parent_tool_call_id", "model", "input_tokens", "output_tokens", "cache_read_tokens",
      "cache_write_tokens", "total_nano_aiu", "request_multiplier", "duration_ms", "reasoning_tokens", "created_at"];
    const selection = wanted.map((name) => columns.some((c) => c.name === name) ? name : `NULL AS ${name}`).join(",");
    source.exec("BEGIN");
    db.transaction(() => {
      db.query("DELETE FROM copilot_sqlite WHERE source=?").run(path);
      const insert = db.query("INSERT INTO copilot_sqlite VALUES(?,?,?,?)");
      for (const row of source.query(`SELECT ${selection} FROM assistant_usage_events ORDER BY id`).iterate() as Iterable<UsageRow>) {
        const { id, ...measurements } = row;
        const fingerprint = hash(JSON.stringify(measurements));
        const call: CopilotCall = { id: `sqlite:${fingerprint}`, session: row.session_id,
          ts: iso(row.created_at), model: row.model || "unknown", input: number(row.input_tokens),
          output: number(row.output_tokens), read: number(row.cache_read_tokens), write: number(row.cache_write_tokens),
          nano: number(row.total_nano_aiu), premium: number(row.request_multiplier), duration: number(row.duration_ms),
          reasoning: number(row.reasoning_tokens), status: null, tools: {}, provenance: "usage_sqlite" };
        insert.run(path, id, fingerprint, JSON.stringify(call));
      }
      db.query("INSERT OR REPLACE INTO copilot_meta VALUES(?,?)").run(key, JSON.stringify(signature));
    })();
    source.exec("COMMIT");
  } finally { source.close(); }
}

export async function indexCopilot(db: Database, roots = copilotRoots()) {
  schema(db);
  const unique = [...new Set(roots.filter(existsSync).map((root) => realpathSync(root)))];
  const files = new Set<string>();
  for (const root of unique) {
    const sessions = join(root, "session-state");
    if (!existsSync(sessions)) continue;
    for (const entry of readdirSync(sessions, { withFileTypes: true })) {
      const path = join(sessions, entry.name, "events.jsonl");
      if (entry.isDirectory() && existsSync(path)) files.add(realpathSync(path));
    }
  }
  let bytesRead = 0, malformed = 0;
  db.transaction(() => {
    for (const row of db.query("SELECT path FROM copilot_files").all() as { path: string }[]) {
      if (!files.has(row.path)) {
        db.query("DELETE FROM copilot_events WHERE source=?").run(row.path);
        db.query("DELETE FROM copilot_files WHERE path=?").run(row.path);
      }
    }
    const allowed = new Set(unique.map((root) => join(root, "session-store.db")));
    for (const row of db.query("SELECT DISTINCT source FROM copilot_sqlite").all() as { source: string }[]) {
      if (!allowed.has(row.source) || !existsSync(row.source)) {
        db.query("DELETE FROM copilot_sqlite WHERE source=?").run(row.source);
        db.query("DELETE FROM copilot_meta WHERE key=?").run(`sqlite:${row.source}`);
      }
    }
  })();
  for (const path of files) {
    const result = await indexFile(db, path);
    bytesRead += result.bytesRead;
    malformed += result.malformed;
  }
  for (const root of unique) indexSqlite(db, join(root, "session-store.db"));
  const records = new Map<string, CopilotCall>(), snapshots = new Map<string, IndexedEvent>();
  const conflicts = new Set<string>();
  const observed = new Set<string>();
  const aliases = new Map<string, string>();
  for (const row of db.query("SELECT source,session_id FROM copilot_events WHERE kind='session.start'").all() as { source: string; session_id: string }[]) {
    aliases.set(basename(resolve(row.source, "..")), row.session_id);
  }
  const knownSessions = new Set(aliases.values());
  for (const row of db.query("SELECT json FROM copilot_events ORDER BY source,pos").iterate() as Iterable<{ json: string }>) {
    const event = JSON.parse(row.json) as IndexedEvent;
    observed.add(event.session);
    if (event.call) {
      if (event.call.sourceSession && knownSessions.has(event.call.sourceSession)) event.call.session = event.call.sourceSession;
      const prior = records.get(event.call.id);
      if (!prior) records.set(event.call.id, event.call);
      else if (!conflicts.has(event.call.id) && ["nano", "premium", "input", "output", "read", "write"].some((key) => prior[key as keyof CopilotCall] !== event.call![key as keyof CopilotCall])) {
        conflicts.add(event.call.id);
        records.set(event.call.id, { ...prior, nano: null, premium: null, input: null, output: null, read: null, write: null, status: "conflicting usage identity" });
      }
    }
    else if (event.kind !== "session.start") snapshots.set(event.id, event);
  }
  const recordSessions = new Set([...records.values()].map((call) => call.session));
  let sqliteDuplicates = 0, sqliteOverlapRows = 0, sqliteOverlapNano = 0, sqliteRawNano = 0, sqliteRows = 0;
  const sqliteSeen = new Set<string>();
  for (const row of db.query("SELECT fingerprint,json FROM copilot_sqlite ORDER BY source,row_id").iterate() as Iterable<{ fingerprint: string; json: string }>) {
    const call = JSON.parse(row.json) as CopilotCall;
    sqliteRows++;
    sqliteRawNano += call.nano ?? 0;
    if (sqliteSeen.has(row.fingerprint)) { sqliteDuplicates++; continue; }
    sqliteSeen.add(row.fingerprint);
    call.session = aliases.get(call.session) || call.session;
    observed.add(call.session);
    // SQLite has no durable usage ID. Never combine both sources within one session:
    // even identical calls can have persistence timestamps one millisecond apart.
    if (recordSessions.has(call.session)) {
      sqliteOverlapRows++;
      sqliteOverlapNano += call.nano ?? 0;
      continue;
    }
    records.set(call.id, call);
  }
  const latest = new Map<string, IndexedEvent>();
  let snapshotSum = 0;
  for (const snapshot of snapshots.values()) {
    snapshotSum += snapshot.nano ?? 0;
    const prior = latest.get(snapshot.session);
    if (snapshot.nano != null && (!prior || (snapshot.ts || "") >= (prior.ts || ""))) latest.set(snapshot.session, snapshot);
  }
  const measuredSessions = new Set([...records.values()].map((call) => call.session));
  const diagnostics = { roots: unique.length, files: files.size, observedSessions: observed.size,
    sessionsWithoutCalls: [...observed].filter((id) => !measuredSessions.has(id)).length,
    sqliteDuplicates, sqliteRows, sqliteRawCost: sqliteRawNano / 1e11, sqliteOverlapRows, sqliteOverlapCost: sqliteOverlapNano / 1e11,
    conflictingRecords: conflicts.size,
    snapshots: snapshots.size, snapshotSum: snapshotSum / 1e11,
    snapshotCost: [...latest.values()].reduce((sum, item) => sum + (item.nano || 0), 0) / 1e11,
    malformed: (db.query("SELECT coalesce(sum(errors),0) n FROM copilot_files").get() as { n: number }).n,
    indexedAt: new Date().toISOString(),
    billingPolicy: "Per-call nano-AIU / 1e11 = USD; shutdown/checkpoint snapshots are cumulative diagnostics, not added to spend. Durable usage IDs deduplicate copies and resumes. SQLite fallback deduplicates identical measured rows and is excluded for sessions with durable usage records; older history in those sessions may be missing.",
  };
  db.transaction(() => {
    db.exec("DELETE FROM copilot_calls");
    const insert = db.query("INSERT INTO copilot_calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const call of records.values()) insert.run(call.id, call.session, call.ts, call.model, call.input, call.output,
      call.read, call.write, call.nano, call.premium, call.duration, call.reasoning, call.status, JSON.stringify(call.tools), call.provenance);
    db.query("INSERT OR REPLACE INTO copilot_meta VALUES('coverage',?)").run(JSON.stringify(diagnostics));
  })();
  if (malformed) console.warn(`Copilot index: ${malformed} malformed or oversized complete lines skipped; see coverage.`);
  return { bytesRead, ...diagnostics, requests: records.size };
}
