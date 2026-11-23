import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyzeTranscripts, validatePricing } from "../bin/analyze-transcripts.mjs";

const timestamp = "2026-11-01T12:00:00Z";
const usage = {
    input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 30,
    cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 },
    output_tokens: 5,
};
const assistant = (id, content = [], tokens = usage, model = "model-a") => ({
    type: "assistant", sessionId: "session", timestamp,
    message: { id, model, content, usage: tokens },
});
const result = (id, content, extra = {}) => ({
    type: "user", sessionId: "session", timestamp, ...extra,
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
});
const tool = (id, name) => ({ type: "tool_use", id, name, input: { private: "never report arguments" } });
const pricing = {
    source: "synthetic test prices, not provider rates", asOf: "2026-11-01",
    models: {
        "model-a": {
            input_tokens: 2, cache_read_input_tokens: 0.2, output_tokens: 10,
            cache_creation_5m_input_tokens: 3, cache_creation_1h_input_tokens: 4,
        },
        "model-b": { input_tokens: 1, cache_read_input_tokens: 0.1, output_tokens: 5 },
    },
};

async function analyze(t, records, options = {}, extraFiles = []) {
    const root = await mkdtemp(join(tmpdir(), "agent-kit-analysis-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "private-topic.jsonl"), records.map((r) => JSON.stringify(r)).join("\n"));
    for (const [name, rows] of extraFiles) {
        await mkdir(join(root, name, ".."), { recursive: true });
        await writeFile(join(root, name), rows.map((r) => JSON.stringify(r)).join("\n"));
    }
    return analyzeTranscripts({ root, ...options });
}

test("should merge streamed assistant chunks and cumulative usage without early deduplication", async (t) => {
    const report = await analyze(t, [
        assistant("m1", [{ type: "text", text: "private prompt" }], { input_tokens: 10, output_tokens: 1 }),
        result("tool-2", "returned before declaration"),
        assistant("m1", [tool("tool-1", "Read")], { ...usage, output_tokens: 3 }),
        assistant("m1", [tool("tool-2", "browser_evaluate")]),
        assistant("m1", [tool("tool-2", "browser_evaluate")]),
        result("tool-1", "hello"),
        result("tool-1", "hello"),
    ], { pricing });
    assert.equal(report.logicalAssistantMessages, 1);
    assert.equal(report.usageMessages, 1);
    assert.equal(report.tokens.output_tokens, 5);
    assert.equal(report.tokens.cache_creation_5m_input_tokens, 20);
    assert.equal(report.peakContextTokens, 140);
    assert.equal(report.toolCalls, 2);
    assert.equal(report.toolResults, 2);
    assert.equal(report.tools.Read.calls, 1);
    assert.equal(report.tools.browser_evaluate.results, 1);
    assert.equal(report.unknownToolResults, 0);
    assert.equal(report.models["model-a"].costUsd, 0.00019);
    const serialized = JSON.stringify(report);
    for (const secret of ["private-topic", "private prompt", "never report arguments", "hello", "returned before declaration"]) {
        assert.equal(serialized.includes(secret), false);
    }
});

test("should count UTF-8 serialized result content and expose missing attribution", async (t) => {
    const report = await analyze(t, [result("orphan", "caf\u00e9"), assistant("m", [tool("x", "Read")]), result("x", ["x"])]);
    assert.equal(report.unknownToolResults, 1);
    assert.equal(report.unknownToolResultBytes, Buffer.byteLength(JSON.stringify("caf\u00e9"), "utf8"));
    assert.equal(report.tools.Read.resultBytes, Buffer.byteLength(JSON.stringify(["x"]), "utf8"));
    assert.equal(report.models["model-a"].costUsd, null);
    assert.equal(report.costUsd, null);
    assert.ok(report.models["model-a"].unpricedTokens > 0);
});

test("should not collapse messages with missing ids or usage and should report missing fields", async (t) => {
    const report = await analyze(t, [
        assistant(undefined, [], { input_tokens: 5 }),
        assistant(undefined, [], { input_tokens: 6 }),
        assistant("no-usage", [tool("x", "Read")], undefined),
    ].map((e, i) => i === 2 ? { ...e, message: { ...e.message, usage: undefined } } : e));
    assert.equal(report.logicalAssistantMessages, 3);
    assert.equal(report.usageMessages, 2);
    assert.equal(report.toolCalls, 1);
    assert.equal(report.diagnostics.missingAssistantIds, 2);
    assert.equal(report.diagnostics.messagesWithoutUsage, 1);
    assert.equal(report.costUsd, null);
    assert.equal(report.models["model-a"].missingUsageFields.output_tokens, 2);
});

test("should deduplicate overlapping session files but keep subagent and other-session messages separate", async (t) => {
    const row = assistant("same-id", [tool("same-tool", "Read")]);
    const report = await analyze(t, [row], {}, [
        ["copy.jsonl", [row]],
        ["other.jsonl", [{ ...row, sessionId: "other-session" }]],
        [join("subagents", "agent-x.jsonl"), [row]],
    ]);
    assert.equal(report.filesScanned, 4);
    assert.equal(report.sessions.length, 3);
    assert.equal(report.logicalAssistantMessages, 3);
    assert.equal(report.toolCalls, 3);
    assert.equal(report.sessions.filter((s) => s.subagent).length, 1);
});

test("should price actual models independently and never assume a cache-write TTL", async (t) => {
    const noTtl = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 30, output_tokens: 5 };
    const report = await analyze(t, [assistant("a", [], noTtl), assistant("b", [], { ...noTtl, cache_creation_input_tokens: 0 }, "model-b")], { pricing });
    assert.equal(report.models["model-a"].tokens.cache_creation_unknown_input_tokens, 30);
    assert.equal(report.models["model-a"].costUsd, null);
    assert.equal(report.models["model-a"].knownCostUsd, 0.00009);
    assert.equal(report.models["model-b"].costUsd, 0.000045);
    assert.equal(report.costUsd, null);
    const explicit = structuredClone(pricing);
    explicit.models["model-a"].cache_creation_unknown_input_tokens = 6;
    const estimated = await analyze(t, [assistant("a", [], noTtl)], { pricing: explicit });
    assert.equal(estimated.costUsd, 0.00027);
    assert.equal(estimated.tokens.cache_creation_unknown_input_tokens, 30);
    assert.deepEqual(estimated.pricing, { source: explicit.source, asOf: explicit.asOf });
});

test("should expose conflicting snapshots rather than summing or silently dropping them", async (t) => {
    const report = await analyze(t, [
        assistant("m", [tool("x", "Read")]),
        assistant("m", [tool("x", "Bash")], { ...usage, output_tokens: 2 }),
        result("x", "x"), result("x", "longer"),
    ]);
    assert.equal(report.tokens.output_tokens, 5);
    assert.ok(report.diagnostics.usageRegressions > 0);
    assert.ok(report.diagnostics.conflictingToolNames > 0);
    assert.ok(report.diagnostics.conflictingToolResults > 0);
    assert.equal(report.unknownToolResults, 1);
    assert.equal(report.toolCalls, 1);
});

test("should select logical messages by recorded timestamps rather than file modification time", async (t) => {
    const report = await analyze(t, [
        { ...assistant("old"), timestamp: "2026-10-01T00:00:00Z" },
        { ...assistant("new"), timestamp: "2026-11-02T00:00:00Z" },
        { ...assistant("undated"), timestamp: undefined },
    ], { since: "2026-11-01T00:00:00Z", until: "2026-11-03T00:00:00Z" });
    assert.equal(report.logicalAssistantMessages, 1);
    assert.equal(report.diagnostics.excludedUndatedMessages, 1);
});

test("should report malformed JSON and invalid usage without leaking the bad line", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agent-kit-analysis-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "bad.jsonl"), 'private malformed prompt\n' + JSON.stringify(assistant("m", [], { ...usage, input_tokens: -1 })));
    const report = await analyzeTranscripts({ root });
    assert.equal(report.diagnostics.malformedRecords, 1);
    assert.equal(report.diagnostics.invalidUsageValues, 1);
    assert.equal(report.tokens.input_tokens, 0);
    assert.equal(JSON.stringify(report).includes("private malformed prompt"), false);
    await assert.rejects(analyzeTranscripts({ root, since: "not-a-date" }), /since/);
    await assert.rejects(analyzeTranscripts({ root, since: timestamp, until: "2020-01-01T00:00:00Z" }), /until/);
    await assert.rejects(analyzeTranscripts({ root: join(root, "missing") }), /ENOENT/);
});

