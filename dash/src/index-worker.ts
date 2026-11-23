import { parentPort, workerData } from "node:worker_threads";
import { openDb } from "./db";
import { runIndex } from "./indexer";

if (!parentPort || !workerData || typeof workerData.file !== "string") throw new Error("Indexer requires a local database and parent port");
const port = parentPort;
const db = openDb(workerData.file);
port.on("message", async () => {
  try {
    const result = await runIndex(db);
    db.exec("DELETE FROM copilot_meta WHERE key='refresh_error'");
    port.postMessage({ ok: true, result });
  } catch (error) {
    const message = `Usage index refresh failed; showing the previous index: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    if (db.query("SELECT name FROM sqlite_master WHERE name='copilot_meta'").get()) {
      db.query("INSERT OR REPLACE INTO copilot_meta VALUES('refresh_error',?)").run(message);
    }
    port.postMessage({ ok: false, message });
  }
});
