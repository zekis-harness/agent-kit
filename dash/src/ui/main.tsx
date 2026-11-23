import { StrictMode, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { LineChart, SegmentedBar, StackedBars, slots, tokenColors } from "./charts";
import { compact, date, duration, flagLabel, money, seconds, title } from "./format";
import { Usage } from "./usage";
import { LimitPanel } from "./limits";

type Tab = "usage" | "overview" | "sessions" | "detail" | "opening" | "agent-kit";

async function getJson(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

function useApi(path: string | null) {
  const [state, setState] = useState<{ data: any; loading: boolean; error: string | null }>({ data: null, loading: false, error: null });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState((old) => ({ ...old, loading: true, error: null }));
    getJson(path, { signal: controller.signal }).then((data) => setState({ data, loading: false, error: null })).catch((error) => {
      if (error.name !== "AbortError") setState((old) => ({ ...old, loading: false, error: error.message }));
    });
    return () => controller.abort();
  }, [path]);
  return state;
}

function Status({ state, children }: { state: ReturnType<typeof useApi>; children: ReactNode }) {
  if (!state.data && state.error) return <div className="empty serious">Could not load data: {state.error}</div>;
  if (!state.data) return <div className="empty">Loading local data…</div>;
  return <div className={state.loading ? "refreshing" : ""}>{state.error && <div className="inline-error">Refresh failed: {state.error}</div>}{children}</div>;
}

function Flag({ value }: { value: string }) {
  const severity = value === "ran_past_handoff" ? "critical" : value === "cold_rebuild" ? "serious" : "warning";
  return <span className={`flag ${severity}`}><span aria-hidden="true">{severity === "critical" ? "◆" : "▲"}</span>{flagLabel(value)}</span>;
}

function Stat({ label, value, delta, hero = false, warning = false }: { label: string; value: string; delta?: string; hero?: boolean; warning?: boolean }) {
  return <div className={`stat ${hero ? "hero" : ""}`}><span>{label}</span><strong className={warning ? "warning-text" : ""}>{value}</strong>{delta && <small>{delta}</small>}</div>;
}

function openingParts(parts: any[]) {
  const order: Record<string, number> = { system_prompt: 0, builtin_tools: 1, instructions: 4, deferred_tools: 5, agent_list: 6, mcp_instructions: 7 };
  const sorted = [...parts].sort((a, b) => (order[a.component] ?? (a.component.startsWith("mcp:") ? 2 : 3)) - (order[b.component] ?? (b.component.startsWith("mcp:") ? 2 : 3)) || String(a.name || a.component).localeCompare(String(b.name || b.component)));
  const visible = sorted.length > 8 ? [...sorted.slice(0, 7), { component: "other", name: "Other", tokens: sorted.slice(7).reduce((sum, row) => sum + row.tokens, 0) }] : sorted;
  return visible.map((row, index) => ({ name: row.name || flagLabel(row.component), value: row.tokens, color: row.component === "other" ? slots[7] : slots[index] }));
}