test("should require attributable, finite, nonnegative explicitly configured prices", () => {
    assert.throws(() => validatePricing({ models: {} }), /source/);
    assert.throws(() => validatePricing({ ...pricing, models: { a: { input_tokens: -1 } } }), /input_tokens/);
    assert.throws(() => validatePricing({ ...pricing, models: { a: { input_tokens: "5" } } }), /input_tokens/);
    assert.throws(() => validatePricing({ ...pricing, models: { a: { unknown: 5 } } }), /unknown/);
    assert.doesNotThrow(() => validatePricing(pricing));
});

test("should treat model and tool names as untrusted dictionary keys", async (t) => {
    const report = await analyze(t, [assistant("m", [tool("x", "__proto__")], usage, "toString"), result("x", "value")]);
    assert.equal(report.models.toString.usageMessages, 1);
    assert.equal(report.tools.__proto__.calls, 1);
    assert.equal(report.tools.__proto__.results, 1);
    assert.equal(report.costUsd, null);
});

test("should not present unpriced zero usage or inconsistent TTL snapshots as a complete cost", async (t) => {
    const zero = Object.fromEntries(Object.keys(usage).filter((key) => key !== "cache_creation").map((key) => [key, 0]));
    const report = await analyze(t, [assistant("zero", [], zero)]);
    assert.equal(report.costUsd, null);
    const inconsistent = await analyze(t, [assistant("inconsistent", [], { ...usage, cache_creation_input_tokens: 1 })], { pricing });
    assert.equal(inconsistent.costUsd, null);
    assert.equal(inconsistent.diagnostics.inconsistentCacheCreation, 1);
    assert.equal(inconsistent.tokens.cache_creation_5m_input_tokens, 20);
});

test("should distinguish legacy agent files and explicit agent metadata from the main conversation", async (t) => {
    const row = assistant("same-id");
    const report = await analyze(t, [row, { ...row, agentId: "worker" }], {}, [
        ["agent-legacy.jsonl", [{ ...row, isSidechain: true }]],
    ]);
    assert.equal(report.logicalAssistantMessages, 3);
    assert.equal(report.sessions.filter((s) => s.subagent).length, 2);
});

test("should run the local CLI end to end and fail explicitly without echoing malformed pricing", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agent-kit-analysis-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "fixture.jsonl"), JSON.stringify(assistant("one")));
    const script = fileURLToPath(new URL("../bin/analyze-transcripts.mjs", import.meta.url));
    const result = JSON.parse(execFileSync(process.execPath, [script, "--root", root], { encoding: "utf8" }));
    assert.equal(result.logicalAssistantMessages, 1);
    const config = join(root, "prices.json");
    await writeFile(config, "private malformed content");
    const invalid = spawnSync(process.execPath, [script, "--root", root, "--pricing", config], { encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /Pricing file must contain valid JSON/);
    assert.equal(invalid.stderr.includes("private malformed content"), false);
});
