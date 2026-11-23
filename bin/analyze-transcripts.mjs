import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const BASE_TOKENS = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"];
const WRITE_TOKENS = ["cache_creation_5m_input_tokens", "cache_creation_1h_input_tokens", "cache_creation_unknown_input_tokens"];
const BILLABLE_TOKENS = [...BASE_TOKENS.filter((k) => k !== "cache_creation_input_tokens"), ...WRITE_TOKENS];
const UNKNOWN = "[unknown]";
const countTokens = () => Object.fromEntries([...BASE_TOKENS, ...WRITE_TOKENS].map((k) => [k, 0]));
const digest = (text) => createHash("sha256").update(text).digest("hex");
const roundCost = (value) => Number(value.toFixed(12));

export function validatePricing(pricing) {
    if (!pricing || typeof pricing.source !== "string" || !pricing.source.trim()) throw new Error("Pricing requires a nonempty source.");
    if (typeof pricing.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(pricing.asOf)) throw new Error("Pricing requires asOf: YYYY-MM-DD.");
    if (!pricing.models || typeof pricing.models !== "object" || Array.isArray(pricing.models)) throw new Error("Pricing requires a models object.");
    for (const [model, rates] of Object.entries(pricing.models)) {
        if (!rates || typeof rates !== "object" || Array.isArray(rates)) throw new Error(`Invalid rates for ${model}.`);
        for (const [key, rate] of Object.entries(rates)) {
            if (!BILLABLE_TOKENS.includes(key) || typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
                throw new Error(`Invalid pricing rate: ${model}.${key}.`);
            }
        }
    }
}

async function* transcriptFiles(root) {
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) yield* transcriptFiles(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
    }
}

function mergeUsage({ target, usage, diagnostics }) {
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) return 0;
    let issues = 0;
    for (const key of BASE_TOKENS) {
        if (usage[key] === undefined || usage[key] === null) continue;
        const value = usage[key];
        if (!Number.isSafeInteger(value) || value < 0) { diagnostics.invalidUsageValues++; issues++; continue; }
        if (target[key] !== undefined && value < target[key]) { diagnostics.usageRegressions++; issues++; }
        target[key] = Math.max(target[key] ?? 0, value);
    }
    for (const ttl of ["5m", "1h"]) {
        const key = `cache_creation_${ttl}_input_tokens`;
        const value = usage.cache_creation?.[`ephemeral_${ttl}_input_tokens`];
        if (value === undefined || value === null) continue;
        if (!Number.isSafeInteger(value) || value < 0) { diagnostics.invalidUsageValues++; issues++; continue; }
        if (target[key] !== undefined && value < target[key]) { diagnostics.usageRegressions++; issues++; }
        target[key] = Math.max(target[key] ?? 0, value);
    }
    return issues;
}

function recordTimestamp(record) {
    const parsed = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
}

function ingest({ session, record, diagnostics }) {
    const message = record.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const timestamp = recordTimestamp(record);
    if (record.type === "assistant") {
        // Claude persists cumulative snapshots with one message id, not independent API calls.
        const hasId = typeof message.id === "string" && message.id.length > 0;
        if (!hasId) diagnostics.missingAssistantIds++;
        const key = hasId ? `message:${message.id}` : typeof record.uuid === "string" ? `uuid:${record.uuid}` : `record:${session.ordinal++}`;
        let logical = session.messages.get(key);
        if (!logical) {
            logical = { usage: {}, usageIssues: 0, models: new Set(), tools: new Set(), timestamp };
            session.messages.set(key, logical);
        }
        if (timestamp !== null) logical.timestamp = Math.min(logical.timestamp ?? timestamp, timestamp);
        if (typeof message.model === "string" && message.model) logical.models.add(message.model);
        logical.usageIssues += mergeUsage({ target: logical.usage, usage: message.usage, diagnostics });
        for (const block of Array.isArray(message.content) ? message.content : []) {
            if (block?.type !== "tool_use") continue;
            const id = typeof block.id === "string" && block.id ? block.id : `missing:${key}:${logical.tools.size}`;
            if (!block.id) diagnostics.missingToolIds++;
            const names = session.tools.get(id) ?? new Set();
            if (typeof block.name === "string" && block.name) names.add(block.name);
            session.tools.set(id, names);
            logical.tools.add(id);
        }
    } else if (record.type === "user" && Array.isArray(message.content)) {
        for (const [index, block] of message.content.entries()) {
            if (block?.type !== "tool_result") continue;
            const id = typeof block.tool_use_id === "string" && block.tool_use_id ? block.tool_use_id : null;
            const key = id ?? `missing:${record.uuid ?? session.ordinal++}:${index}`;
            const serialized = JSON.stringify(block.content ?? null);
            const bytes = Buffer.byteLength(serialized, "utf8");
            const fingerprint = digest(serialized);
            const existing = session.results.get(key);
            if (existing && existing.fingerprint !== fingerprint) diagnostics.conflictingToolResults++;
            session.results.set(key, {
                id, bytes: Math.max(bytes, existing?.bytes ?? 0), fingerprint,
                timestamp: timestamp === null ? existing?.timestamp ?? null : Math.min(existing?.timestamp ?? timestamp, timestamp),
            });
        }
    }
}

