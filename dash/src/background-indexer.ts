import { Worker } from "node:worker_threads";
import type { runIndex } from "./indexer";

type Result = Awaited<ReturnType<typeof runIndex>>;
type Reply = { ok: true; result: Result } | { ok: false; message: string };

export function createBackgroundIndexer(file: string) {
  const worker = new Worker(new URL("./index-worker.ts", import.meta.url), { workerData: { file } });
  let pending: { resolve: (result: Result) => void; reject: (error: Error) => void } | null = null;
  let closed = false;
  let failure: Error | null = null;
  const fail = (error: Error) => { pending?.reject(error); pending = null; };
  worker.on("message", (reply: Reply) => {
    const request = pending;
    pending = null;
    if (reply.ok) request?.resolve(reply.result); else request?.reject(new Error(reply.message));
  });
  worker.on("error", (error) => {
    failure = error instanceof Error ? error : new Error(String(error));
    fail(failure);
  });
  worker.on("exit", () => {
    if (!closed) { failure = new Error("Background indexer exited unexpectedly"); fail(failure); }
  });
  return {
    run(): Promise<Result> {
      if (closed) throw new Error("Background indexer is closed");
      if (failure) throw failure;
      if (pending) throw new Error("Background indexer is already running");
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        worker.postMessage("index");
      });
    },
    async close() {
      closed = true;
      fail(new Error("Background indexer closed"));
      await worker.terminate();
    },
  };
}
