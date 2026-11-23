import type { Database } from "bun:sqlite";
import config from "../config.json";
import { effectiveRates } from "./pricing";

type Request = {
  request_id: string; session_id: string; ts: string | null; model: string;
  write5m: number; write1h: number; read: number; context_total: number;
};

export function rebuildFlags(db: Database) {
  db.run("DELETE FROM flags");
  const insert = db.query("INSERT INTO flags(session_id,request_id,type,amount,token_amount,detail_name) VALUES(?,?,?,?,?,?)");
  const requests = db.query("SELECT * FROM requests ORDER BY session_id,ts,request_id").all() as Request[];
  const bySession = new Map<string, Request[]>();
  for (const request of requests) {
    const list = bySession.get(request.session_id) || [];
    list.push(request);
    bySession.set(request.session_id, list);
  }
  for (const [sid, list] of bySession) {
    const over = list.filter((r) => r.context_total > config.ranPastHandoffContextTokens);
    if (over.length >= config.ranPastHandoffMinimumTurns) {
      for (const request of over) {
        const rate = effectiveRates(request.model, request.context_total);
        const tokens = Math.max(0, request.read - config.ranPastHandoffFreeReadTokens);
        insert.run(sid, request.request_id, "ran_past_handoff", rate ? tokens * rate.read / 1e6 : 0, tokens, null);
      }
    }
    for (let i = 1; i < list.length; i++) {
      const request = list[i];
      const previous = list[i - 1];
      const write = request.write5m + request.write1h;
      const ttl = request.write1h > 0 ? config.ttl1hMinutes : config.ttl5mMinutes;
      const gap = request.ts && previous.ts ? (Date.parse(request.ts) - Date.parse(previous.ts)) / 60000 : 0;
      if (write > config.coldRebuildWriteTokens && gap > ttl) {
        const rate = effectiveRates(request.model, request.context_total);
        const cost = rate ? (request.write5m * (rate.write5m - rate.read) + request.write1h * (rate.write1h - rate.read)) / 1e6 : 0;
        insert.run(sid, request.request_id, "cold_rebuild", Math.max(0, cost), write, null);
      }
    }
  }
  const results = db.query("SELECT rowid,* FROM tool_results WHERE token_est > ?").all(config.oversizedToolResultTokens) as any[];
  for (const result of results) {
    const later = (bySession.get(result.session_id) || []).filter((r) => !result.ts || !r.ts || Date.parse(r.ts) > Date.parse(result.ts));
    const amount = later.reduce((sum, request) => sum + result.token_est * (effectiveRates(request.model, request.context_total)?.read || 0) / 1e6, 0);
    insert.run(result.session_id, null, "oversized_tool_result", amount, result.token_est, result.tool_name);
  }
  const openings = db.query("SELECT * FROM opening WHERE component LIKE 'mcp:%' OR component='skill'").all() as any[];
  for (const opening of openings) {
    const calls = opening.component === "skill"
      ? Number((db.query("SELECT count(*) n FROM tool_calls WHERE session_id=? AND skill_name=?").get(opening.session_id, opening.name) as any).n)
      : Number((db.query("SELECT count(*) n FROM tool_calls WHERE session_id=? AND mcp_server=?").get(opening.session_id, opening.name) as any).n);
    if (calls) continue;
    const list = bySession.get(opening.session_id) || [];
    const amount = list.reduce((sum, request) => sum + opening.tokens * (effectiveRates(request.model, request.context_total)?.read || 0) / 1e6, 0);
    insert.run(opening.session_id, null, "loaded_never_used", amount, opening.tokens, opening.name);
  }
}