function dateBoundary(value, label) {
    if (value === undefined) return null;
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
        throw new Error(`${label} must be an ISO timestamp with a timezone.`);
    }
    return Date.parse(value);
}

function summarize({ sessions, pricing, interval, diagnostics }) {
    const models = Object.create(null);
    const tools = Object.create(null);
    const rows = [];
    let unknownToolResults = 0;
    let unknownToolResultBytes = 0;
    const included = (timestamp) => {
        if (interval.since === null && interval.until === null) return true;
        if (timestamp === null) { diagnostics.excludedUndatedMessages++; return false; }
        return (interval.since === null || timestamp >= interval.since) && (interval.until === null || timestamp < interval.until);
    };
    const toolRow = (name) => tools[name] ??= { calls: 0, results: 0, resultBytes: 0 };
    for (const [key, session] of sessions) {
        const row = { session: digest(key), subagent: session.subagent, logicalAssistantMessages: 0, usageMessages: 0, peakContextTokens: 0 };
        const calls = new Set();
        for (const logical of session.messages.values()) {
            if (!included(logical.timestamp)) continue;
            row.logicalAssistantMessages++;
            for (const id of logical.tools) calls.add(id);
            const model = logical.models.size === 1 ? [...logical.models][0] : UNKNOWN;
            if (logical.models.size > 1) diagnostics.conflictingModels++;
            const group = models[model] ??= {
                logicalAssistantMessages: 0, usageMessages: 0, messagesWithoutUsage: 0, usageIssues: 0, peakContextTokens: 0,
                tokens: countTokens(), missingUsageFields: Object.fromEntries(BASE_TOKENS.map((k) => [k, 0])),
            };
            group.logicalAssistantMessages++;
            group.usageIssues += logical.usageIssues + (logical.models.size > 1 ? 1 : 0);
            const usage = logical.usage;
            if (Object.keys(usage).length === 0) {
                group.messagesWithoutUsage++; diagnostics.messagesWithoutUsage++; continue;
            }
            row.usageMessages++; group.usageMessages++;
            for (const field of BASE_TOKENS) {
                if (usage[field] === undefined) group.missingUsageFields[field]++;
                group.tokens[field] += usage[field] ?? 0;
            }
            const five = usage.cache_creation_5m_input_tokens ?? 0;
            const hour = usage.cache_creation_1h_input_tokens ?? 0;
            const write = usage.cache_creation_input_tokens ?? five + hour;
            if (five + hour > write) { diagnostics.inconsistentCacheCreation++; group.usageIssues++; }
            group.tokens.cache_creation_5m_input_tokens += five;
            group.tokens.cache_creation_1h_input_tokens += hour;
            group.tokens.cache_creation_unknown_input_tokens += Math.max(0, write - five - hour);
            if (usage.cache_creation_input_tokens === undefined) group.tokens.cache_creation_input_tokens += write;
            const context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + Math.max(write, five + hour);
            row.peakContextTokens = Math.max(row.peakContextTokens, context);
            group.peakContextTokens = Math.max(group.peakContextTokens, context);
        }
        const toolName = (id) => {
            const names = session.tools.get(id);
            return names?.size === 1 ? [...names][0] : UNKNOWN;
        };
        for (const id of calls) {
            if (session.tools.get(id)?.size > 1) diagnostics.conflictingToolNames++;
            toolRow(toolName(id)).calls++;
        }
        let results = 0;
        for (const result of session.results.values()) {
            if (!included(result.timestamp)) continue;
            results++;
            const name = toolName(result.id);
            const tool = toolRow(name);
            tool.results++; tool.resultBytes += result.bytes;
            if (name === UNKNOWN) { unknownToolResults++; unknownToolResultBytes += result.bytes; }
        }
        if (row.logicalAssistantMessages || results) rows.push(row);
    }
    const tokens = countTokens();
    let knownCostUsd = 0;
    for (const [model, group] of Object.entries(models)) {
        const configured = pricing !== undefined && Object.hasOwn(pricing.models, model);
        const rates = configured ? pricing.models[model] : {};
        group.ratesUsdPerMillion = rates;
        group.knownCostUsd = 0;
        group.unpricedTokens = 0;
        for (const field of Object.keys(tokens)) tokens[field] += group.tokens[field];
        for (const field of BILLABLE_TOKENS) {
            if (rates[field] === undefined) group.unpricedTokens += group.tokens[field];
            else group.knownCostUsd += group.tokens[field] * rates[field] / 1e6;
        }
        group.knownCostUsd = roundCost(group.knownCostUsd);
        group.costUsd = !configured || group.unpricedTokens || group.messagesWithoutUsage || group.usageIssues || Object.values(group.missingUsageFields).some(Boolean) ? null : group.knownCostUsd;
        knownCostUsd += group.knownCostUsd;
    }
    const complete = Object.keys(models).length > 0 && Object.values(models).every((m) => m.costUsd !== null);
    return {
        schemaVersion: 1, pricing: pricing ? { source: pricing.source, asOf: pricing.asOf } : null,
        interval: { since: interval.since === null ? null : new Date(interval.since).toISOString(), until: interval.until === null ? null : new Date(interval.until).toISOString() },
        logicalAssistantMessages: rows.reduce((n, r) => n + r.logicalAssistantMessages, 0),
        usageMessages: rows.reduce((n, r) => n + r.usageMessages, 0),
        peakContextTokens: Math.max(0, ...rows.map((r) => r.peakContextTokens)),
        tokens, knownCostUsd: roundCost(knownCostUsd), costUsd: complete ? roundCost(knownCostUsd) : null,
        toolCalls: Object.values(tools).reduce((n, r) => n + r.calls, 0),
        toolResults: Object.values(tools).reduce((n, r) => n + r.results, 0),
        unknownToolResults, unknownToolResultBytes, tools, models, sessions: rows, diagnostics,
    };
}

