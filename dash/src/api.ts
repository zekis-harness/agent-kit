import type { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { agentKit, handoffs, openingContext, overview, sessionDetail, sessions, type Baseline, type Range, type SessionFilters, type SessionSort } from "./queries";
import { usageDetail, usageReport, type UsageOptions } from "./usage";
import { environmentInfo } from "./environments";
import { limitReport } from "./limits";

export type VerdictRunner = (argv: string[]) => Promise<{ exitCode: number; stderr?: string }>;

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

function localOrigin(value: string | null) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") && (url.port === (process.env.DASH_PORT || "4319") || url.port === "");
  } catch { return false; }
}

export function createApiHandler(db: Database, runner: VerdictRunner, repoRoot = resolve(import.meta.dir, "..", "..")) {
  const snapshot = <T>(read: () => T) => db.transaction(read)();
  return async (request: Request, params: Record<string, string> = {}) => {
    const url = new URL(request.url);
    if (!localOrigin(`http://${request.headers.get("host") || url.host}`)) return json({ error: "Local Host required" }, 403);
    try {
    if (request.method === "GET" && url.pathname === "/api/environment") return json(environmentInfo());
    if (request.method === "GET" && ["/api/usage", "/api/limits"].includes(url.pathname)) {
      const options: UsageOptions = {};
      const environment = url.searchParams.get("environment");
      if (environment && environment !== "all" && !environmentInfo().environments.some((e) => e.id === environment)) return json({ error: "Unknown environment" }, 400);
      if (environment) options.environment = environment;
      const harness = url.searchParams.get("harness") || "all";
      const baseline = url.searchParams.get("baseline") || "all";
      if (!["all", "claude", "copilot"].includes(harness) || !["all", "14d"].includes(baseline)) return json({ error: "Invalid usage filter" }, 400);
      options.harness = harness as UsageOptions["harness"];
      options.baseline = baseline as UsageOptions["baseline"];
      for (const key of ["from", "to", "boundary"] as const) {
        const value = url.searchParams.get(key);
        if (value) {
          if (!Number.isFinite(Date.parse(value))) return json({ error: `Invalid ${key} date` }, 400);
          options[key] = new Date(value).toISOString();
        }
      }
      if (options.from && options.to && options.from >= options.to) return json({ error: "From must precede To" }, 400);
      if (options.boundary && ((options.from && options.boundary <= options.from) || (options.to && options.boundary >= options.to))) return json({ error: "Comparison boundary must fall inside the date range" }, 400);
      options.model = url.searchParams.get("model") || undefined;
      return json(snapshot(() => url.pathname === "/api/limits" ? limitReport(db, options) : usageReport(db, options)));
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/usage/sessions/")) {
      const detail = snapshot(() => usageDetail(db, decodeURIComponent(params.id ?? url.pathname.slice("/api/usage/sessions/".length))));
      return detail ? json(detail) : json({ error: "Session not found" }, 404);
    }
      if (request.method === "GET" && url.pathname === "/api/overview") {
        const range = (url.searchParams.get("range") || "week") as Range;
        if (!["day", "week", "month"].includes(range)) return json({ error: "Invalid range" }, 400);
        return json(snapshot(() => overview(range, new Date(), db)));
      }
      if (request.method === "GET" && url.pathname === "/api/sessions") {
        const filters: SessionFilters = {};
        for (const key of ["project", "model", "kind", "flag"] as const) {
          const value = url.searchParams.get(key);
          if (value) (filters as any)[key] = value;
        }
        const sort: SessionSort = { by: (url.searchParams.get("sort") || "cost") as any, direction: (url.searchParams.get("direction") || "desc") as any };
        if (!["cost", "context", "turns", "duration"].includes(sort.by!)) return json({ error: "Invalid sort" }, 400);
        return json({ sessions: snapshot(() => sessions(filters, sort, db)) });
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
        const id = decodeURIComponent(params.id ?? url.pathname.slice("/api/sessions/".length));
        const detail = snapshot(() => sessionDetail(id, db));
        return detail ? json(detail) : json({ error: "Session not found" }, 404);
      }
      if (request.method === "GET" && url.pathname === "/api/opening") return json({ rows: snapshot(() => openingContext(db)) });
      if (request.method === "GET" && url.pathname === "/api/agent-kit") {
        const baseline = (url.searchParams.get("baseline") || "all") as Baseline;
        if (!["all", "14d"].includes(baseline)) return json({ error: "Invalid baseline" }, 400);
        return json(snapshot(() => agentKit(db, baseline)));
      }
      if (request.method === "GET" && url.pathname === "/api/handoffs") return json({ handoffs: snapshot(() => handoffs(db)) });
      if (request.method === "POST" && url.pathname === "/api/verdict") {
        if (!localOrigin(request.headers.get("origin"))) return json({ error: "Local Origin required" }, 403);
        const body = await request.json().catch(() => null) as any;
        if (!body || typeof body.run !== "string" || !["accepted", "rework"].includes(body.outcome)) return json({ error: "Invalid verdict" }, 400);
        const known = db.query("SELECT 1 ok FROM ledger_runs WHERE run=?").get(body.run);
        if (!known) return json({ error: "Unknown run" }, 404);
        const argv = ["pwsh", "-NoProfile", "-File", join(repoRoot, "bin", "verdict.ps1"), "-Run", body.run, "-Outcome", body.outcome];
        const result = await runner(argv);
        if (result.exitCode !== 0) return json({ error: "Verdict command failed", detail: result.stderr || "" }, 500);
        return json({ ok: true, run: body.run, outcome: body.outcome });
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: "Internal server error" }, 500);
    }
  };
}

export const spawnVerdict: VerdictRunner = async (argv) => {
  const process = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(process.stderr).text();
  return { exitCode: await process.exited, stderr };
};