function Overview({ openSession }: { openSession: (id: string) => void }) {
  const [range, setRange] = useState("week");
  const state = useApi(`/api/overview?range=${range}`);
  const limits = useApi("/api/limits?harness=claude");
  const data = state.data;
  const rawModels = useMemo(() => data ? [...new Set<string>(data.daily.map((row: any) => row.model))].sort() : [], [data]);
  const models = rawModels.length > 8 ? [...rawModels.slice(0, 7), "Other"] : rawModels;
  const days = useMemo(() => data ? [...new Set<string>(data.daily.map((row: any) => row.day))] : [], [data]);
  return <><div className="filters"><label>Range<select value={range} onChange={(event) => setRange(event.target.value)}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select></label></div><LimitPanel data={limits.data} error={limits.error} /><Status state={state}>{data && <>
    <div className="stats"><Stat hero label="API-equivalent" value={money(data.cost, true)} delta={`${data.cost >= data.previousCost ? "+" : ""}${money(data.cost - data.previousCost)} vs previous period`} /><Stat label="Pro plan multiple" value={`${data.proPlanMultiple.toFixed(1)}×`} delta="Prorated $20/month plan" /><Stat label="Cache hit rate" value={`${(data.cacheHitRate * 100).toFixed(1)}%`} /><Stat label="Avoidable" value={money(data.avoidable, true)} warning={data.avoidable > 0} /><Stat label="Handoffs" value={compact(data.handoffs)} /><Stat label="Unpriced requests" value={compact(data.unpricedRequests)} warning={data.unpricedRequests > 0} /></div>
    <div className="stats token-stats">{Object.entries(data.tokens).map(([key, value]) => <Stat key={key} label={key.replace(/([A-Z])/g, " $1")} value={compact(value as number)} />)}</div>
    <div className="grid-two"><StackedBars title="Daily API-equivalent by model" labels={days.map((day) => day.slice(5))} moneyAxis series={models.map((model, index) => ({ name: model, color: slots[model === "Other" ? 7 : index], values: days.map((day) => data.daily.filter((row: any) => row.day === day && (model === "Other" ? rawModels.slice(7).includes(row.model) : row.model === model)).reduce((sum: number, row: any) => sum + row.cost, 0)) }))} /><LineChart title="Opening context trend" labels={data.openings.map((row: any) => row.day.slice(5))} series={[{ name: "Opening tokens", color: slots[0], values: data.openings.map((row: any) => row.tokens) }]} /></div>
    <section className="panel"><h2>Worst sessions by avoidable cost</h2>{data.worst.length ? <div className="list">{data.worst.map((row: any) => <button key={row.id} className="list-row" onClick={() => openSession(row.id)}><span><b>{title(row.title, row.id)}</b><small>{row.id}</small></span><span className="flag-list">{String(row.flags || "").split(",").filter(Boolean).map((flag) => <Flag key={flag} value={flag} />)}</span><strong>{money(row.avoidable)}</strong></button>)}</div> : <div className="empty compact-empty">No avoidable-cost flags in this range.</div>}</section>
  </>}</Status></>;
}

function Sessions({ openSession }: { openSession: (id: string) => void }) {
  const [filters, setFilters] = useState({ project: "", model: "", kind: "", flag: "", sort: "cost", direction: "desc" });
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
  const state = useApi(`/api/sessions?${query}`);
  const rows = state.data?.sessions || [];
  const options = (key: string) => [...new Set<string>(rows.flatMap((row: any) => String(row[key] || "").split(",")).filter(Boolean))].sort();
  const children = new Map<string, any[]>();
  rows.filter((row: any) => row.parent_id).forEach((row: any) => children.set(row.parent_id, [...(children.get(row.parent_id) || []), row]));
  const rowIds = new Set(rows.map((row: any) => row.id));
  const display = [...rows.filter((row: any) => !row.parent_id).flatMap((row: any) => [row, ...(children.get(row.id) || [])]), ...rows.filter((row: any) => row.parent_id && !rowIds.has(row.parent_id))];
  const update = (key: string, value: string) => setFilters((old) => ({ ...old, [key]: value }));
  return <><div className="filters session-filters"><label>Project<select value={filters.project} onChange={(e) => update("project", e.target.value)}><option value="">All</option>{options("project").map((x) => <option key={x}>{x}</option>)}</select></label><label>Model<select value={filters.model} onChange={(e) => update("model", e.target.value)}><option value="">All</option>{options("models").map((x) => <option key={x}>{x}</option>)}</select></label><label>Kind<select value={filters.kind} onChange={(e) => update("kind", e.target.value)}><option value="">All</option><option value="main">Main</option><option value="subagent">Subagent</option><option value="worker-probe">Worker/probe</option></select></label><label>Flag<select value={filters.flag} onChange={(e) => update("flag", e.target.value)}><option value="">All</option><option value="ran_past_handoff">Ran past handoff</option><option value="cold_rebuild">Cold rebuild</option><option value="oversized_tool_result">Oversized result</option><option value="loaded_never_used">Loaded, never used</option></select></label><label>Sort<select value={filters.sort} onChange={(e) => update("sort", e.target.value)}><option value="cost">Cost</option><option value="context">Peak context</option><option value="turns">Turns</option><option value="duration">Duration</option></select></label><button className="direction" onClick={() => update("direction", filters.direction === "desc" ? "asc" : "desc")}>{filters.direction === "desc" ? "↓" : "↑"}</button></div>
    <Status state={state}>{state.data && <section className="panel table-panel"><table><thead><tr><th>Session</th><th>Project</th><th>Model</th><th>Kind</th><th>Cost</th><th>Peak context</th><th>Turns</th><th>Duration</th><th>Flags</th></tr></thead><tbody>{display.map((row: any) => <tr key={row.id} className={row.parent_id ? "subagent-row" : ""} onClick={() => openSession(row.id)} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && openSession(row.id)}><td><b>{row.parent_id && <span className="tree">↳</span>}{title(row.title, row.id)}</b><small>{row.id}</small>{row.continued_from_path && <span className="continued">continued from</span>}</td><td>{row.project || "n/a"}</td><td>{row.models || "n/a"}</td><td>{row.kind}</td><td>{money(row.rolled_cost)}{row.rolled_unpriced > 0 && <span className="unpriced" title={`${row.rolled_unpriced} unpriced requests`}>!</span>}</td><td>{compact(row.peak_context)}</td><td>{row.turns}</td><td>{duration(row.started_at, row.ended_at)}</td><td><span className="flag-list">{String(row.flag_types || "").split(",").filter(Boolean).map((flag) => <Flag key={flag} value={flag} />)}</span></td></tr>)}</tbody></table></section>}</Status></>;
}

