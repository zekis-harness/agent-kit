import { openDb } from "./db";
import { ratesFor } from "./pricing";
import config from "../config.json";

const db = openDb();
const states = db.query(`
  SELECT c.* FROM cost_states c
  JOIN (SELECT session_id, model, max(model_cost) top FROM cost_states WHERE model<>'' GROUP BY 1,2) m
    ON m.session_id=c.session_id AND m.model=c.model AND m.top=c.model_cost
  WHERE c.model_cost > 0.01 GROUP BY c.session_id, c.model
`).all() as any[];
const computed = new Map((db.query("SELECT (CASE WHEN instr(session_id,'/')>0 THEN substr(session_id,1,instr(session_id,'/')-1) ELSE session_id END)||'|'||model k, sum(cost) c FROM requests GROUP BY 1").all() as any[]).map((x) => [x.k, x.c]));

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const byModel = new Map<string, { rate: number[]; reported: number; indexed: number }>();
for (const s of states) {
  const rate = ratesFor(s.model);
  const entry = byModel.get(s.model) || { rate: [], reported: 0, indexed: 0 };
  byModel.set(s.model, entry);
  entry.reported += s.model_cost;
  entry.indexed += computed.get(`${s.session_id}|${s.model}`) || 0;
  if (!rate) continue;
  const priced = (s.input * rate.input + s.write * rate.write1h + s.read * rate.read + s.output * rate.output) / 1e6
    + (s.web_search || 0) * config.webSearchUsd;
  entry.rate.push(Math.abs(priced - s.model_cost) / s.model_cost);
}
if (!byModel.size) console.log("No cost-state model totals found.");
console.log("Rates: cost-state tokens priced with prices.json vs cost-state costUSD (writes priced as 1h).");
for (const [model, e] of [...byModel].sort()) {
  if (!e.rate.length) { console.log(`  ${model}: no rates in prices.json`); continue; }
  const v = e.rate.sort((a, b) => a - b);
  const within = v.filter((x) => x <= 0.02).length;
  console.log(`  ${model}: n=${v.length}, median=${pct(v[v.length >> 1])}, within 2%=${within}/${v.length}, worst=${pct(v.at(-1)!)}`);
}
console.log("Coverage: indexed request cost vs cost-state costUSD for the same sessions.");
for (const [model, e] of [...byModel].sort()) {
  console.log(`  ${model}: indexed $${e.indexed.toFixed(2)}, cost-state $${e.reported.toFixed(2)}`);
}
db.close();
