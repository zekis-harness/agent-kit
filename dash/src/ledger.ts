import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function lines(path: string): Array<[number, any, string]> {
  if (!existsSync(path)) return [];
  const out: Array<[number, any, string]> = [];
  let pos = 0;
  for (const line of readFileSync(path, "utf8").split(/(?<=\n)/)) {
    const start = pos;
    pos += Buffer.byteLength(line);
    const raw = line.replace(/\r?\n$/, "");
    try { out.push([start, JSON.parse(raw), raw]); } catch {}
  }
  return out;
}

export function indexLedger(db: Database, handoffs: string): boolean {
  const ledgerPath = join(handoffs, "ledger.jsonl");
  const inputs = [ledgerPath];
  const unchanged = inputs.every((path) => {
    const stat = existsSync(path) ? statSync(path) : null;
    const row = db.query("SELECT size,mtime FROM source_state WHERE path=?").get(path) as any;
    return row && row.size === (stat?.size || 0) && row.mtime === (stat?.mtimeMs || 0);
  });
  if (unchanged) return false;
  db.run("DELETE FROM ledger_runs");
  db.run("DELETE FROM ledger_verdicts");
  const run = db.query(`INSERT OR REPLACE INTO ledger_runs
    (run,ts,harness,tier,model,cwd,session_id,cost_usd,duration_s,timed_out,status,brief) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const verdict = db.query("INSERT OR REPLACE INTO ledger_verdicts(run,outcome,ts) VALUES(?,?,?)");
  for (const [, o] of lines(ledgerPath)) {
    if (o.type === "dispatch" && o.run) run.run(o.run, o.ts || null, o.harness || null, o.tier || null, o.model || null, o.cwd || null, o.session_id || null, Number.isFinite(o.cost_usd) ? o.cost_usd : null, Number.isFinite(o.duration_s) ? o.duration_s : null, o.timed_out ? 1 : 0, o.status || null, o.brief || null);
    if (o.type === "verdict" && o.run) verdict.run(o.run, o.outcome || "", o.ts || null);
  }
  const save = db.query("INSERT INTO source_state(path,size,mtime) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime");
  for (const path of inputs) {
    const stat = existsSync(path) ? statSync(path) : null;
    save.run(path, stat?.size || 0, stat?.mtimeMs || 0);
  }
  return true;
}
