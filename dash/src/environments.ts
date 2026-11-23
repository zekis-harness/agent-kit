import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import config from "../config.json";

export type Environment = { id: string; label: string; index?: string; statusline?: string; claudeBoundary?: string; copilotBoundary?: string };
export type EnvironmentInfo = Omit<Environment, "index" | "statusline"> & { available: boolean; current: boolean; error?: string };

export function requireLocalPath(path: string) {
  if (/^(?:\\\\|\/\/|[a-z]+:\/\/)/i.test(path)) throw new Error("Dashboard sources must be local files, not network paths");
}

export function environmentConfig() {
  const file = process.env.DASH_ENVIRONMENTS_FILE;
  if (file) requireLocalPath(file);
  const values: unknown = file ? JSON.parse(readFileSync(file, "utf8")) : [];
  if (!Array.isArray(values)) throw new Error("DASH_ENVIRONMENTS_FILE must contain an array of local environments");
  const configured: Environment[] = values.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Invalid environment configuration");
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id === "all" || !/^[a-zA-Z0-9._-]+$/.test(row.id) || typeof row.label !== "string") {
      throw new Error("Environment requires an identifier and label");
    }
    const item: Environment = { id: row.id, label: row.label };
    if (row.index !== undefined) {
      if (typeof row.index !== "string" || /^[a-z]+:\/\//i.test(row.index)) throw new Error("Environment indexes must be local file paths");
      requireLocalPath(row.index);
      item.index = resolve(dirname(file!), row.index);
    }
    if (row.statusline !== undefined) {
      if (typeof row.statusline !== "string") throw new Error("Statusline sources must be local file paths");
      requireLocalPath(row.statusline);
      item.statusline = resolve(dirname(file!), row.statusline);
    }
    for (const key of ["claudeBoundary", "copilotBoundary"] as const) {
      if (row[key] !== undefined) {
        if (typeof row[key] !== "string" || !Number.isFinite(Date.parse(row[key]))) throw new Error(`Invalid ${key}`);
        item[key] = new Date(row[key]).toISOString();
      }
    }
    return item;
  });
  if (new Set(configured.map((e) => e.id)).size !== configured.length) throw new Error("Environment identifiers must be unique");
  const id = process.env.DASH_ENVIRONMENT || "local";
  if (id === "all" || !/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("Invalid DASH_ENVIRONMENT identifier");
  const current: Environment = {
    id, label: process.env.DASH_ENVIRONMENT_LABEL || "Local environment", claudeBoundary: config.agentKitStart,
    ...configured.find((e) => e.id === id),
  };
  const defaultHarness = process.env.DASH_DEFAULT_HARNESS || "claude";
  if (!["claude", "copilot", "all"].includes(defaultHarness)) throw new Error("Invalid DASH_DEFAULT_HARNESS");
  return { current, others: configured.filter((e) => e.id !== id), defaultHarness: defaultHarness as "claude" | "copilot" | "all" };
}

export function environmentInfo() {
  const config = environmentConfig();
  const safe = (e: Environment, current: boolean): EnvironmentInfo => ({
    id: e.id, label: e.label, claudeBoundary: e.claudeBoundary, copilotBoundary: e.copilotBoundary,
    current, available: current || !!e.index && existsSync(e.index),
  });
  return { current: config.current.id, defaultHarness: config.defaultHarness,
    environments: [safe(config.current, true), ...config.others.map((e) => safe(e, false))] };
}

export function withEnvironments<T>(db: Database, run: (sources: { db: Database; environment: EnvironmentInfo }[], info: EnvironmentInfo[]) => T) {
  const config = environmentConfig();
  const info = environmentInfo().environments;
  const sources = [{ db, environment: info[0] }];
  const readers: Database[] = [];
  try {
    for (const environment of config.others) {
      const state = info.find((e) => e.id === environment.id)!;
      if (!environment.index || !existsSync(environment.index)) continue;
      try {
        const reader = new Database(environment.index, { readonly: true });
        readers.push(reader);
        reader.exec("BEGIN");
        const supported = reader.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('requests','copilot_calls')").all();
        if (!supported.length) throw new Error("Not a supported local dashboard index");
        sources.push({ db: reader, environment: state });
      } catch (error) {
        state.available = false;
        state.error = error instanceof Error ? error.message : String(error);
      }
    }
    return run(sources, info);
  } finally { for (const reader of readers) reader.close(); }
}
