import config from "../config.json";
import { createHash } from "node:crypto";

type Json = Record<string, any>;
export type SafeEvent = { table: string; values: Record<string, unknown> };
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const tokens = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((n, item) => n + textLength(item), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((n, item) => n + textLength(item), 0);
  return 0;
}

function resultTokens(content: unknown): number {
  if (typeof content === "string") return content.length * config.toolResultCharsPerToken;
  if (!Array.isArray(content)) return 0;
  return content.reduce((n: number, block: any) => {
    if (block?.type === "tool_result") return n + resultTokens(block.content);
    if (block?.type === "text") return n + textLength(block.text) * config.toolResultCharsPerToken;
    if (block?.type === "image") return n + config.toolResultImageTokens;
    return n;
  }, 0);
}

function jsonLength(value: unknown): number {
  try { return JSON.stringify(value).length; } catch { return 0; }
}

function sessionId(o: Json, source: string): string {
  const id = String(o.sessionId || o.session_id || "");
  const file = source.split(/[\\/]/).at(-1) || "";
  const legacyAgent = /[\\/]subagents[\\/]/i.test(source) || file.startsWith("agent-");
  const agent = o.agentId || (legacyAgent ? file.replace(/\.jsonl$/, "").replace(/^agent-/, "") : null);
  return id && agent ? `${id}/${agent}` : id;
}

