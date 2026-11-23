import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { buildAssets } from "../src/assets";
import { createBackgroundIndexer } from "../src/background-indexer";

test("should finish bundling before serving root and every referenced local asset", async () => {
  const assets = await buildAssets();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => assets.respond(request) });
  try {
    for (let pass = 0; pass < 3; pass++) {
      const root = await fetch(server.url);
      expect(root.status).toBe(200);
      expect(root.headers.get("content-type")).toContain("text/html");
      const html = await root.text();
      const files = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]);
      expect(files.length).toBeGreaterThanOrEqual(2);
      for (const file of files) {
        expect(file).toStartWith("/");
        const response = await fetch(new URL(file, server.url));
        expect(response.status).toBe(200);
        expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
      }
    }
    expect((await fetch(new URL("/config.json", server.url))).status).toBe(404);
    expect((await fetch(new URL("/../package.json", server.url))).status).toBe(404);
  } finally { server.stop(true); }
});

test("should index and refresh on an independent worker with atomic derived results", async () => {
  const root = mkdtempSync(join(tmpdir(), "dash-worker-"));
  const previous = { projects: process.env.DASH_PROJECTS_DIR, handoffs: process.env.DASH_HANDOFFS_DIR, copilot: process.env.DASH_COPILOT_ROOTS };
  process.env.DASH_PROJECTS_DIR = join(root, "projects");
  process.env.DASH_HANDOFFS_DIR = join(root, "handoffs");
  process.env.DASH_COPILOT_ROOTS = "";
  mkdirSync(join(root, "projects", "test"), { recursive: true });
  writeFileSync(join(root, "projects", "test", "usage.jsonl"), JSON.stringify({
    type: "assistant", sessionId: "test", requestId: "call", timestamp: "2026-11-01T10:00:00Z",
    message: { model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 2 } },
  }) + "\n");
  const file = join(root, "usage.db");
  const indexer = createBackgroundIndexer(file);
  try {
    const first = indexer.run();
    expect(() => indexer.run()).toThrow("already running");
    expect((await first).requests).toBe(1);
    expect((await indexer.run()).newRequests).toBe(0);
    const reader = new Database(file, { readonly: true });
    expect(reader.query("SELECT count(*) n FROM requests").get()).toEqual({ n: 1 });
    expect(reader.query("SELECT count(*) n FROM sessions").get()).toEqual({ n: 1 });
    reader.close();
  } finally {
    await indexer.close();
    for (const [key, value] of [["DASH_PROJECTS_DIR", previous.projects], ["DASH_HANDOFFS_DIR", previous.handoffs], ["DASH_COPILOT_ROOTS", previous.copilot]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