function SessionDetail({ id }: { id: string | null }) {
  const state = useApi(id ? `/api/sessions/${encodeURIComponent(id)}` : null);
  const [callsOpen, setCallsOpen] = useState(false);
  if (!id) return <div className="empty">Choose a session from Overview or Sessions.</div>;
  const data = state.data;
  return <Status state={state}>{data && <>
    <div className="detail-title"><div><h1>{title(data.session.title, data.session.id)}</h1><p>{data.session.id} · {date(data.session.started_at)} · {data.session.kind}</p></div>{data.session.unpriced_requests > 0 && <Flag value="unpriced_requests" />}</div>
    <div className="stats"><Stat label="Cost" value={money(data.session.total_cost)} /><Stat label="Peak context" value={compact(data.session.peak_context)} /><Stat label="Turns" value={compact(data.session.turns)} /><Stat label="Duration" value={duration(data.session.started_at, data.session.ended_at)} /></div>
    <div className="grid-two"><LineChart title="Context growth and cache bands" labels={data.points.map((row: any, index: number) => String(index + 1))} series={[{ name: "Context", color: slots[0], values: data.points.map((row: any) => row.context_total) }, { name: "Cache read", color: tokenColors.cacheRead, values: data.points.map((row: any) => row.read) }, { name: "Cache write", color: tokenColors.cacheWrite, values: data.points.map((row: any) => row.write5m + row.write1h) }]} /><SegmentedBar rows={openingParts(data.opening)} /></div>
    <div className="grid-two"><section className="panel"><h2>Request flags and idle gaps</h2><div className="list">{data.points.map((row: any, index: number) => { const prior = data.points[index - 1]; const gap = prior?.ts && row.ts ? (Date.parse(row.ts) - Date.parse(prior.ts)) / 60000 : 0; const flags = JSON.parse(row.flags || "[]"); return (gap >= 5 || flags.length) && <div className="list-row static" key={row.request_id}><span><b>Request {index + 1}</b><small>{gap >= 5 ? `${Math.round(gap)}m idle gap` : date(row.ts)}</small></span><span className="flag-list">{flags.map((flag: any) => <span key={flag.type}><Flag value={flag.type} /> {money(flag.amount)}</span>)}</span></div>; })}</div></section><section className="panel"><h2>Subagents</h2>{data.subagents.length ? data.subagents.map((row: any) => <div className="list-row static" key={row.id}><span><b>{title(row.title, row.id)}</b><small>{row.turns} turns · peak {compact(row.peak_context)}</small></span><strong>{money(row.total_cost)}</strong></div>) : <div className="empty compact-empty">No subagents.</div>}</section></div>
    <section className="panel table-panel"><div className="panel-heading"><h2>Top tool results</h2><button onClick={() => setCallsOpen(!callsOpen)}>{callsOpen ? "Show top results" : `Show all ${data.calls.length} tool calls`}</button></div>{callsOpen ? <table><thead><tr><th>Time</th><th>Tool</th><th>MCP server</th><th>Skill</th><th>Path</th></tr></thead><tbody>{data.calls.map((row: any, index: number) => <tr key={`${row.tool_id}-${index}`}><td>{date(row.ts)}</td><td>{row.name}</td><td>{row.mcp_server || ""}</td><td>{row.skill_name || ""}</td><td className="path">{row.file_path || ""}</td></tr>)}</tbody></table> : <table><thead><tr><th>Tool</th><th>MCP server</th><th>Estimated tokens</th></tr></thead><tbody>{data.results.map((row: any, index: number) => <tr key={`${row.source_uuid}-${index}`}><td>{row.tool_name || "Unknown"}</td><td>{row.mcp_server || ""}</td><td>{compact(row.token_est)}</td></tr>)}</tbody></table>}</section>
  </>}</Status>;
}

