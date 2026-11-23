import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeepWarm, MARKER, isKeepWarm } from "./keepwarm-core.mjs";

function harness(options = {}) {
    let t = 1_000_000;
    const timers = [];
    const sent = [];
    const logs = [];
    const kw = createKeepWarm({
        now: () => t,
        setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
        clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
        send: async (p) => { sent.push(p); },
        log: (e) => logs.push(e),
        options,
    });
    const advance = async (ms) => {
        const end = t + ms;
        for (;;) {
            timers.sort((a, b) => a.at - b.at);
            const next = timers[0];
            if (!next || next.at > end) break;
            timers.shift();
            t = next.at;
            await next.fn();
        }
        t = end;
    };
    const usage = (ttlMs, context = 100_000, model = "claude-opus-5.5", extra = {}) =>
        kw.onUsage({ model, inputTokens: context, cacheExpiresAt: new Date(t + ttlMs).toISOString(), ...extra });
    // A finished keep-warm turn: its usage refreshes the expiry, then the session goes idle again.
    const answer = (ttlMs, model) => { kw.onUserMessage({ content: sent.at(-1) }); kw.onTurnStart(); usage(ttlMs, 100_000, model); kw.onIdle(); };
    return { kw, sent, logs, advance, usage, answer, now: () => t, jump: (ms) => { t += ms; }, timers };
}

async function idleFor(h, ms, ttlMs, model) {
    const step = 1_000;
    let seen = h.sent.length;
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
        await h.advance(step);
        if (h.sent.length > seen) { seen = h.sent.length; h.answer(ttlMs, model); }
    }
}

test("should ping 45s before a 5-minute expiry after a human turn", async () => {
    const h = harness();
    h.kw.onUserMessage({ content: "fix the bug" });
    h.usage(300_000);
    assert.equal(h.kw.onIdle(), 255_000);
    await h.advance(254_000);
    assert.equal(h.sent.length, 0);
    await h.advance(1_000);
    assert.equal(h.sent.length, 1);
    assert.ok(h.sent[0].startsWith(MARKER));
});

test("should keep an Opus cache warm for an hour, then stop", async () => {
    const h = harness();
    h.kw.onUserMessage({ content: "work" });
    h.usage(300_000);
    h.kw.onIdle();
    await idleFor(h, 3 * 60 * 60_000, 300_000);
    assert.ok(h.sent.length >= 12 && h.sent.length <= 12, `pings=${h.sent.length}`);
});

test("should ping a 30-minute Sol cache only twice in an hour", async () => {
    const h = harness();
    h.kw.onUserMessage({ content: "work" });
    h.usage(1_800_000, 100_000, "gpt-6.1-sol");
    h.kw.onIdle();
    await idleFor(h, 3 * 60 * 60_000, 1_800_000, "gpt-6.1-sol");
    assert.equal(h.sent.length, 2);
});

test("should reset after a real user message and record a warm return", async () => {
    const h = harness();
    h.kw.onUserMessage({ content: "work" });
    h.usage(300_000);
    h.kw.onIdle();
    await idleFor(h, 400_000, 300_000);
    assert.equal(h.kw.state.pings, 1);
    h.kw.onUserMessage({ content: "back" });
    assert.equal(h.kw.state.pings, 0);
    assert.equal(h.logs.find((l) => l.event === "return")?.warm, true);
});

test("should never ping sessions without a human message", () => {
    for (const msg of [{ content: "cron", source: "system" }, { content: "go", agentMode: "autopilot" }, { content: "x", source: "agent-123" }, { content: "c", isAutopilotContinuation: true }]) {
        const h = harness();
        h.kw.onUserMessage(msg);
        h.usage(300_000);
        assert.equal(h.kw.onIdle(), null, JSON.stringify(msg));
    }
});

test("should skip small contexts, ignore subagent usage, and wait while the user is asked something", () => {
    const small = harness();
    small.kw.onUserMessage({ content: "hi" });
    small.usage(300_000, 10_000);
    assert.equal(small.kw.onIdle(), null);

    const sub = harness();
    sub.kw.onUserMessage({ content: "hi" });
    sub.usage(300_000);
    sub.usage(1_000, 500_000, "claude-sonnet-5.5", { parentToolCallId: "t1" });
    assert.equal(sub.kw.onIdle(), 255_000);

    const ask = harness();
    ask.kw.onUserMessage({ content: "hi" });
    ask.usage(300_000);
    ask.kw.onInputRequested();
    assert.equal(ask.kw.onIdle(), null);
});

