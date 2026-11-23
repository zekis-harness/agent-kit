import { Database } from "bun:sqlite";
import { paths } from "./db";
import { buildAssets } from "./assets";
import { createBackgroundIndexer } from "./background-indexer";
import { createApiHandler, spawnVerdict } from "./api";
import { environmentConfig } from "./environments";

export async function startServer() {
  environmentConfig();
  const port = Number(process.env.DASH_PORT || 4319);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("DASH_PORT must be a local port from 1 through 65535");
  const file = paths().db;
  const indexer = createBackgroundIndexer(file);
  const [assets, result] = await Promise.all([buildAssets(), indexer.run()]).catch(async (error) => {
    await indexer.close();
    throw error;
  });
  const db = new Database(file, { readonly: true });
  console.log(`${result.files} files, ${result.sessions} sessions, ${result.newRequests} new deduped requests (${result.requests} total), $${result.total.toFixed(2)}, ${result.seconds.toFixed(2)}s`);
  console.log(`Copilot: ${result.copilot.files} files, ${result.copilot.requests} deduped calls; per-call coverage is partial.`);
  const api = createApiHandler(db, spawnVerdict);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      routes: {
        "/api/overview": (request) => api(request),
        "/api/sessions": (request) => api(request),
        "/api/sessions/:id": (request) => api(request, request.params),
        "/api/opening": (request) => api(request),
        "/api/agent-kit": (request) => api(request),
        "/api/handoffs": (request) => api(request),
        "/api/verdict": (request) => api(request),
        "/api/usage": (request) => api(request),
        "/api/environment": (request) => api(request),
        "/api/limits": (request) => api(request),
        "/api/usage/sessions/:id": (request) => api(request, request.params),
      },
      fetch: (request) => assets.respond(request),
      development: false,
    });
  } catch (error) {
    db.close();
    await indexer.close();
    throw error;
  }
  console.log(`Usage dashboard: ${server.url}`);
  let indexing = false;
  const refresh = setInterval(async () => {
    if (indexing) return;
    indexing = true;
    try {
      const result = await indexer.run();
      console.log(`Index refresh complete: ${result.seconds.toFixed(2)}s, ${result.copilot.bytesRead} new Copilot source bytes`);
    } catch (error) {
      const message = `Usage index refresh failed; showing the previous index: ${error instanceof Error ? error.message : String(error)}`;
      console.error(message);
    }
    finally { indexing = false; }
  }, 60000);
  refresh.unref();
  return server;
}

if (import.meta.main) await startServer();
