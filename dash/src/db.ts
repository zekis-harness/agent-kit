import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import config from "../config.json";
import { mkdirSync } from "node:fs";

export function expandHome(path: string) {
  return path === "~" ? homedir() : /^~[\/]/.test(path) ? join(homedir(), path.slice(2)) : path;
}

export function paths() {
  const home = homedir();
  const handoffs = process.env.DASH_HANDOFFS_DIR || join(home, ".agent-handoffs");
  return {
    projects: process.env.DASH_PROJECTS_DIR || join(expandHome(config.sources.claudeHome), "projects"),
    handoffs,
    db: process.env.DASH_DB || join(handoffs, "usage.db"),
  };
}

export function openDb(file = paths().db): Database {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON");
  migrate(db);
  return db;
}

const schemaVersion = 2;

function migrate(db: Database) {
  if ((db.query("PRAGMA user_version").get() as any).user_version !== schemaVersion) {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[];
    for (const { name } of tables) db.run(`DROP TABLE "${name}"`);
    db.run(`PRAGMA user_version=${schemaVersion}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_state(path TEXT PRIMARY KEY,size INTEGER NOT NULL,mtime REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS files(
      path TEXT PRIMARY KEY, kind TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL,
      identity TEXT NOT NULL, offset INTEGER NOT NULL, scan_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_events(
      source TEXT NOT NULL, pos INTEGER NOT NULL, session_id TEXT NOT NULL, ts TEXT,
      cwd TEXT, branch TEXT, sidechain INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(source,pos)
    );
    CREATE TABLE IF NOT EXISTS request_occurrences(
      source TEXT NOT NULL, pos INTEGER NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL,
      ts TEXT, model TEXT NOT NULL, input INTEGER NOT NULL, write5m INTEGER NOT NULL,
      write1h INTEGER NOT NULL, read INTEGER NOT NULL, output INTEGER NOT NULL,
      thinking INTEGER NOT NULL, web_search INTEGER NOT NULL, PRIMARY KEY(source,pos)
    );
    CREATE INDEX IF NOT EXISTS request_occurrences_id ON request_occurrences(request_id);
    CREATE TABLE IF NOT EXISTS human_events(
      source TEXT NOT NULL, pos INTEGER NOT NULL, session_id TEXT NOT NULL, ts TEXT,
      continued_path TEXT, PRIMARY KEY(source,pos)
    );
    CREATE TABLE IF NOT EXISTS tool_calls_raw(
      source TEXT NOT NULL, pos INTEGER NOT NULL, item INTEGER NOT NULL, session_id TEXT NOT NULL,
      ts TEXT, assistant_uuid TEXT, tool_id TEXT, name TEXT NOT NULL, mcp_server TEXT,
      skill_name TEXT, file_path TEXT, PRIMARY KEY(source,pos,item)
    );
    CREATE TABLE IF NOT EXISTS tool_results_raw(
      source TEXT NOT NULL, pos INTEGER NOT NULL, session_id TEXT NOT NULL, ts TEXT,
      source_uuid TEXT, mcp_server TEXT, token_est REAL NOT NULL, PRIMARY KEY(source,pos)
    );
    CREATE TABLE IF NOT EXISTS opening_raw(
      source TEXT NOT NULL, pos INTEGER NOT NULL, item INTEGER NOT NULL, session_id TEXT NOT NULL,
      ts TEXT, component TEXT NOT NULL, chars INTEGER NOT NULL, name TEXT,
      PRIMARY KEY(source,pos,item)
    );
    CREATE TABLE IF NOT EXISTS titles_raw(
      source TEXT NOT NULL, pos INTEGER NOT NULL, session_id TEXT NOT NULL, title TEXT NOT NULL,
      PRIMARY KEY(source,pos)
    );
    CREATE TABLE IF NOT EXISTS cost_states(
      source TEXT NOT NULL, pos INTEGER NOT NULL, session_id TEXT NOT NULL, model TEXT NOT NULL,
      total_cost REAL, model_cost REAL, input INTEGER, output INTEGER, write INTEGER, read INTEGER,
      web_search INTEGER, PRIMARY KEY(source,pos,model)
    );
    CREATE TABLE IF NOT EXISTS ledger_runs(
      run TEXT PRIMARY KEY, ts TEXT, harness TEXT, tier TEXT, model TEXT, cwd TEXT, session_id TEXT,
      cost_usd REAL, duration_s REAL, timed_out INTEGER, status TEXT, brief TEXT
    );
    CREATE TABLE IF NOT EXISTS ledger_verdicts(run TEXT PRIMARY KEY, outcome TEXT NOT NULL, ts TEXT);
    CREATE TABLE IF NOT EXISTS statusline(pos INTEGER PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, project TEXT, cwd TEXT, branch TEXT, kind TEXT NOT NULL,
      started_at TEXT, ended_at TEXT, continued_from_path TEXT, writer_session_id TEXT,
      turns INTEGER NOT NULL DEFAULT 0, total_cost REAL, unpriced_requests INTEGER NOT NULL DEFAULT 0,
      peak_context INTEGER NOT NULL DEFAULT 0, context_end_first INTEGER, opening_total INTEGER
    );
    CREATE TABLE IF NOT EXISTS requests(
      request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts TEXT, model TEXT NOT NULL,
      input INTEGER NOT NULL, write5m INTEGER NOT NULL, write1h INTEGER NOT NULL,
      read INTEGER NOT NULL, output INTEGER NOT NULL, thinking INTEGER NOT NULL,
      web_search INTEGER NOT NULL, context_total INTEGER NOT NULL, cost REAL
    );
    CREATE INDEX IF NOT EXISTS requests_session ON requests(session_id,ts);
    CREATE TABLE IF NOT EXISTS tool_calls(
      session_id TEXT NOT NULL, ts TEXT, assistant_uuid TEXT, tool_id TEXT, name TEXT NOT NULL,
      mcp_server TEXT, skill_name TEXT, file_path TEXT
    );
    CREATE TABLE IF NOT EXISTS tool_results(
      session_id TEXT NOT NULL, ts TEXT, source_uuid TEXT, tool_name TEXT, mcp_server TEXT,
      token_est REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opening(
      session_id TEXT NOT NULL, component TEXT NOT NULL, name TEXT, chars INTEGER NOT NULL,
      tokens REAL NOT NULL, PRIMARY KEY(session_id,component,name)
    );
    CREATE TABLE IF NOT EXISTS flags(
      session_id TEXT NOT NULL, request_id TEXT, type TEXT NOT NULL, amount REAL NOT NULL,
      token_amount REAL, detail_name TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id);
    CREATE INDEX IF NOT EXISTS tool_calls_session ON tool_calls(session_id);
    CREATE INDEX IF NOT EXISTS tool_results_session ON tool_results(session_id);
    CREATE INDEX IF NOT EXISTS flags_session ON flags(session_id);
    CREATE INDEX IF NOT EXISTS flags_request ON flags(request_id);
  `);
  const ledgerColumns = db.query("PRAGMA table_info(ledger_runs)").all() as any[];
  if (!ledgerColumns.some((column) => column.name === "brief")) {
    db.exec("ALTER TABLE ledger_runs ADD COLUMN brief TEXT; DELETE FROM source_state WHERE path LIKE '%ledger.jsonl'");
  }
  const additions: Record<string, Record<string, string>> = {
    request_occurrences: { write_unknown: "INTEGER NOT NULL DEFAULT 0", write_total: "INTEGER NOT NULL DEFAULT 0", usage_mask: "INTEGER NOT NULL DEFAULT 15", invalid_usage: "INTEGER NOT NULL DEFAULT 0" },
    requests: { write_unknown: "INTEGER NOT NULL DEFAULT 0", known_cost: "REAL", status: "TEXT" },
    opening_raw: { fingerprint: "TEXT", origin: "TEXT" },
    human_events: { fingerprint: "TEXT" },
  };
  for (const [table, columns] of Object.entries(additions)) {
    const existing = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
    for (const [column, type] of Object.entries(columns)) if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export const rawTables = [
  "session_events", "request_occurrences", "human_events", "tool_calls_raw",
  "tool_results_raw", "opening_raw", "titles_raw", "cost_states",
];
