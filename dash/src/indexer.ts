import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";
import { openDb, paths, rawTables } from "./db";
import { parseLine } from "./parse";
import { rebuild } from "./rebuild";
import { indexLedger } from "./ledger";
import { indexCopilot } from "./copilot";
import { indexLimits } from "./limits";

type FileRow = { path: string; size: number; mtime: number; identity: string; offset: number; scan_order: number };

function discover(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const parts = relative(root, path).split(sep);
        if (parts.length === 2 || parts.at(-2)?.toLowerCase() === "subagents") found.push(path);
      }
    }
  };
  walk(root);
  return found.sort((a, b) => a.localeCompare(b));
}

function identity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function insertEvent(db: Database, table: string, values: Record<string, unknown>) {
  const keys = Object.keys(values);
  db.query(`INSERT OR REPLACE INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map((key) => values[key]) as any[]);
}

async function readComplete(path: string, offset: number, size: number): Promise<{ text: string; consumed: number }> {
  if (size <= offset) return { text: "", consumed: 0 };
  const bytes = new Uint8Array(await Bun.file(path).slice(offset, size).arrayBuffer());
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] !== 10) end--;
  if (!end) return { text: "", consumed: 0 };
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), consumed: end };
}

export async function runIndex(db = openDb()) {
  const started = performance.now();
  const location = paths();
  const files = discover(location.projects);
  const before = new Set((db.query("SELECT request_id FROM requests").all() as any[]).map((x) => x.request_id));
  const parserVersion = "5";
  const derivedVersion = "7";
  let changed = (db.query("SELECT value FROM state WHERE key='derived_version'").get() as any)?.value !== derivedVersion;
  if ((db.query("SELECT value FROM state WHERE key='parser_version'").get() as any)?.value !== parserVersion) {
    db.transaction(() => {
      for (const table of rawTables) db.run(`DELETE FROM ${table}`);
      db.run("UPDATE files SET size=0,mtime=0,offset=0");
    })();
    changed = true;
  }
  let sequence = Number((db.query("SELECT coalesce(max(scan_order),0) n FROM files").get() as any).n);
  for (const path of files) {
    const stat = statSync(path);
    const id = identity(stat);
    let row = db.query("SELECT * FROM files WHERE path=?").get(path) as FileRow | null;
    const reset = !!row && (stat.size < row.size || row.identity !== id);
    if (reset) {
      db.transaction(() => {
        for (const table of rawTables) db.query(`DELETE FROM ${table} WHERE source=?`).run(path);
        db.query("UPDATE files SET size=0,mtime=0,identity=?,offset=0 WHERE path=?").run(id, path);
      })();
      row = { ...row!, size: 0, mtime: 0, identity: id, offset: 0 };
      changed = true;
    }
    if (!row) {
      row = { path, size: 0, mtime: 0, identity: id, offset: 0, scan_order: ++sequence };
      db.query("INSERT INTO files(path,kind,size,mtime,identity,offset,scan_order) VALUES(?,?,?,?,?,?,?)").run(path, /[\\/]subagents[\\/]/i.test(path) ? "subagent" : "main", 0, 0, id, 0, row.scan_order);
    }
    if (stat.size === row.offset) {
      if (stat.mtimeMs !== row.mtime || stat.size !== row.size) db.query("UPDATE files SET size=?,mtime=? WHERE path=?").run(stat.size, stat.mtimeMs, path);
      continue;
    }
    const chunk = await readComplete(path, row.offset, stat.size);
    if (!chunk.consumed) {
      db.query("UPDATE files SET size=?,mtime=? WHERE path=?").run(stat.size, stat.mtimeMs, path);
      continue;
    }
    db.transaction(() => {
      let bytePos = row!.offset;
      for (const lineWithNewline of chunk.text.split(/(?<=\n)/)) {
        if (!lineWithNewline) continue;
        const line = lineWithNewline.replace(/\r?\n$/, "");
        for (const event of parseLine(line, path, bytePos)) insertEvent(db, event.table, event.values);
        bytePos += Buffer.byteLength(lineWithNewline);
      }
      db.query("UPDATE files SET size=?,mtime=?,identity=?,offset=? WHERE path=?").run(stat.size, stat.mtimeMs, id, row!.offset + chunk.consumed, path);
    })();
    changed = true;
  }
  changed = indexLedger(db, location.handoffs) || changed;
  if (changed) {
    db.transaction(() => rebuild(db))();
    db.query("INSERT INTO state(key,value) VALUES('derived_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(derivedVersion);
    db.query("INSERT INTO state(key,value) VALUES('parser_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(parserVersion);
  }
  const after = (db.query("SELECT request_id FROM requests").all() as any[]).map((x) => x.request_id);
  const newRequests = after.filter((id) => !before.has(id)).length;
  const sessions = Number((db.query("SELECT count(*) n FROM sessions").get() as any).n);
  const total = Number((db.query("SELECT coalesce(sum(coalesce(cost,known_cost)),0) n FROM requests").get() as any).n);
  const copilot = await indexCopilot(db);
  await indexLimits(db);
  const seconds = (performance.now() - started) / 1000;
  return { files: files.length, sessions, requests: after.length, newRequests, total, seconds, copilot };
}

if (import.meta.main) {
  const db = openDb();
  const result = await runIndex(db);
  console.log(`${result.files} files, ${result.sessions} sessions, ${result.newRequests} new deduped requests (${result.requests} total), $${result.total.toFixed(2)}, ${result.seconds.toFixed(2)}s`);
  console.log(`Copilot: ${result.copilot.files} files, ${result.copilot.requests} deduped calls, ${result.copilot.bytesRead} new source bytes read; per-call coverage is partial.`);
  db.close();
}