function Opening() {
  const state = useApi("/api/opening");
  const [selected, setSelected] = useState("");
  const grouped = useMemo(() => { const map = new Map<string, any>(); for (const row of state.data?.rows || []) { const item = map.get(row.id) || { ...row, parts: [] }; if (row.component) item.parts.push(row); map.set(row.id, item); } return [...map.values()]; }, [state.data]);
  const current = grouped.find((row) => row.id === selected) || grouped[0];
  return <><div className="filters"><label>Session<select value={current?.id || ""} onChange={(event) => setSelected(event.target.value)}>{grouped.map((row) => <option value={row.id} key={row.id}>{title(row.title, row.id)}</option>)}</select></label></div><Status state={state}>{state.data && current && <><div className="stats"><Stat label="Opening context" value={compact(current.opening_total)} /><Stat label="End of first prompt" value={compact(current.context_end_first)} /><Stat label="Components" value={compact(current.parts.length)} /></div><div className="grid-two"><SegmentedBar rows={openingParts(current.parts)} /><LineChart title="Opening context trend" labels={grouped.map((row) => String(row.started_at || "").slice(5, 10))} series={[{ name: "Opening tokens", color: slots[0], values: grouped.map((row) => row.opening_total || 0) }, { name: "End of first prompt", color: slots[1], values: grouped.map((row) => row.context_end_first || 0) }]} /></div><section className="panel table-panel"><h2>Opening context by session</h2><table><thead><tr><th>Session</th><th>Started</th><th>Opening</th><th>End of first prompt</th><th>Components</th></tr></thead><tbody>{grouped.map((row) => <tr key={row.id} onClick={() => setSelected(row.id)}><td>{title(row.title, row.id)}</td><td>{date(row.started_at)}</td><td>{compact(row.opening_total)}</td><td>{compact(row.context_end_first)}</td><td>{row.parts.length}</td></tr>)}</tbody></table></section></>}</Status></>;
}

function Verdict({ value }: { value: "better" | "worse" | "same" | null }) {
  if (!value) return null;
  const [icon, label, tone] = value === "better" ? ["✓", "Better", "good"] : value === "worse" ? ["▲", "Worse", "serious"] : ["=", "About the same", "neutral"];
  return <span className={`flag verdict ${tone}`}><span aria-hidden="true">{icon}</span>{label}</span>;
}

