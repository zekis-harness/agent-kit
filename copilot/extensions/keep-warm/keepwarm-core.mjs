// Keep-warm logic, free of SDK imports so it can be tested with a fake session and clock.
//
// Copilot reports when the conversation's prompt cache expires (cacheExpiresAt on assistant.usage).
// Opus expires after 5 idle minutes and Sol after 30. A rebuild re-writes the whole conversation at
// the cache-write rate; a tiny message just before expiry re-reads it at the cache-read rate, about
// 1/25 of the cost (measured 2026-11-04: $0.0053 ping vs $0.122 rebuild on a 24k Opus prefix).
// So: while a human session sits idle, ping shortly before expiry, but only for a bounded window.

export const MARKER = "[keep-warm]";

export const DEFAULTS = {
    marginMs: 45_000,          // ping this long before the reported expiry
    minContextTokens: 30_000,  // below this a rebuild is too cheap to bother
    windowMs: 60 * 60_000,     // stop after this much idle time; a later return pays one rebuild
    maxPings: 12,              // hard cap per idle stretch (12 pings cost about half a rebuild)
};

export function isKeepWarm(text) {
    return typeof text === "string" && text.startsWith(MARKER);
}

export function createKeepWarm({ send, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, log = () => {}, options = {} }) {
    const o = { ...DEFAULTS, ...options };
    const s = { human: false, busy: false, awaitingInput: false, expiry: null, model: null, context: 0, idleSince: null, pings: 0, timer: null };

    const cancel = () => { if (s.timer) { clearTimer(s.timer); s.timer = null; } };
    const windowExpired = () => s.idleSince !== null && now() - s.idleSince > o.windowMs;

    function plan() {
        cancel();
        if (!s.human || s.busy || s.awaitingInput || !s.expiry) return null;
        if (s.context < o.minContextTokens) return null;
        if (s.pings >= o.maxPings || windowExpired()) return null;
        const at = s.expiry - o.marginMs;
        if (s.idleSince !== null && at - s.idleSince > o.windowMs) return null;
        const delay = Math.max(0, at - now());
        s.timer = setTimer(fire, delay);
        return delay;
    }

    async function fire() {
        s.timer = null;
        if (!s.human || s.busy || s.awaitingInput || s.pings >= o.maxPings || windowExpired()) return;
        if (now() > s.expiry) return; // too late, the cache is already gone
        s.pings++;
        s.busy = true;
        log({ event: "ping", n: s.pings, model: s.model, context: s.context });
        try {
            await send(`${MARKER} Session idle; this keeps the prompt cache warm. Reply with exactly: ok`);
        } catch (e) {
            s.busy = false;
            log({ event: "error", message: String(e?.message ?? e) });
        }
    }

    return {
        state: s,
        plan,
        onUserMessage(data) {
            const text = data?.content ?? "";
            if (isKeepWarm(text)) return;
            const human = typeof data?.content === "string" && !data?.source && data?.agentMode !== "autopilot" && !data?.isAutopilotContinuation;
            if (human) {
                s.human = true;
                if (s.idleSince !== null && s.pings > 0) {
                    log({ event: "return", pings: s.pings, idleMs: now() - s.idleSince, warm: s.expiry !== null && now() <= s.expiry });
                }
                s.pings = 0;
                s.idleSince = null;
            }
            s.busy = true;
            cancel();
        },
        onTurnStart() { s.busy = true; cancel(); },
        onUsage(data) {
            if (!data || data.parentToolCallId) return; // subagent calls have their own caches
            if (data.cacheExpiresAt) s.expiry = Date.parse(data.cacheExpiresAt);
            if (data.model) s.model = data.model;
            if (typeof data.inputTokens === "number") s.context = data.inputTokens;
        },
        onInputRequested() { s.awaitingInput = true; cancel(); },
        onInputCompleted() { s.awaitingInput = false; },
        onIdle() {
            s.busy = false;
            if (s.idleSince === null) s.idleSince = now();
            return plan();
        },
        dispose: cancel,
    };
}