test("should cancel a pending ping when a turn starts", async () => {
    const h = harness();
    h.kw.onUserMessage({ content: "work" });
    h.usage(300_000);
    h.kw.onIdle();
    h.kw.onTurnStart();
    await h.advance(400_000);
    assert.equal(h.sent.length, 0);
});

test("should not ping after the cache already expired", async () => {
    const h = harness({ marginMs: 0 });
    h.kw.onUserMessage({ content: "work" });
    h.usage(-1_000);
    h.kw.onIdle();
    await h.advance(10_000);
    assert.equal(h.sent.length, 0);
});

test("should recognise its own marker", () => {
    assert.equal(isKeepWarm(`${MARKER} x`), true);
    assert.equal(isKeepWarm("hello"), false);
});

test("should not treat its own ping as a return when the timeline shows the display text", async () => {
    const h = harness();
    h.kw.onUserMessage({ content: "work" });
    h.usage(300_000);
    h.kw.onIdle();
    await h.advance(255_000);
    h.kw.onUserMessage({ content: `${MARKER} ping` });
    assert.equal(h.kw.state.pings, 1);
    assert.equal(h.logs.filter((l) => l.event === "return").length, 0);
});

test("should preserve the idle allowance after agent, system, automation and continuation messages", async () => {
    for (const extra of [{ source: "agent-123" }, { source: "system" }, { source: "automation" }, { agentMode: "autopilot" }, { isAutopilotContinuation: true }]) {
        const h = harness();
        h.kw.onUserMessage({ content: "work" });
        h.usage(300_000);
        h.kw.onIdle();
        await idleFor(h, 400_000, 300_000);
        const idleSince = h.kw.state.idleSince;
        h.kw.onUserMessage({ content: "nonhuman work", ...extra });
        assert.equal(h.kw.state.pings, 1, JSON.stringify(extra));
        assert.equal(h.kw.state.idleSince, idleSince, JSON.stringify(extra));
        assert.equal(h.logs.filter((l) => l.event === "return").length, 0);
        assert.equal(h.kw.state.busy, true);
        assert.equal(h.timers.length, 0);
    }
});

test("should not re-arm an exhausted twelve-ping allowance through cross-session work", async () => {
    const h = harness();
    h.kw.onUserMessage({ content: "work" });
    h.usage(300_000);
    h.kw.onIdle();
    await idleFor(h, 3 * 60 * 60_000, 300_000);
    assert.equal(h.sent.length, 12);
    h.kw.onUserMessage({ content: "continue", source: "agent-123" });
    h.usage(300_000);
    assert.equal(h.kw.onIdle(), null);
    await idleFor(h, 20 * 60_000, 300_000);
    assert.equal(h.sent.length, 12);
    h.kw.onUserMessage({ content: "I am back", agentMode: "interactive" });
    h.usage(300_000);
    h.kw.onIdle();
    await h.advance(255_000);
    assert.equal(h.sent.length, 13);
});

test("should not extend the one-hour allowance when fewer than twelve pings were used", async () => {
    const h = harness();
    h.kw.onUserMessage({ content: "work" });
    h.usage(1_800_000);
    h.kw.onIdle();
    await idleFor(h, 61 * 60_000, 1_800_000);
    assert.equal(h.sent.length, 2);
    const idleSince = h.kw.state.idleSince;
    h.kw.onUserMessage({ content: "automated continuation", isAutopilotContinuation: true });
    h.usage(1_800_000);
    assert.equal(h.kw.state.idleSince, idleSince);
    assert.equal(h.kw.onIdle(), null);
    await h.advance(1_800_000);
    assert.equal(h.sent.length, 2);
});

test("should reject a delayed timer beyond the idle window even if usage refreshed its expiry", async () => {
    const h = harness();
    h.kw.onUserMessage({ content: "work" });
    h.usage(300_000);
    h.kw.onIdle();
    const timer = h.timers[0];
    h.jump(61 * 60_000);
    h.usage(300_000);
    await timer.fn();
    assert.equal(h.sent.length, 0);
});

test("should remain unarmed on a new core instance until a genuine human event", () => {
    const h = harness();
    h.kw.onUserMessage({ content: "resumed by worker", source: "agent-123" });
    h.usage(300_000);
    assert.equal(h.kw.onIdle(), null);
    h.kw.onUserMessage(undefined);
    h.usage(300_000);
    assert.equal(h.kw.onIdle(), null);
    h.kw.onUserMessage({ content: "", attachments: [{ type: "file" }], agentMode: "plan" });
    h.usage(300_000);
    assert.equal(h.kw.onIdle(), 255_000);
});