const shortDate = (value?: string | null) => value ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "n/a";
const percent = (value: number) => `${(value * 100).toFixed(0)}%`;
const markerIndex = (rows: any[]) => { const first = rows.findIndex((row) => row.after); return first > 0 ? first - 0.5 : null; };
const jobResults: Record<string, string> = { accepted: "Kept it", rework: "Had to redo", discarded: "Thrown away" };

function AgentKit() {
  const [baseline, setBaseline] = useState("all");
  const state = useApi(`/api/agent-kit?baseline=${baseline}`);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [judged, setJudged] = useState<Record<string, string>>({});
  const data = state.data;
  const verdict = async (job: any, outcome: string) => { setBusy(job.run); setMessage(""); try { await getJson("/api/verdict", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run: job.run, outcome }) }); setJudged((old) => ({ ...old, [job.run]: outcome })); } catch (error: any) { setMessage(`Could not save the result for ${job.name}: ${error.message}`); } finally { setBusy(""); } };
  const groups: string[] = data ? [...new Set<string>(data.rows.map((row: any) => row.group))] : [];
  const openingMark = data && markerIndex(data.charts.openingByDay);
  const costMark = data && markerIndex(data.charts.costPerRequest);
  const startLabel = data && `agent-kit starts ${shortDate(data.start)}`;
  return <><div className="filters"><label>Compare against<select value={baseline} onChange={(event) => setBaseline(event.target.value)}><option value="all">All before</option><option value="14d">Last 14 days before</option></select></label></div><Status state={state}>{data && <>
    <p className="period"><b>Before:</b> {shortDate(data.period.before.first)} to {shortDate(data.period.before.last)}, {data.period.before.days} days used, {compact(data.period.before.sessions)} sessions, {compact(data.period.before.requests)} requests. <b>Since agent-kit:</b> {shortDate(data.start)} to {shortDate(data.period.after.last)}, {data.period.after.days} days used, {compact(data.period.after.sessions)} sessions, {compact(data.period.after.requests)} requests. Today is still in progress.</p>
    {data.period.earlyData && <p className="early"><span aria-hidden="true">▲</span> Early data: only {data.period.after.days} days since agent-kit started. These verdicts can still move, and changes that coincided with agent-kit can look like its effect.</p>}
    <div className="answers">{data.cards.map((card: any) => <article className="answer" key={card.key}><div className="answer-top"><h3>{card.question}</h3><Verdict value={card.verdict} /></div><div className="move"><span>{card.beforeText}</span><span aria-hidden="true">→</span><strong>{card.afterText}</strong></div><small>{card.metric}</small><p>{card.sentence}</p></article>)}</div>
    <div className="grid-two">
      <LineChart title="Tokens at session start, typical session each day" labels={data.charts.openingByDay.map((row: any) => row.day.slice(5))} series={[{ name: "Tokens at start", color: slots[0], values: data.charts.openingByDay.map((row: any) => row.tokens) }]} marker={openingMark == null ? undefined : { at: openingMark, label: startLabel }} />
      <StackedBars title={`What is loaded at session start, since ${shortDate(data.charts.partsFrom)}`} labels={["Before", "Since agent-kit"]} series={data.charts.openingParts.map((part: any, index: number) => ({ name: part.label, color: slots[part.key === "other" ? 7 : index], values: [part.before, part.after] }))} />
    </div>
    <div className="grid-two">
      <LineChart title="Cost per request, 7-day periods" labels={data.charts.costPerRequest.map((row: any) => row.weekOf.slice(5))} format={(value) => `$${value.toFixed(3)}`} series={[{ name: "Cost per request", color: slots[0], values: data.charts.costPerRequest.map((row: any) => row.cost) }]} marker={costMark == null ? undefined : { at: costMark, label: startLabel }} />
      <StackedBars title="Share of spend by model" labels={["Before", "Since agent-kit"]} format={percent} series={data.charts.modelShare.map((row: any, index: number) => ({ name: row.model, color: slots[row.model === "Other" ? 7 : index], values: [row.before, row.after] }))} />
    </div>
    <section className="panel plain-table"><h2>Everything compared</h2><table><thead><tr><th>Measure</th><th>Before</th><th>Since agent-kit</th><th>Verdict</th></tr></thead>{groups.map((group) => <tbody key={group}><tr className="group-row"><td colSpan={4}>{group}</td></tr>{data.rows.filter((row: any) => row.group === group).map((row: any) => <tr key={row.key}><td><b>{row.label}</b><small>{row.explain}</small></td><td>{row.beforeText}</td><td>{row.afterText}</td><td><Verdict value={row.verdict} /></td></tr>)}</tbody>)}</table><p className="table-note">Dollar amounts marked as estimates come from waste flags and are rough. Better or Worse means a change of more than 5%.</p></section>
    <section className="panel plain-table"><h2>What agent-kit changed</h2><table><thead><tr><th>When</th><th>Change</th><th>What the numbers did</th></tr></thead><tbody>{data.changes.map((change: any) => <tr key={change.change}><td className="nowrap">{change.date}</td><td>{change.change}</td><td>{change.results.map((result: any) => <div className="result-line" key={result.label}><span>{result.label}: {result.beforeText} to {result.afterText}</span><Verdict value={result.verdict} /></div>)}</td></tr>)}</tbody></table><p className="table-note">These happened close together, so a number moving next to a change does not prove that change caused it.</p></section>
    <section className="panel plain-table"><h2>Worker jobs</h2>{message && <p className="notice">{message}</p>}{data.jobs.length ? <table><thead><tr><th>Job</th><th>Repo</th><th>Model</th><th>When</th><th>Took</th><th>Cost</th><th>Result</th></tr></thead><tbody>{data.jobs.map((job: any) => { const outcome = judged[job.run] || job.outcome; return <tr key={job.run}><td><b>{job.name}</b></td><td>{job.repo || "n/a"}</td><td>{job.model || "n/a"}</td><td className="nowrap">{date(job.ts)}</td><td>{seconds(job.durationSeconds)}</td><td>{job.cost == null ? "Not recorded" : money(job.cost)}</td><td>{outcome ? <>{jobResults[outcome] || outcome}{job.status === "blocked" && <small>The worker got blocked</small>}</> : <span className="actions job-actions"><button disabled={busy === job.run} onClick={() => verdict(job, "accepted")}>✓ Kept it</button><button disabled={busy === job.run} onClick={() => verdict(job, "rework")}>↻ Had to redo</button></span>}</td></tr>; })}</tbody></table> : <div className="empty compact-empty">No worker jobs yet.</div>}<p className="table-note">{data.probeCount} automatic test runs of the worker setup are left out.</p></section>
  </>}</Status></>;
}

