import type { LimitReport } from "../limits";
import { compact, date, money } from "./format";

const points = (value: number | null) => value == null ? "Unavailable" : `${value.toFixed(2)} pp`;

export function LimitPanel({ data, error }: { data: LimitReport | null; error?: string | null }) {
  return <section className="panel plain-table">
    <h2>Subscription limit burn</h2>
    {error && <p className="inline-error" role="alert">Limit observations failed: {error}</p>}
    {!data && <p className="table-note">Loading local limit observations...</p>}
    {data && <>
      <p className="table-note">{data.policy} Account-level observations are not filtered by response model or attributed to a session.</p>
      <p className="table-note">Observation range: {data.range.from ? date(data.range.from) : "all available local history"} to {data.range.to ? date(data.range.to) : "latest recorded sample"} (upper bound excluded).</p>
      {data.environments.map((environment) => <div key={environment.id}>
        <h3>{environment.label}: Claude Code</h3>
        {environment.status !== "available" ? <p className="early">{environment.status === "unsupported"
          ? "Unavailable for Copilot: Claude subscription limits are not Copilot credits."
          : "Usage limits unavailable: no valid local observations in this selection. Missing data is not 0%."} {environment.error}</p> : <>
          <p className="table-note">{environment.samples} distinct samples; {environment.duplicates} exact replays excluded; {environment.malformed} malformed records skipped (source-wide).
            Latest sample: {date(environment.latest?.ts)}. Model: {environment.latest?.model || "Unknown"}.
            {" "}Sampled session cost: {environment.latest?.cost == null ? "Unknown" : money(environment.latest.cost)} (cumulative, not window spend).
            {" "}Context used: {environment.latest?.context.used_percentage == null ? "Unknown" : `${environment.latest.context.used_percentage}%`}.
            Historical percentages are observations as of their timestamps, not a live quota reading.</p>
          <table><thead><tr><th>Window</th><th>Last observed</th><th>Resets at</th><th>Measured burn</th><th>Burn / measured hour</th><th>Coverage</th><th>Excluded boundaries</th></tr></thead><tbody>
            {(["five_hour", "seven_day"] as const).map((key) => {
              const window = environment.windows[key];
              return <tr key={key}><td>{key === "five_hour" ? "5-hour" : "7-day"}</td>
                <td>{window.latest ? `${window.latest.used}%` : "Unavailable"}<small>{date(window.latest?.ts)}</small></td>
                <td>{date(window.latest?.resetsAt)}</td><td>{points(window.burnPoints)}</td><td>{points(window.pointsPerHour)} / h</td>
                <td>{window.validIntervals} intervals, {compact(window.measuredHours)} h<small>{window.missing} samples missing this window</small></td>
                <td>{window.resets} resets, {window.regressions} decreases<small>{window.expiredIntervals} expired, {window.conflicts} conflicts</small></td></tr>;
            })}
          </tbody></table>
        </>}
      </div>)}
    </>}
  </section>;
}
