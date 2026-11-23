import { useEffect, useState } from "react";
import type { Harness, UsageReport, UsageStats, usageDetail } from "../usage";
import { LineChart, slots } from "./charts";
import { compact, date, money, seconds } from "./format";
import type { LimitReport } from "../limits";
import { LimitPanel } from "./limits";

type Detail = NonNullable<ReturnType<typeof usageDetail>>;
function useLocal<T>(path: string | null) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    const load = () => {
      setState((old) => ({ ...old, loading: true }));
      fetch(path, { signal: controller.signal }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        if (controller.signal.aborted) return;
        setState({ data: body as T, error: null, loading: false });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setState((old) => ({ ...old, error: String(error), loading: false }));
      });
    };
    setState({ data: null, error: null, loading: true });
    load();
    const timer = setInterval(load, 60000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [path]);
  return state;
}
const measured = (n: number | null | undefined) => n == null ? "Unknown" : compact(n);
const usd = (n: number | null | undefined) => n == null ? "Unknown" : money(n);
const percent = (n: number | null | undefined) => n == null ? "Unknown" : `${(n * 100).toFixed(1)}%`;
function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="stat"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}
function ErrorNotice({ error }: { error: string | null }) {
  return error ? <p className="inline-error" role="alert">{error}</p> : null;
}
function localMidnight(value: string, nextDay = false) {
  const d = new Date(`${value}T00:00:00`);
  if (nextDay) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

const measures: Array<{ key: keyof UsageStats; label: string; format: (n: number | null) => string }> = [
  { key: "cost", label: "Observed cost (USD, periods can differ in length)", format: usd },
  { key: "days", label: "Active local days", format: measured },
  { key: "costPerDay", label: "USD / active local day", format: usd },
  { key: "requests", label: "Observed model requests (not tasks)", format: measured },
  { key: "priced", label: "Requests with known cost", format: measured },
  { key: "costPerRequest", label: "USD / priced request", format: (n) => n == null ? "Unknown" : `$${n.toFixed(4)}` },
  { key: "requestsPerDay", label: "Requests / active local day", format: measured },
  { key: "sessions", label: "Sessions with observed calls (including subagents)", format: measured },
  { key: "sessionsPerDay", label: "Sessions / active local day", format: measured },
  { key: "medianOpening", label: "Median first observed prompt tokens per session", format: measured },
  { key: "medianPeak", label: "Median observed peak context per session", format: measured },
  { key: "cacheHit", label: "Measured cache reuse (read / prompt tokens)", format: percent },
  { key: "cacheRead", label: "Cache read tokens", format: measured },
  { key: "cacheWrite", label: "Cache write tokens", format: measured },
  { key: "output", label: "Output tokens (not an accepted-work measure)", format: measured },
  { key: "premium", label: "Copilot reported premium-request multipliers (not USD)", format: measured },
  { key: "duration", label: "Observed API duration (ms, not elapsed task time)", format: measured },
];

function Comparison({ data }: { data: UsageReport }) {
  if (!data.comparison) return <p className="early">No rollout boundary is configured for this environment/harness selection. Choose the first full local day after your Agent-kit rollout to compare. Claude's configured rollout date is never applied to Copilot.</p>;
  const { before, after, boundary } = data.comparison;
  return <>
    <h2>Before / after Agent-kit</h2>
    <p className="period">Boundary: {date(boundary)} (local time). Before: {date(before.first)} to {date(before.last)}.
      After: {date(after.first)} to {date(after.last)}. Ranges exclude their upper boundary.</p>
    {(before.days < 14 || after.days < 14 || before.sessions < 20 || after.sessions < 20) &&
      <p className="early">Small sample: {before.days} before / {after.days} after active days, {before.sessions} / {after.sessions} sessions. Coverage and task mix may differ; these are not causal savings.</p>}
    <section className="panel plain-table"><table><thead><tr><th>Measure</th><th>Before</th><th>After</th></tr></thead><tbody>
      {measures.map(({ key, label, format }) => <tr key={key}><td>{label}</td><td>{format(before[key] as number | null)}</td><td>{format(after[key] as number | null)}</td></tr>)}
    </tbody></table></section>
  </>;
}

function UsageSession({ id, back }: { id: string; back: () => void }) {
  const state = useLocal<Detail>(`/api/usage/sessions/${encodeURIComponent(id)}`);
  const [page, setPage] = useState(0);
  const data = state.data;
  const points = data?.points.filter((p) => p.context != null) || [];
  return <><button className="table-toggle" onClick={back}>Back to usage</button><ErrorNotice error={state.error} />
    {!data && <p className="empty">{state.loading ? "Loading local session..." : "No measured session."}</p>}
    {data && <>
      <h1>{data.environment}: {data.harness === "copilot" ? "Copilot" : "Claude"} session</h1><p className="period">{data.session}. Full measured session history, independent of dashboard date filters.</p>
      <div className="stats">
        <Metric label="Observed USD" value={usd(data.totals.cost)} note={`${data.totals.unpriced} calls missing cost`} />
        <Metric label="Model requests" value={measured(data.totals.requests)} note="Not user turns or completed tasks" />
        <Metric label="Median / peak prompt" value={`${measured(data.totals.medianOpening)} / ${measured(data.totals.medianPeak)}`} />
        <Metric label="Cache reuse" value={percent(data.totals.cacheHit)} note={`${data.totals.cacheMeasured} measured calls`} />
        <Metric label="API time" value={data.totals.duration == null ? "Unknown" : seconds(data.totals.duration / 1000)} />
        <Metric label="Premium multipliers" value={measured(data.totals.premium)} note="Copilot only, not USD" />
      </div>
      {points.length > 0 && <LineChart title="Observed prompt context by request" labels={points.map((_, i) => String(i + 1))}
        series={[{ name: "Prompt tokens (includes cache)", color: slots[0], values: points.map((p) => p.context!) }]} />}
      <section className="panel plain-table"><h2>Context breakdown observations</h2>
        <p className="table-note">Shutdown system/tool counts describe that observation, not necessarily opening context. No unsupported instruction/MCP attribution is inferred.</p>
        {data.breakdowns.length ? <table><thead><tr><th>Time</th><th>System tokens</th><th>Tool definitions</th><th>Context</th></tr></thead><tbody>
          {data.breakdowns.map((b, i) => <tr key={i}><td>{date(b.ts)}</td><td>{measured(b.system)}</td><td>{measured(b.tools)}</td><td>{measured(b.context)}</td></tr>)}
        </tbody></table> : <p className="table-note">No Copilot system/tool breakdown recorded. Claude component detail remains available in Claude views.</p>}
      </section>
      <section className="panel plain-table"><h2>Measured tool calls</h2>
        {data.tools.length ? <table><thead><tr><th>Tool</th><th>Calls</th></tr></thead><tbody>{data.tools.map((t) => <tr key={t.name}><td>{t.name}</td><td>{t.count}</td></tr>)}</tbody></table> : <p className="table-note">Tool counts unavailable in this source.</p>}
      </section>
      <section className="panel table-panel"><h2>Per-call accounting and provenance</h2><table><thead><tr><th>Time / model</th><th>USD</th><th>Prompt</th><th>Cache read / write</th><th>Output / reasoning</th><th>API time</th><th>Source / status</th></tr></thead><tbody>
        {data.points.slice(page * 20, page * 20 + 20).map((p) => <tr key={p.id}><td>{date(p.ts)}<small>{p.model}</small></td><td>{usd(p.cost)}</td><td>{measured(p.input)}</td>
          <td>{measured(p.cacheRead)} / {measured(p.cacheWrite)}</td><td>{measured(p.output)} / {measured(p.reasoning)}</td><td>{p.duration == null ? "Unknown" : seconds(p.duration / 1000)}</td><td>{p.provenance}<small>{p.status || "Completeness not recorded"}</small></td></tr>)}
      </tbody></table><Pagination page={page} count={data.points.length} setPage={setPage} /></section>
    </>}
  </>;
}

function Pagination({ page, count, setPage }: { page: number; count: number; setPage: (page: number) => void }) {
  return <div className="pagination"><button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
    <span>{count ? page * 20 + 1 : 0} to {Math.min((page + 1) * 20, count)} of {count}</span>
    <button disabled={(page + 1) * 20 >= count} onClick={() => setPage(page + 1)}>Next</button></div>;
}

export function Usage({ initialHarness = "claude", initialEnvironment = "local" }: { initialHarness?: Harness; initialEnvironment?: string }) {
  const [harness, setHarness] = useState<Harness>(initialHarness);
  const [environment, setEnvironment] = useState(initialEnvironment);
  const [model, setModel] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [boundaries, setBoundaries] = useState<Record<string, string>>({});
  const boundary = boundaries[`${environment}:${harness}`] || "";
  const [baseline, setBaseline] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const params = new URLSearchParams({ environment, harness, baseline });
  if (model) params.set("model", model);
  if (from) params.set("from", localMidnight(from));
  if (to) params.set("to", localMidnight(to, true));
  if (boundary) params.set("boundary", localMidnight(boundary));
  const state = useLocal<UsageReport>(`/api/usage?${params}`);
  const limitParams = new URLSearchParams({ environment, harness });
  if (from) limitParams.set("from", localMidnight(from));
  if (to) limitParams.set("to", localMidnight(to, true));
  const limits = useLocal<LimitReport>(`/api/limits?${limitParams}`);
  const data = state.data;
  useEffect(() => setPage(0), [environment, harness, model, from, to]);
  if (selected) return <UsageSession key={selected} id={selected} back={() => setSelected(null)} />;
  const daily = data?.daily.filter((d) => d.cost != null) || [];
  return <>
    <div className="filters usage-filters">
      <label>Environment<select aria-label="Environment" value={environment} onChange={(e) => { setEnvironment(e.target.value); setModel(""); }}><option value="all">All local indexes</option>{data?.environments.map((e) => <option key={e.id} value={e.id}>{e.label}{e.available ? "" : " (unavailable)"}</option>)}</select></label>
      <label>Harness<select aria-label="Harness" value={harness} onChange={(e) => { setHarness(e.target.value as Harness); setModel(""); }}><option value="copilot">Copilot</option><option value="claude">Claude Code</option><option value="all">Both (mixed)</option></select></label>
      <label>Model<select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}><option value="">All models</option>{data?.availableModels.map((m) => <option key={`${m.harness}:${m.model}`} value={m.model}>{m.harness}: {m.model}</option>)}</select></label>
      <label>From (local)<input aria-label="From date" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>Through (local)<input aria-label="Through date" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <label>Agent-kit boundary (local)<input aria-label="Agent-kit boundary" type="date" value={boundary} onChange={(e) => setBoundaries((old) => ({ ...old, [`${environment}:${harness}`]: e.target.value }))} /></label>
      <label>Baseline<select aria-label="Baseline" value={baseline} onChange={(e) => setBaseline(e.target.value)}><option value="all">All selected before</option><option value="14d">Last 14 days before</option></select></label>
    </div>
    <ErrorNotice error={state.error} />
    <ErrorNotice error={data?.indexError || null} />
    {!data && <p className="empty">{state.loading ? "Loading measured local usage..." : "No usage loaded."}</p>}
    {data && <>
      <p className="period">{data.units}</p>
      <p className="period">Environment: {data.environments.find((e) => e.id === environment)?.label || "All local indexes"}.
        {" "}{data.duplicateCopies} duplicate request copies excluded across environments, {data.environmentConflicts} conflicting copies left unpriced. External indexes are read-only; unavailable data is never fetched.</p>
      {data.environments.filter((e) => (environment === "all" || e.id === environment) && !e.available).map((e) => <p className="early" key={e.id}>{e.label}: unavailable on this machine. {e.error || "No local index configured; no personal-laptop data has been imported."}</p>)}
      {harness !== "claude" && data.coverage && <p className="early">Partial local history: {data.coverage.sessionsWithoutCalls} sessions have no per-call measurements;
        {" "}{data.coverage.sqliteOverlapRows} historical SQLite rows are withheld where durable records exist. These totals are observed amounts, not a reconciled invoice or complete lifetime bill.</p>}
      <div className="stats">
        <Metric label="Observed USD" value={usd(data.totals.cost)} note={`${data.totals.priced} amounts / ${data.totals.requests} calls; ${data.totals.partialCost} partial`} />
        <Metric label="USD / priced request" value={data.totals.costPerRequest == null ? "Unknown" : `$${data.totals.costPerRequest.toFixed(4)}`} />
        <Metric label="Active local days" value={measured(data.totals.days)} note={`${data.totals.sessions} sessions, not completed tasks`} />
        <Metric label="Cache reuse" value={percent(data.totals.cacheHit)} note={`${data.totals.cacheMeasured} measured requests`} />
        <Metric label="AI credits (Copilot)" value={harness === "copilot" && data.totals.cost != null ? measured(data.totals.cost * 100) : "See harness split"} note="100 credits = $1, not premium requests" />
        <Metric label="Premium multipliers" value={measured(data.totals.premium)} note="Reported by Copilot, separate units" />
      </div>
      {data.totals.requests === 0 && <p className="early">No observed calls in this selection. This is missing coverage, not zero spend.</p>}
      <LimitPanel data={limits.data} error={limits.error} />
      <details className="panel coverage"><summary>Coverage, accounting policy and limitations</summary>
        {data.warnings.map((w) => <p key={w}>{w}</p>)}
        <table><thead><tr><th>Environment</th><th>Harness</th><th>Observed requests</th><th>Priced / missing</th><th>Missing-call sessions (all history)</th><th>Observed USD</th></tr></thead><tbody>
          {data.sourceCoverage.map((s) => <tr key={`${s.environment}:${s.harness}`}><td>{s.environment}</td><td>{s.harness}</td><td>{s.requests}</td><td>{s.priced} / {s.unpriced}</td><td>{measured(s.unmeasuredSessions)}</td><td>{usd(s.cost)}</td></tr>)}
        </tbody></table>
        {harness !== "claude" && data.coverage && <><p>{data.coverage.billingPolicy}</p>
          <p>All-history Copilot index: {data.coverage.files} files, {data.coverage.observedSessions} observed sessions, {data.coverage.sessionsWithoutCalls} without per-call measurements.
            SQLite: {data.coverage.sqliteRows} raw rows, {data.coverage.sqliteDuplicates} identical-row duplicates removed, {data.coverage.sqliteOverlapRows} overlapping-session rows withheld ({usd(data.coverage.sqliteOverlapCost)}).
            {data.coverage.malformed} malformed/oversized lines skipped, {data.coverage.conflictingRecords} conflicting usage IDs left unpriced. Indexed {date(data.coverage.indexedAt)}; refreshes every minute.</p>
          <p>Diagnostic snapshots: {data.coverage.snapshots}; naive sum {usd(data.coverage.snapshotSum)} versus latest-per-session {usd(data.coverage.snapshotCost)}.
            Neither is included in per-call spend or used to fill missing history. Checkpoints/shutdowns can include earlier calls, resumed sessions and partial credit coverage.</p></>}
      </details>
      {harness === "all" && <section className="panel plain-table"><h2>Harness comparison (different billing bases)</h2><table><thead><tr><th>Harness</th><th>USD</th><th>USD / priced request</th><th>Requests</th><th>Sessions</th><th>Cache reuse</th></tr></thead><tbody>{data.harnesses.map((h) => <tr key={h.harness}><td>{h.harness}</td><td>{usd(h.cost)}</td><td>{usd(h.costPerRequest)}</td><td>{h.requests}</td><td>{h.sessions}</td><td>{percent(h.cacheHit)}</td></tr>)}</tbody></table></section>}
      {daily.length > 0 && <LineChart title="Observed USD by active local day (missing dates omitted)" labels={daily.map((d) => d.day)} moneyAxis series={[{ name: "Observed USD", color: slots[0], values: daily.map((d) => d.cost!) }]} />}
      <Comparison data={data} />
      <section className="panel plain-table"><h2>Model mix</h2><table><thead><tr><th>Harness / model</th><th>USD / share</th><th>Requests / share</th><th>Before USD / requests</th><th>After USD / requests</th></tr></thead><tbody>
        {data.models.map((m) => <tr key={m.id}><td>{m.environment} / {m.harness}: {m.model}</td><td>{usd(m.cost)} / {percent(m.spendShare)}</td><td>{m.requests} / {percent(m.requestShare)}</td><td>{usd(m.before?.cost)} / {measured(m.before?.requests)}</td><td>{usd(m.after?.cost)} / {measured(m.after?.requests)}</td></tr>)}
      </tbody></table></section>
      <section className="panel table-panel"><h2>Sessions ranked by observed cost</h2><p className="table-note">Click a row for per-call provenance and measured breakdowns. Cost includes only the selected range. Missing cost is not zero.</p>
        <table><thead><tr><th>Harness / session</th><th>USD</th><th>Requests</th><th>Peak / first observed context</th><th>Models</th><th>API time</th><th>Source</th></tr></thead><tbody>
          {data.sessions.slice(page * 20, page * 20 + 20).map((s) => <tr key={s.id} tabIndex={0} role="button" aria-label={`Open ${s.harness} session ${s.session}`} onClick={() => setSelected(s.id)} onKeyDown={(e) => e.key === "Enter" && setSelected(s.id)}>
            <td>{s.environmentLabel} / {s.harness}<small>{s.title || s.session}</small></td><td>{usd(s.cost)}{s.unpriced > 0 && <small>{s.unpriced} incomplete costs</small>}</td><td>{s.requests}</td><td>{measured(s.context)} / {measured(s.opening)}</td><td>{s.models.join(", ")}</td><td>{s.duration == null ? "Unknown" : seconds(s.duration / 1000)}</td><td>{s.provenance.join(", ")}</td>
          </tr>)}
        </tbody></table><Pagination page={page} count={data.sessions.length} setPage={setPage} />
      </section>
    </>}
  </>;
}
