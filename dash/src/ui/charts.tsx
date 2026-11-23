import { useId, useState } from "react";
import { compact, money } from "./format";

export const slots = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
export const tokenColors: Record<string, string> = { input: slots[0], cacheWrite: slots[1], cacheRead: slots[2], output: slots[3] };

type Series = { name: string; color: string; values: number[] };
type ChartProps = { labels: string[]; series: Series[]; moneyAxis?: boolean; title: string; format?: (value: number) => string };

function Toggle({ table, setTable }: { table: boolean; setTable: (value: boolean) => void }) {
  return <button className="table-toggle" type="button" aria-pressed={table} onClick={() => setTable(!table)}>{table ? "Chart" : "Table"}</button>;
}

function DataTable({ labels, series, moneyAxis, format }: Omit<ChartProps, "title">) {
  const show = format || (moneyAxis ? money : compact);
  return <div className="chart-table"><table><thead><tr><th>Point</th>{series.map((item) => <th key={item.name}>{item.name}</th>)}</tr></thead><tbody>{labels.map((label, index) => <tr key={`${label}-${index}`}><td>{label}</td>{series.map((item) => <td key={item.name}>{show(item.values[index])}</td>)}</tr>)}</tbody></table></div>;
}

export function LineChart({ labels, series, moneyAxis = false, title, format, marker }: ChartProps & { marker?: { at: number; label: string } }) {
  const show = format || (moneyAxis ? money : compact);
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const width = 760, height = 250, left = 48, right = 18, top = 18, bottom = 34;
  const max = Math.max(0, ...series.flatMap((item) => item.values)) || 1;
  const x = (i: number) => left + (labels.length <= 1 ? 0 : i * (width - left - right) / (labels.length - 1));
  const y = (value: number) => top + (height - top - bottom) * (1 - value / max);
  const ticks = [0, max / 2, max];
  const id = useId();
  return <section className="chart" aria-label={title}>
    <div className="chart-heading"><h3>{title}</h3><Toggle table={table} setTable={setTable} /></div>
    {series.length >= 2 && <div className="legend">{series.map((item) => <span key={item.name}><i style={{ background: item.color }} />{item.name}</span>)}</div>}
    {table ? <DataTable labels={labels} series={series} moneyAxis={moneyAxis} format={format} /> : <div className="chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        <title>{title}</title>
        {ticks.map((tick) => <g key={tick}><line className="grid" x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} /><text className="axis-label" x={left - 8} y={y(tick) + 4} textAnchor="end">{format ? format(tick) : moneyAxis ? `$${compact(tick)}` : compact(tick)}</text></g>)}
        <line className="axis" x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} />
        {marker && <g><line className="marker" x1={x(marker.at)} x2={x(marker.at)} y1={top} y2={height - bottom} /><text className="marker-label" x={x(marker.at) - 6} y={top + 10} textAnchor="end">{marker.label}</text></g>}
        {series.map((item, seriesIndex) => {
          const points = item.values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
          const area = `${left},${height - bottom} ${points} ${x(labels.length - 1)},${height - bottom}`;
          return <g key={item.name}><polygon points={area} fill={item.color} opacity=".1" /><polyline points={points} fill="none" stroke={item.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />{item.values.map((value, index) => <circle key={index} cx={x(index)} cy={y(value)} r="4" fill={item.color} stroke="var(--surface)" strokeWidth="2" />)}</g>;
        })}
        {labels.map((label, index) => <g key={`${id}-${index}`} tabIndex={0} role="button" aria-label={`${label}: ${series.map((s) => `${s.name} ${s.values[index]}`).join(", ")}`} onFocus={() => setHover(index)} onBlur={() => setHover(null)} onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)}><rect className="hit" x={x(index) - Math.max(12, (width - left - right) / Math.max(labels.length, 2) / 2)} y={top} width={Math.max(24, (width - left - right) / Math.max(labels.length, 2))} height={height - top - bottom} /></g>)}
        {hover != null && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={top} y2={height - bottom} />}
        {labels.map((label, index) => (index === 0 || index === labels.length - 1 || labels.length < 8) && <text key={`axis-${index}`} className="axis-label" x={x(index)} y={height - 10} textAnchor={index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle"}>{label}</text>)}
      </svg>
      {hover != null && <div className="tooltip" style={{ left: `${Math.min(76, Math.max(8, x(hover) / width * 100))}%` }}><strong>{labels[hover]}</strong>{series.map((item) => <span key={item.name}><i style={{ background: item.color }} /><b>{show(item.values[hover])}</b><small>{item.name}</small></span>)}</div>}
    </div>}
  </section>;
}

export function StackedBars({ labels, series, moneyAxis = false, title, format }: ChartProps) {
  const show = format || (moneyAxis ? money : compact);
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<{ s: number; i: number } | null>(null);
  const width = 760, height = 250, left = 48, right = 18, top = 18, bottom = 34;
  const totals = labels.map((_, i) => series.reduce((sum, item) => sum + (item.values[i] || 0), 0));
  const max = Math.max(0, ...totals) || 1, plot = height - top - bottom;
  const band = (width - left - right) / Math.max(labels.length, 1), bar = Math.min(24, band - 2);
  const y = (value: number) => top + plot * (1 - value / max);
  return <section className="chart" aria-label={title}><div className="chart-heading"><h3>{title}</h3><Toggle table={table} setTable={setTable} /></div>
    {series.length >= 2 && <div className="legend">{series.map((item) => <span key={item.name}><i style={{ background: item.color }} />{item.name}</span>)}</div>}
    {table ? <DataTable labels={labels} series={series} moneyAxis={moneyAxis} format={format} /> : <div className="chart-wrap"><svg viewBox={`0 0 ${width} ${height}`} role="img"><title>{title}</title>
      {[0, max / 2, max].map((tick) => <g key={tick}><line className="grid" x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} /><text className="axis-label" x={left - 8} y={y(tick) + 4} textAnchor="end">{format ? format(tick) : moneyAxis ? `$${compact(tick)}` : compact(tick)}</text></g>)}
      {labels.map((label, i) => { let sum = 0; return <g key={label}>{series.map((item, s) => { const value = item.values[i] || 0; const yTop = y(sum + value), yBottom = y(sum); sum += value; return <rect key={item.name} tabIndex={0} className="bar" x={left + i * band + (band - bar) / 2} y={yTop} width={bar} height={Math.max(0, yBottom - yTop - 2)} fill={item.color} rx="2" onFocus={() => setHover({ s, i })} onBlur={() => setHover(null)} onMouseEnter={() => setHover({ s, i })} onMouseLeave={() => setHover(null)} />; })}<text className="axis-label" x={left + (i + .5) * band} y={height - 10} textAnchor="middle">{labels.length < 10 || i % 2 === 0 ? label : ""}</text></g>; })}
      <line className="axis" x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} />
    </svg>{hover && <div className="tooltip" style={{ left: `${Math.min(76, Math.max(8, (hover.i + .5) / labels.length * 100))}%` }}><strong>{labels[hover.i]}</strong><span><i style={{ background: series[hover.s].color }} /><b>{show(series[hover.s].values[hover.i])}</b><small>{series[hover.s].name}</small></span></div>}</div>}
  </section>;
}

export function SegmentedBar({ rows }: { rows: Array<{ name: string; value: number; color: string }> }) {
  const total = rows.reduce((sum, row) => sum + row.value, 0) || 1;
  const [table, setTable] = useState(false);
  return <section className="chart opening-bar"><div className="chart-heading"><h3>Opening breakdown</h3><Toggle table={table} setTable={setTable} /></div>{table ? <DataTable labels={["Opening"]} series={rows.map((row) => ({ name: row.name, color: row.color, values: [row.value] }))} /> : <><div className="tall-bar">{rows.map((row) => { const share = row.value / total * 100; return <div key={row.name} title={`${row.name}: ${compact(row.value)} (${share.toFixed(1)}%)`} style={{ height: `${share}%`, background: row.color }}>{share >= 9 ? `${Math.round(share)}%` : ""}</div>; })}</div><div className="block-legend">{rows.map((row) => <span key={row.name}><i style={{ background: row.color }} />{row.name}<b>{compact(row.value)}</b></span>)}</div></>}</section>;
}
