# Cost and cache

How prompt caching shapes the kit's habits: choose the model at the start, keep an idle session warm only when you are coming back, and hand off instead of resuming a large session after a long break. Prices and TTLs change; check the provider pages linked below before relying on a number.

## Claude Code

- **Editing global instructions mid-session does not break the cache.** User and project `CLAUDE.md` files are read once at session start. A mid-session edit does not invalidate the cache, but it also does not apply until `/clear`, `/compact`, or a restart ([docs](https://code.claude.com/docs/en/prompt-caching#editing-claude-md-mid-session)). Running sessions do not pick up a `sync.ps1` change.
- **The 1h TTL is narrower than "the main session".** Claude Code requests 1h only for the main conversation on a Claude subscription within its included usage. Once usage credits apply it drops to 5m, and subagents and other requests get 5m ([docs](https://code.claude.com/docs/en/prompt-caching#which-ttl-each-request-gets)). Pin it with `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`.
- **What breaks the cache:** switching models mid-session (including plan-mode model toggles and skills whose frontmatter sets `model`), changing effort on models that do not keep the cache across effort changes, toggling fast mode, connecting an MCP server mid-session when tool search is off, and upgrading Claude Code (effective at the next session start).

Rule: choose the model and effort at the start of the session.

## Codex and Copilot CLI

- OpenAI documents a 30 minute default cache TTL for recent GPT models in the Responses API ([docs](https://developers.openai.com/api/docs/guides/prompt-caching)). Whether Codex CLI on a ChatGPT login uses the same TTL is not documented.
- Copilot CLI reports the TTL in the `cacheTtlSeconds` field of its `session.usage_checkpoint` event, and the cache expiry time in `cacheExpiresAt` on `assistant.usage`.
- A cold headless worker writes its whole system prompt and tool definitions to cache before doing anything. Copilot bills AI credits (1 credit = $0.01); usage events report nano-AIU, so divide by 1e11 for USD. `dispatch.ps1` gives Copilot workers their own `COPILOT_HOME` so your extensions, skills and global instructions do not inflate that opening context.

## Keep-warm math

A heartbeat while you step away re-reads the cached prefix at the cache-read rate instead of re-writing it at the cache-write rate after expiry. With published list prices ([Anthropic table](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) the read costs roughly 1/25 to 1/40 of a rebuild of the same prefix. On a 1h TTL one ping about every 50 minutes is enough; a shorter interval only matters on a 5m TTL. On a subscription the same ratio applies to usage limits instead of dollars.

The cost of a session you never resume is its few pings. Gaps longer than the allowance still rebuild, so hand off rather than resume a large session after a long break.

When not to keep warm: you are not coming back to that session, or it is near the handoff threshold. Hand off instead.

### Copilot extension

`copilot/extensions/keep-warm/` pings shortly before the reported expiry, for up to one hour and twelve pings per idle stretch, and only above a minimum context size. It re-arms only on a genuine human `user.message`: string content, no `source`, not autopilot, and not an autopilot continuation. Agent, system and automation messages still cancel a pending timer while work runs, but cannot reset the idle deadline, ping count, or emit a human-return log. Late timer callbacks recheck both limits. A new extension instance starts unarmed; it does not restore eligibility from disk, so restarting it alone cannot extend an idle stretch. Replayed historical events must not be fed to the live handler. Set `AGENT_KIT_KEEPWARM=0` to turn it off.

Tests use a fake clock and session, not a paid live cache probe. Changing repository files does not update an already loaded extension: re-run `bin/sync.ps1` and restart or reload the extension host.

## Opening context

Every always-loaded token is paid on every cold start. Ways to shrink it, in `~/.claude/settings.json`:

- `skillOverrides`: set rarely used skills to `"name-only"`, which keeps them invokable but drops their descriptions from the opening context.
- `permissions.deny`: deny built-in or MCP tools you never use; each denied tool removes its schema from the context.
- Disconnect MCP servers you do not need for the task; deferred tool names still cost a little.

Measure the effect with `claude -p` by comparing the first request's usage before and after one change at a time.

`CLAUDE_CODE_SUBAGENT_MODEL` keeps a subagent spawned without a model off your most expensive model.

## Local transcript analysis

`bin/analyze-transcripts.mjs` uses Node's standard library and reads Claude JSONL transcripts locally. It never sends network requests or reports file paths, prompts, assistant text, tool arguments, or tool-result content. Session labels are opaque hashes. Treat the resulting usage statistics as private.

```sh
node bin/analyze-transcripts.mjs --root ~/.claude/projects --since 2026-10-22T00:00:00Z --until 2026-11-06T00:00:00Z
```

Dates select logical messages by their earliest recorded timestamp, using an inclusive `since` and exclusive `until`, not file modification times. Undated messages are excluded when a date filter is set and counted in diagnostics. Without a date filter they are included. Non-conversation events are ignored. Malformed records and invalid token values are counted without echoing their content; unreadable inputs and invalid CLI arguments fail explicitly.

Assistant chunks sharing a message id are one logical message. Every chunk contributes tool declarations, even if an earlier chunk already contained usage. Usage counters are cumulative snapshots: use the largest observed value per field, never their sum. Missing fields remain explicitly counted; regressing snapshots are diagnostic evidence, not independent usage. Missing message ids use the record UUID when available, otherwise remain separate records. Copied main-session files with the same session and message ids are deduplicated. Subagent directories, legacy `agent-*` files, and explicit `agentId` / `isSidechain` metadata separate worker conversations from the main conversation.

Tool calls are unique tool-use ids within a conversation. Results are joined after all declarations have been read, so results preceding a later streamed declaration are still attributable. Repeated results for the same tool-use id count once. Conflicting result snapshots use the largest serialized content size and increment a diagnostic; conflicting names and undeclared ids appear under `[unknown]`. `resultBytes` counts UTF-8 bytes of JSON-serialized result content, not API tokens, screenshot pixels, raw file bytes, or JSONL record overhead. Logical assistant messages are not user turns or necessarily unique HTTP requests.

The report includes tokens and peak input context by model, logical-message counts, missing usage, unknown tool attribution, and diagnostics. Peak context is uncached input plus cache reads plus cache writes, excluding output. Incomplete valid usage provides only a lower-bound measurement; conflicting snapshots are not verified measurements. Empty transcripts or missing prices never imply zero total cost: `costUsd` remains `null`; `knownCostUsd` is only the subtotal for observed, explicitly priced tokens.

### Pricing is opt-in

Pass `--pricing <local JSON path>` to estimate list-price cost. The file must provide `source`, `asOf` (`YYYY-MM-DD`), and `models`, keyed by the exact observed model id. Each model maps token fields to nonnegative numeric USD/MTok rates:

- `input_tokens`, `output_tokens`, `cache_read_input_tokens`
- `cache_creation_5m_input_tokens`, `cache_creation_1h_input_tokens`
- Optionally `cache_creation_unknown_input_tokens`, an explicitly chosen estimate when the transcript does not identify the TTL.

No provider or model aliases and no default rates are assumed. Record the source URL or dated pricing quote in `source`, and verify the actual model's price there. The aggregate `cache_creation_input_tokens` and its TTL breakdown are alternative views of the same tokens, not additive billing categories.

Cache-write TTL is taken only from `usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`. Any remainder is `cache_creation_unknown_input_tokens`, never silently assigned to 1h. If the TTL components exceed the aggregate, the report flags the inconsistency and preserves both the observed aggregate and components. Missing model prices, missing positive-token rates, incomplete usage, conflicting models, or invalid or regressing counters yield `costUsd: null` for the affected model and total. Supplied rates and their source are retained in the report, alongside priced subtotals and unpriced-token counts.

Run the regressions with `node --test tests/analyze-transcripts.test.mjs`.
