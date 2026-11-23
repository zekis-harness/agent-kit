export const money = (value: number | null | undefined, compact = false) => {
  if (value == null) return "Unpriced";
  if (compact && Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const compact = (value: number | null | undefined) => {
  const n = Number(value || 0);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
};

export const duration = (start?: string, end?: string) => {
  if (!start || !end) return "n/a";
  const minutes = Math.max(0, (Date.parse(end) - Date.parse(start)) / 60000);
  return minutes >= 60 ? `${(minutes / 60).toFixed(1)}h` : `${Math.round(minutes)}m`;
};

export const seconds = (value?: number | null) => value == null ? "n/a" : value >= 60 ? `${Math.round(value / 60)}m` : `${Math.round(value)}s`;
export const date = (value?: string | null) => value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "n/a";
export const title = (value?: string | null, id?: string) => value || id || "Untitled session";
export const flagLabel = (value: string) => value.replaceAll("_", " ");