function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const environment = useApi("/api/environment");
  useEffect(() => {
    if (environment.data?.defaultHarness && environment.data.defaultHarness !== "claude") setTab("usage");
  }, [environment.data?.defaultHarness]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const openSession = (id: string) => { setSessionId(id); setTab("detail"); };
  const tabs: Array<[Tab, string]> = [["usage", "All harnesses"], ["overview", "Claude overview"], ["sessions", "Claude sessions"], ["detail", "Claude detail"], ["opening", "Claude opening"], ["agent-kit", "Claude agent-kit"]];
  return <><header><div className="brand"><span className="brand-mark">A</span><div><b>Usage dashboard</b><small>Local only: nothing leaves this machine</small></div></div><nav>{tabs.map(([value, label]) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{label}</button>)}</nav></header><main>{environment.error && <p className="inline-error">Environment configuration failed: {environment.error}</p>}{tab === "usage" && <Usage initialHarness={environment.data?.defaultHarness || "claude"} initialEnvironment={environment.data?.current || "local"} />}{tab === "overview" && <Overview openSession={openSession} />}{tab === "sessions" && <Sessions openSession={openSession} />}{tab === "detail" && <SessionDetail id={sessionId} />}{tab === "opening" && <Opening />}{tab === "agent-kit" && <AgentKit />}</main></>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
