// Extension: keep-warm (agent-kit)
// Keeps an idle human session's prompt cache from expiring for up to an hour. See keepwarm-core.mjs.
// Off switch: set AGENT_KIT_KEEPWARM=0, or delete this folder.

import { joinSession } from "@github/copilot-sdk/extension";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createKeepWarm, MARKER } from "./keepwarm-core.mjs";

const logDir = join(homedir(), ".agent-handoffs");
let sessionId = "";

function log(entry) {
    try {
        mkdirSync(logDir, { recursive: true });
        appendFileSync(join(logDir, "keepwarm.jsonl"), JSON.stringify({ ts: new Date().toISOString(), session: sessionId, ...entry }) + "\n");
    } catch { /* logging must never break a session */ }
}

const session = await joinSession({ hooks: {} });
sessionId = session.sessionId ?? "";

if (process.env.AGENT_KIT_KEEPWARM !== "0") {
    const kw = createKeepWarm({
        send: (prompt) => session.send({ prompt, displayPrompt: `${MARKER} ping` }),
        log,
    });
    session.on("user.message", (e) => kw.onUserMessage(e.data));
    session.on("assistant.turn_start", () => kw.onTurnStart());
    session.on("assistant.usage", (e) => kw.onUsage(e.data));
    session.on("user_input.requested", () => kw.onInputRequested());
    session.on("user_input.completed", () => kw.onInputCompleted());
    session.on("session.idle", () => kw.onIdle());
}
