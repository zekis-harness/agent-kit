import type { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { requestCost } from "./pricing";
import { rebuildFlags } from "./flags";

type Ordered = { source: string; pos: number; scan_order: number };

function ordered<T>(db: Database, table: string): T[] {
  return db.query(`SELECT r.*,f.scan_order FROM ${table} r JOIN files f ON f.path=r.source ORDER BY f.scan_order,r.pos`).all() as T[];
}

export function rebuild(db: Database) {
  db.exec("DELETE FROM flags; DELETE FROM opening; DELETE FROM tool_results; DELETE FROM tool_calls; DELETE FROM requests; DELETE FROM sessions");
  const meta = new Map<string, any>();
  const ensure = (id: string) => {
    let value = meta.get(id);
    if (!value) { value = { id, sidechain: false, sources: new Set<string>() }; meta.set(id, value); }
    return value;
  };
  for (const row of ordered<any>(db, "session_events")) {
    const session = ensure(row.session_id);
    session.sources.add(row.source);
    session.cwd ||= row.cwd;
    session.branch ||= row.branch;
    session.sidechain ||= !!row.sidechain;
    if (row.ts && (!session.started || row.ts < session.started)) session.started = row.ts;
    if (row.ts && (!session.ended || row.ts > session.ended)) session.ended = row.ts;
  }
  const humans = ordered<any>(db, "human_events");
  const humanBySession = new Map<string, any[]>();
  const seenHumans = new Set<string>();
  for (const row of humans) {
    const key = `${row.session_id}:${row.fingerprint}`;
    if (seenHumans.has(key)) continue;
    seenHumans.add(key);
    const session = ensure(row.session_id);
    session.sources.add(row.source);
    const list = humanBySession.get(row.session_id) || [];
    list.push(row);
    humanBySession.set(row.session_id, list);
    if (list.length === 1 && row.continued_path) session.continued = row.continued_path;
  }
  for (const row of ordered<any>(db, "titles_raw")) ensure(row.session_id).title ||= row.title;
  const logical = new Map<string, any>();
  const requests: any[] = [];
  const insertRequest = db.query(`INSERT INTO requests
    (request_id,session_id,ts,model,input,write5m,write1h,read,output,thinking,web_search,context_total,cost,write_unknown,known_cost,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of ordered<any>(db, "request_occurrences")) {
    const prior = logical.get(row.request_id);
    if (!prior) { logical.set(row.request_id, { ...row }); continue; }
    for (const field of ["input", "write5m", "write1h", "write_total", "read", "output", "thinking", "web_search"]) prior[field] = Math.max(prior[field], row[field]);
    prior.usage_mask |= row.usage_mask;
    prior.invalid_usage |= row.invalid_usage;
    if (!prior.model) prior.model = row.model;
    else if (row.model && prior.model !== row.model) { prior.model = "[conflicting models]"; prior.invalid_usage = 1; }
    if (row.ts && (!prior.ts || row.ts < prior.ts)) prior.ts = row.ts;
  }
  for (const row of logical.values()) {
    row.write_unknown = Math.max(0, row.write_total - row.write5m - row.write1h);
    if (row.usage_mask & 2 && row.write5m + row.write1h > row.write_total) row.invalid_usage = 1;
    const session = ensure(row.session_id);
    session.sources.add(row.source);
    const usage = { input: row.input, write5m: row.write5m, write1h: row.write1h, writeUnknown: row.write_unknown, read: row.read, output: row.output, webSearch: row.web_search };
    const knownCost = requestCost(row.model, usage);
    const complete = row.usage_mask === 15 && !row.invalid_usage && row.write_unknown === 0;
    const cost = complete ? knownCost : null;
    const context = row.input + row.write5m + row.write1h + row.write_unknown + row.read;
    insertRequest.run(row.request_id, row.session_id, row.ts, row.model, row.input, row.write5m, row.write1h, row.read, row.output, row.thinking, row.web_search, context, cost, row.write_unknown, knownCost, cost == null ? "partial" : "complete");
    requests.push({ ...row, cost, known_cost: knownCost, context_total: context });
  }
  const insertCall = db.query("INSERT INTO tool_calls(session_id,ts,assistant_uuid,tool_id,name,mcp_server,skill_name,file_path) VALUES(?,?,?,?,?,?,?,?)");
  const calls = ordered<any>(db, "tool_calls_raw");
  for (const row of calls) insertCall.run(row.session_id, row.ts, row.assistant_uuid, row.tool_id, row.name, row.mcp_server, row.skill_name, row.file_path);
  const callByUuid = new Map(calls.filter((x) => x.assistant_uuid).map((x) => [x.assistant_uuid, x]));
  const insertResult = db.query("INSERT INTO tool_results(session_id,ts,source_uuid,tool_name,mcp_server,token_est) VALUES(?,?,?,?,?,?)");
  for (const row of ordered<any>(db, "tool_results_raw")) {
    const call = callByUuid.get(row.source_uuid);
    insertResult.run(row.session_id, row.ts, row.source_uuid, call?.name || null, row.mcp_server || call?.mcp_server || null, row.token_est);
  }
  const openingRows = ordered<any>(db, "opening_raw");
  const firstShapeSource = new Map<string, string>();
  for (const row of openingRows) if (row.component === "system_prompt" && !firstShapeSource.has(row.session_id)) firstShapeSource.set(row.session_id, `${row.source}:${row.pos}`);
  const grouped = new Map<string, { session: string; component: string; name: string | null; chars: number }>();
  const seenAttachments = new Set<string>();
  for (const row of openingRows) {
    if (!firstShapeSource.has(row.session_id)) continue;
    const secondHuman = humanBySession.get(row.session_id)?.[1];
    if (row.ts && secondHuman?.ts && Date.parse(row.ts) >= Date.parse(secondHuman.ts)) continue;
    if (row.origin === "shape") {
      if (`${row.source}:${row.pos}` !== firstShapeSource.get(row.session_id)) continue;
    } else {
      const identity = `${row.session_id}:${row.component}:${row.name || ""}:${row.fingerprint}`;
      if (seenAttachments.has(identity)) continue;
      seenAttachments.add(identity);
    }
    const key = `${row.session_id}\0${row.component}\0${row.name || ""}`;
    const value = grouped.get(key) || { session: row.session_id, component: row.component, name: row.name, chars: 0 };
    value.chars += row.chars;
    grouped.set(key, value);
  }
  const requestBySession = new Map<string, any[]>();
  for (const request of requests) {
    const list = requestBySession.get(request.session_id) || [];
    list.push(request);
    requestBySession.set(request.session_id, list);
  }
  for (const list of requestBySession.values()) list.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
  const openingBySession = new Map<string, typeof grouped extends Map<any, infer V> ? V[] : never>();
  for (const value of grouped.values()) {
    const list = openingBySession.get(value.session) || [];
    list.push(value);
    openingBySession.set(value.session, list);
  }
  const insertOpening = db.query("INSERT INTO opening(session_id,component,name,chars,tokens) VALUES(?,?,?,?,?)");
  for (const [sid, values] of openingBySession) {
    const chars = values.filter((x) => x.component !== "skill").reduce((n, x) => n + x.chars, 0);
    const total = requestBySession.get(sid)?.[0]?.context_total || 0;
    for (const value of values) insertOpening.run(sid, value.component, value.name || "", value.chars, chars ? total * value.chars / chars : 0);
  }
  const ledgerSessions = new Set((db.query("SELECT session_id FROM ledger_runs WHERE session_id IS NOT NULL").all() as any[]).map((x) => x.session_id));
  const writers = calls.filter((x) => x.file_path).map((x) => ({ session: x.session_id, path: String(x.file_path).toLowerCase() }));
  const insertSession = db.query(`INSERT INTO sessions
    (id,parent_id,title,project,cwd,branch,kind,started_at,ended_at,continued_from_path,writer_session_id,turns,total_cost,unpriced_requests,peak_context,context_end_first,opening_total)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const session of meta.values()) {
    const list = requestBySession.get(session.id) || [];
    const cwd = session.cwd || null;
    const temp = cwd && (/appdata[\\/]local[\\/]temp/i.test(cwd) || /^\/(?:private\/)?(?:var\/folders|tmp)\//i.test(cwd) || resolve(cwd).startsWith(resolve(tmpdir())));
    const subagentPath = [...session.sources].some((x) => /[\\/]subagents[\\/]/i.test(x));
    const kind = temp || ledgerSessions.has(session.id) ? "worker-probe" : session.sidechain || subagentPath ? "subagent" : "main";
    const secondHuman = humanBySession.get(session.id)?.[1];
    const beforeSecond = secondHuman ? list.filter((r) => !r.ts || !secondHuman.ts || Date.parse(r.ts) < Date.parse(secondHuman.ts)).at(-1) : null;
    const totalCost = list.some((r) => r.known_cost != null) ? list.reduce((n, r) => n + (r.known_cost || 0), 0) : null;
    const openingTotal = list[0]?.context_total ?? null;
    const writer = session.continued ? writers.find((x) => x.path === String(session.continued).toLowerCase())?.session || null : null;
    insertSession.run(session.id, session.id.includes("/") ? session.id.split("/")[0] : null, session.title || null, cwd, cwd, session.branch || null, kind,
      session.started || list[0]?.ts || null, session.ended || list.at(-1)?.ts || null,
      session.continued || null, writer, list.length, totalCost, list.filter((r) => r.cost == null).length,
      list.reduce((n, r) => Math.max(n, r.context_total), 0), beforeSecond?.context_total ?? null, openingTotal);
  }
  rebuildFlags(db);
}