function handoffPath(content: unknown): string | null {
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((x) => x?.type === "text").map((x) => x.text).join("\n") : "";
  const match = text.match(/Read\s+([A-Za-z]:\\[^\r\n"']*?\\\.agent-handoffs\\[^\r\n"']+?\.md)\s+and continue from ["']Next step["']\./i)
    || text.match(/Read\s+([^\r\n"']*?[\\/]\.agent-handoffs[\\/][^\r\n"']+?\.md)\s+and continue from ["']Next step["']\./i);
  return match?.[1] ?? null;
}

function modelCosts(o: Json): Array<[string, any]> {
  const usage = o.modelUsage && typeof o.modelUsage === "object" ? o.modelUsage : {};
  const rows = Object.entries(usage) as Array<[string, any]>;
  return rows.length ? rows : [["", {}]];
}

function num(value: unknown): number | null {
  return Number.isFinite(value) ? Number(value) : null;
}

export function parseLine(line: string, source: string, pos: number): SafeEvent[] {
  let o: Json;
  try { o = JSON.parse(line); } catch { return []; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return [];
  const sid = sessionId(o, source);
  const parsedTime = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
  const common = { source, pos, session_id: sid, ts: Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : null };
  const out: SafeEvent[] = [];
  if (sid && (o.cwd || o.gitBranch || o.isSidechain)) {
    out.push({ table: "session_events", values: { ...common, cwd: o.cwd || null, branch: o.gitBranch || null, sidechain: o.isSidechain ? 1 : 0 } });
  }
  const requestId = o.message?.id ? `${sid}:${o.message.id}` : o.requestId || o.uuid || `unidentified:${fingerprint([source, pos])}`;
  if (o.type === "assistant" && sid && requestId && o.message?.model !== "<synthetic>") {
    const u = o.message?.usage || {};
    const creation = u.cache_creation || {};
    const write5m = tokens(creation.ephemeral_5m_input_tokens);
    const write1h = tokens(creation.ephemeral_1h_input_tokens);
    const totalWrite = tokens(u.cache_creation_input_tokens);
    const fields = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens, u.output_tokens];
    const usageMask = fields.reduce<number>((mask, value, i) => mask | (Number.isSafeInteger(value) && value >= 0 ? 1 << i : 0), 0);
    const invalid = [...fields, creation.ephemeral_5m_input_tokens, creation.ephemeral_1h_input_tokens]
      .some((value) => value != null && (!Number.isSafeInteger(value) || value < 0));
    out.push({ table: "request_occurrences", values: {
      ...common, request_id: String(requestId), model: String(o.message.model || ""),
      input: tokens(u.input_tokens), write5m, write1h, write_total: totalWrite, write_unknown: Math.max(0, totalWrite - write5m - write1h),
      usage_mask: usageMask, invalid_usage: invalid || write5m + write1h > totalWrite && u.cache_creation_input_tokens != null ? 1 : 0,
      read: tokens(u.cache_read_input_tokens), output: tokens(u.output_tokens),
      thinking: tokens(u.output_tokens_details?.thinking_tokens),
      web_search: tokens(u.server_tool_use?.web_search_requests),
    } });
    let item = 0;
    for (const block of Array.isArray(o.message.content) ? o.message.content : []) {
      if (block?.type !== "tool_use" || !block.name) continue;
      const mcp = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(block.name)?.[1] || null;
      const isWrite = String(block.name).toLowerCase() === "write";
      const skill = String(block.name).toLowerCase() === "skill" ? (block.input?.skill || block.input?.name || null) : null;
      out.push({ table: "tool_calls_raw", values: {
        ...common, item: item++, assistant_uuid: o.uuid || null, tool_id: block.id || null,
        name: String(block.name), mcp_server: mcp, skill_name: skill ? String(skill) : null,
        file_path: isWrite && block.input?.file_path ? String(block.input.file_path) : null,
      } });
    }
  }
  const hasToolResult = Array.isArray(o.message?.content) && o.message.content.some((block: Json) => block?.type === "tool_result");
  if (o.type === "user" && o.message?.role === "user" && !o.toolUseResult && !hasToolResult) {
    out.push({ table: "human_events", values: { ...common, fingerprint: String(o.uuid || fingerprint([o.timestamp, o.message.content])), continued_path: handoffPath(o.message.content) } });
  }
  if (o.type === "user" && o.toolUseResult) {
    out.push({ table: "tool_results_raw", values: {
      ...common, source_uuid: o.sourceToolAssistantUUID || null,
      mcp_server: o.attributionMcpServer || null,
      token_est: resultTokens(o.message?.content),
    } });
  }
  if (o.type === "api-request-shape" && sid) {
    let item = 0;
    const systems = Array.isArray(o.shape?.system) ? o.shape.system : [];
    const systemChars = systems.reduce((n: number, value: unknown) => n + jsonLength(value), 0);
    const shapeCommon = { ...common, origin: "shape", fingerprint: fingerprint(o.shape) };
    if (systemChars) out.push({ table: "opening_raw", values: { ...shapeCommon, item: item++, component: "system_prompt", chars: systemChars, name: null } });
    const groups = new Map<string, number>();
    for (const tool of Array.isArray(o.shape?.tools) ? o.shape.tools : []) {
      const name = String(tool?.name || "");
      const server = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(name)?.[1];
      const key = tool?.defer_loading ? "deferred_tools" : server ? `mcp:${server}` : "builtin_tools";
      groups.set(key, (groups.get(key) || 0) + jsonLength(tool));
    }
    for (const [component, chars] of groups) out.push({ table: "opening_raw", values: { ...shapeCommon, item: item++, component, chars, name: component.startsWith("mcp:") ? component.slice(4) : null } });
  }
  if (o.type === "attachment" && sid) {
    const map: Record<string, string> = {
      skill_listing: "skills", instructions: "instructions", deferred_tools_delta: "deferred_tools",
      agent_listing_delta: "agent_list", mcp_instructions_delta: "mcp_instructions",
    };
    const component = map[o.attachment?.type];
    if (component) {
      const attachmentCommon = { ...common, origin: "attachment", fingerprint: fingerprint([o.attachment.type, o.rendered]) };
      const chars = Array.isArray(o.rendered) ? o.rendered.reduce((n: number, item: any) => n + textLength(item?.content), 0) : 0;
      if (chars) out.push({ table: "opening_raw", values: { ...attachmentCommon, item: 0, component, chars, name: null } });
      if (component === "skills") {
        const rendered = Array.isArray(o.rendered) ? o.rendered.map((x: any) => x?.content || "").join("\n") : "";
        let item = 1;
        for (const match of rendered.matchAll(/<skill>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/skill>/g)) {
          out.push({ table: "opening_raw", values: { ...attachmentCommon, item: item++, component: "skill", chars: match[0].length, name: match[1] } });
        }
      }
    }
  }
  if (o.type === "ai-title" && sid && typeof o.aiTitle === "string") out.push({ table: "titles_raw", values: { source, pos, session_id: sid, title: o.aiTitle } });
  if (o.type === "cost-state" && sid) {
    for (const [model, u] of modelCosts(o)) out.push({ table: "cost_states", values: {
      source, pos, session_id: sid, model, total_cost: num(o.totalCostUSD), model_cost: num(u?.costUSD),
      input: num(u?.inputTokens), output: num(u?.outputTokens), write: num(u?.cacheCreationInputTokens),
      read: num(u?.cacheReadInputTokens), web_search: num(u?.webSearchRequests),
    } });
  }
  return out;
}