export async function analyzeTranscripts({ root, pricing, since, until }) {
    if (pricing !== undefined) validatePricing(pricing);
    const interval = { since: dateBoundary(since, "since"), until: dateBoundary(until, "until") };
    if (interval.since !== null && interval.until !== null && interval.until <= interval.since) throw new Error("until must be after since.");
    const sessions = new Map();
    const diagnostics = Object.fromEntries([
        "malformedRecords", "missingAssistantIds", "missingToolIds", "invalidUsageValues",
        "usageRegressions", "messagesWithoutUsage", "conflictingToolNames", "conflictingToolResults",
        "conflictingModels", "inconsistentCacheCreation", "excludedUndatedMessages",
    ].map((k) => [k, 0]));
    let filesScanned = 0;
    const directory = resolve(root);
    for await (const path of transcriptFiles(directory)) {
        filesScanned++;
        const subagentFile = path.split(sep).includes("subagents") || basename(path).startsWith("agent-");
        const stream = createReadStream(path, { encoding: "utf8" });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
            for await (const line of lines) {
                if (!line.trim()) continue;
                let record;
                try { record = JSON.parse(line); }
                catch (error) {
                    if (!(error instanceof SyntaxError)) throw error;
                    diagnostics.malformedRecords++; continue;
                }
                if (!record || typeof record !== "object" || Array.isArray(record)) { diagnostics.malformedRecords++; continue; }
                if (record.type !== "assistant" && record.type !== "user") continue;
                const file = relative(directory, path);
                const agent = typeof record.agentId === "string" && record.agentId ? record.agentId : null;
                const subagent = subagentFile || agent !== null || record.isSidechain === true;
                const key = JSON.stringify([typeof record.sessionId === "string" ? record.sessionId : file, subagent ? agent ?? file : null]);
                let session = sessions.get(key);
                if (!session) {
                    session = { messages: new Map(), tools: new Map(), results: new Map(), ordinal: 0, subagent };
                    sessions.set(key, session);
                }
                ingest({ session, record, diagnostics });
            }
        } finally { lines.close(); stream.destroy(); }
    }
    return { filesScanned, ...summarize({ sessions, pricing, interval, diagnostics }) };
}

async function main() {
    const { values } = parseArgs({ options: {
        root: { type: "string", default: join(homedir(), ".claude", "projects") },
        pricing: { type: "string" }, since: { type: "string" }, until: { type: "string" },
        help: { type: "boolean" },
    } });
    if (values.help) {
        console.log("node bin\\analyze-transcripts.mjs [--root PATH] [--since ISO] [--until ISO] [--pricing JSON]\nLocal Claude JSONL analysis. Dates use [since, until). Output excludes paths and transcript content.\nPricing is opt-in, per model, USD/MTok, with source and asOf. Missing prices/usage/TTL remain explicit.");
        return;
    }
    let pricing;
    if (values.pricing) {
        const content = await readFile(values.pricing, "utf8");
        try { pricing = JSON.parse(content); }
        catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            throw new Error("Pricing file must contain valid JSON.");
        }
    }
    console.log(JSON.stringify(await analyzeTranscripts({ ...values, pricing }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch((error) => { console.error(`Transcript analysis failed: ${error.message}`); process.exitCode = 1; });
}
