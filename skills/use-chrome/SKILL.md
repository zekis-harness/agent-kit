---
name: use-chrome
description: "Use this whenever a task needs a web browser (open a URL, sign in, fill a form, read a page behind login, scrape, test a web app, take a screenshot, fetch an emailed verification code, get past a CAPTCHA or bot wall, create and store an API key). Explains the only allowed way to drive Chrome: Playwright MCP servers in --extension mode, which attach to the user's real, already-signed-in Chrome profiles. Never launch Chrome, Chromium or Playwright any other way."
---

# Using Chrome from an agent

The user's Chrome profiles are already signed in to their accounts, so never ask them to log in to Google, GitHub and similar, and never type their passwords.

## Which server

The browser MCP servers come from `browser.servers` in `~/.zekis-harness/config.json` (`name`, `profileDir`, `use`). Which account is signed in where comes from `~/.zekis-harness/profile.md`. The first server with `use: "default"` is the default; use another only when the task names that account. If it is unclear which identity a site should see, ask once before opening anything. If neither file exists, see "Set up".

## Set up

Skip if the servers already exist.

1. `npm i -g @playwright/mcp`.
2. In each Chrome profile the agent should use, install the Playwright Extension from the Chrome Web Store, open its status page and copy the connection token.
3. Add one MCP server per profile to each agent's user-level config (never a project `.mcp.json`). Generic shape:
   ```json
   { "mcpServers": { "chrome-main": {
       "command": "npx",
       "args": ["@playwright/mcp@latest", "--extension", "--profile-dir-name", "Default"],
       "env": { "PLAYWRIGHT_MCP_EXTENSION_TOKEN": "<token from that profile's extension>" } } } }
   ```
   `--profile-dir-name` is the folder name under Chrome's user data directory (`Default`, `Profile 1`, ...; see "Profile Path" at `chrome://version`). Use one distinct server name per profile. Codex uses `~/.codex/config.toml`; other agents have an equivalent MCP config file.
4. Record each server in `config.json` under `browser.servers`, for example `{ "name": "chrome-main", "profileDir": "Default", "use": "default" }`, and note which account each profile holds in `profile.md`.
5. Restart the agent session; hosts load MCP servers at startup.

## How it works

The servers do not launch a browser. They connect to the Playwright Extension in the user's real Chrome profile and get their own tab group there, named after your client. You see only your group's tabs. Other agents can use the same profile at once in their own groups, but see Troubleshooting.

## Tool names

The Playwright tool set is the same on every server; only the prefix differs (`mcp__<server>__browser_navigate` in Claude Code, `<server>-browser_navigate` in Copilot CLI). Hosts defer MCP tools: load them once with the host's tool search (Claude Code `ToolSearch` with `select:mcp__<server>__browser_navigate,...`; Copilot CLI `tool_search_tool` with `<server>-browser`). "Tool not found" before that is normal.

Core tools: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_press_key`, `browser_evaluate`, `browser_tabs`, `browser_take_screenshot`, `browser_wait_for`, `browser_file_upload`, `browser_close`.

Element-taking tools use `target` (the `[ref=...]` from the snapshot, or a CSS selector) plus a human-readable `element`: `browser_click {"element": "Log in button", "target": "e42"}`. `browser_fill_form` takes `fields: [{name, type, target, value}]`.

## Workflow

1. Pick the server. Do not open two unless the task needs two identities.
2. `browser_navigate` to the URL. The first call creates your tab (Chrome starts the profile if needed).
3. `browser_snapshot` before acting; act by `target` ref, not coordinates. It accepts `target` and `depth` to narrow it.
4. Prefer `browser_fill_form` for multi-field forms and `browser_click` over JS clicks. A JS click is untrusted (`isTrusted: false`); anti-bot widgets and some buttons ignore it silently. If a JS click did nothing, use a trusted click (`browser_click`, or `page.mouse` in `browser_run_code_unsafe`, see `captcha.md`). For bulk list data, `browser_evaluate` with a small `() => [...document.querySelectorAll(...)].map(...)` beats a huge snapshot.
5. Close tabs as soon as you have what you need (`browser_tabs` action `close`); open tabs cost RAM and CPU in the user's real Chrome. When the task ends (success, failure, giving up, or handing back a question) call `browser_close` on every server you used. With the patched server (below) it closes every tab you opened, popups and OAuth windows included. Before the final reply, run the sweep in Troubleshooting and confirm no tab your task opened is left. A tab that was only ungrouped still counts as left behind.
   Exception: a tab the user must act on (SMS or authenticator 2FA, a CAPTCHA you could not solve, a form waiting on their final review). Mark it with `browser_evaluate` `() => { window.name = "agent-keep" }`; the patched `browser_close` skips it. Say so in the reply so it reads as a handoff.
   Console errors in tool replies are site noise unless the task is debugging that site. Write screenshots and snapshots to a temp directory, never the working directory.

## Agents never steal focus or leave tabs (patched server)

The stock `@playwright/mcp` pulls the user onto the agent's tab (connect page active, new tabs active, `browser_tabs select` calls `Page.bringToFront`), and `browser_close` only ungroups tabs, leaving them open. `scripts/patch-mcp-nofocus.mjs` patches the global install so that:

- the connect page opens in its own window in background mode;
- new tabs open inactive and `select` does not bring them to front;
- `browser_close` and session end close every agent tab (except `agent-keep`);
- on Windows, `scripts/yield-focus.ps1` (Windows-only; other systems skip it) minimizes the connect window so focus returns to the user, then restores it behind everything.

Run `node <skill folder>/scripts/patch-mcp-nofocus.mjs` after every `npm i -g @playwright/mcp` (`--check` reports without writing), then reconnect the servers. `<skill folder>` is where this skill is installed, or `<kit>/skills/use-chrome` where `<kit>` is the `kit` path in `config.json` (default `~/zekis-harness`). If it prints `MISSING`, upstream code moved: update the `from` strings to match the new `coreBundle.js`.

Consequence: agent tabs are usually hidden (`document.visibilityState === "hidden"`, no `requestAnimationFrame`). The patched `browser_click` force-clicks there with a trusted mouse event. Screenshots and `browser_evaluate` work normally. If `browser_hover` or `browser_drag` time out, use `page.mouse` in `browser_run_code_unsafe` or the hidden-window fixes below. Never "fix" this by focusing the tab or window.

## Logging in

1. **"Sign in with Google" or similar exists:** click it, pick the account matching the server you are on, approve consent if shown. No password is typed.
2. **Username and password only:** Chrome's saved-password autofill does not fire for automated input and cannot be read. Look the credential up in the OS credential store: Windows Credential Manager (read with a PowerShell `CredRead` wrapper), macOS Keychain (`security find-generic-password -s <host> -w`), Linux `secret-tool lookup host <host>`. Use a helper the user's `profile.md` names, if any. Fill with `browser_fill_form`, submit, verify. If several usernames match, pick the one for the server's account or ask. If none is stored, stop and ask; never guess or reset passwords. Never print, log or commit the password; redact it in reports.
3. **Verification codes sent by email:** fetch the code yourself from the user's mail in the same profile.
   1. Leave the site's code prompt open. In a second tab (`browser_tabs` action `new`) open the mail search page, for Gmail `https://mail.google.com/mail/u/0/#search/from%3A<sender>+newer_than%3A1h` (the `u/N` index is the signed-in account).
   2. Read the rows with `browser_evaluate`: `[...document.querySelectorAll('tr.zA')].map(r => ({from: r.querySelector('.yX')?.innerText, subject: r.querySelector('.y6')?.innerText, snippet: r.querySelector('.y2')?.innerText, time: r.querySelector('.xW span')?.getAttribute('title')}))`. Take the newest code; earlier ones are invalid. Wait and re-read if nothing has arrived.
   3. `browser_tabs` action `select` back, focus the code input (`input[autocomplete="one-time-code"]`) and `browser_type` it with `slowly: true`; these inputs submit on the last digit.
   4. Close the mail tab. Never write the code or the mail contents anywhere else.

   SMS codes and authenticator apps cannot be fetched: stop, say what is on screen, leave the tab open. CAPTCHAs: solve them yourself (see `captcha.md`) and hand over only if that fails.
4. **Sites that demand reverification before a sensitive action** (creating an API key) may answer a JS `.click()` with HTTP 403 and leave the form spinning with no modal. Focus the submit button with `browser_evaluate` and press `Enter` via `browser_press_key`, then follow step 3. The reverification stays valid for several minutes.

## CAPTCHAs and bot walls

Solve them yourself; do not hand the task back just because a challenge appeared. The procedure (hCaptcha, reCAPTCHA, Cloudflare Turnstile, PerimeterX press-and-hold), its scope and working scripts are in `captcha.md`. Read it the moment a challenge shows up.

## Capturing a secret the site shows once (API keys, tokens)

The value must never land in your transcript, reply, or any repo.

1. Do not call `browser_snapshot` or `browser_find` on a page that shows a secret. The accessibility tree carries every input's real `value`, so a masked field is echoed in clear text. Locate the field with `browser_evaluate` returning only labels, tag names and value lengths.
2. Read it with `browser_evaluate` using the `filename` parameter set to an absolute temp path; the tool writes the result there instead of echoing it. If the page shows only a masked value with a Copy button, capture the clipboard write inside the same evaluate: `navigator.clipboard.writeText = t => { captured = t; return Promise.resolve(); }`, click Copy, return `captured` after a short timeout.
3. Store it in the OS credential store (Windows Credential Manager, macOS `security add-generic-password -s <service> -a <label> -w`, Linux `secret-tool store`), reading from the temp file, then delete the file in the same shell call. Later callers read it from the store and pass it to CLIs through a pipe, never by pasting.
4. Confirm only with the length or a `startsWith` check.

## When the Chrome window is hidden or minimized

`document.visibilityState` is `hidden` and `requestAnimationFrame` never fires. Fixes that worked:

- `browser_click` times out waiting for the element to be "stable": use `browser_evaluate` with `.click()` (React handlers fire), or `.focus()` it and send a trusted key with `browser_press_key`.
- Custom selects (Radix, Base UI) open once, then stick in a closing animation. Skip the popover: set the hidden input beside the trigger through the native setter and dispatch `input` and `change`: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'x'); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}))`.
- OAuth "Authorize" buttons that stay disabled until the tab has been visible: `browser_tabs` action `select` on your tab, then click.
- Streamed Next.js pages can stay on their loading skeleton without hydrating. Navigate with an in-page link instead of a hard `browser_navigate`. This is a test-environment artifact, not an app bug.

## Do NOT

- Start Chrome with `Start-Process chrome.exe`, `open -a`, `chromium.launch()`, `launchPersistentContext`, `npx @playwright/mcp` without `--extension`, `--user-data-dir`, or `--isolated`. Each opens a stray, logged-out window.
- Use a profile that is not in `browser.servers`.
- Reset the user's passwords or type one that did not come from the credential store. If a site is logged out with no Google button and no stored credential, stop and tell the user.
- Read Chrome's `Login Data` or cookie databases or copy them between profiles (App-Bound Encryption makes them unusable anyway).
- Send OS-level keystrokes (SendKeys, AutoHotkey, `osascript`) at the Chrome window.
- Spawn the MCP server yourself over stdio. If the tools are missing, the host loaded the wrong config: see Troubleshooting.
- Leave tabs you opened behind. Abandoning a tab on error, on giving up, or by ending your turn is a bug.
- Focus the user's window or switch their active tab (`browser_tabs select` on a tab in their window, `window.focus()`, `Page.bringToFront`). Work in hidden tabs.

## Why every workaround fails

Each of these was tried and failed for a reproducible reason:

| Attempt | What happens |
|---|---|
| `chromium.launchPersistentContext(<new dir>)`, then ask the user to sign in | Google refuses: "Couldn't sign you in. This browser or app may not be secure." Playwright's launch flags are detected. |
| Copy `Network\Cookies` from the real profile into a new dir | 0 cookies. App-Bound Encryption ties the key to the profile path and the OS keyring; the copy decrypts to nothing. |
| `launchPersistentContext` pointed at the real user data dir | Chrome 136+ refuses: "DevTools remote debugging requires a non-default data directory." |
| A directory junction or symlink to the real profile | Same encryption problem, and it needs Chrome killed first. |
| `chrome-devtools` MCP `new_page` for a signed-in site | It attaches to an isolated, logged-out browser. It is for Lighthouse and perf traces only. |
| `Start-Process chrome.exe --user-data-dir=<new> --remote-debugging-port=9222`, then `connectOverCDP` | Works technically, but the profile has no accounts and a stray window opens. |

Before touching any browser, load the default server's `browser_navigate` through tool search and call it; the first navigation returns the signed-in page with no login step. For anything that needs the session outside the browser (scraping at scale, a download), sign in and browse through the server and pull data out with `browser_evaluate`, or look for the site's public endpoints from Node.

## chrome-devtools (special cases only)

`chrome-devtools` (`chrome-devtools-mcp --autoConnect`) attaches to a profile's running Chrome for what Playwright MCP lacks: `performance_start_trace`, `performance_analyze_insight`, `lighthouse_audit`, `take_heapsnapshot`, detailed `list_network_requests`. Chrome shows an "Allow remote debugging?" dialog on each new connection that the user must accept, and it sees every tab in that profile. Use it only for perf, Lighthouse and memory work, warn the user about the dialog, and keep normal navigation on the Playwright servers. It needs the `chrome://inspect/#remote-debugging` toggle on.

## Troubleshooting

**Two sessions on one profile wedge the browser.** Every agent session starts its own server per profile, but the extension in a profile bridges to one server at a time, following the newest connection. When another session drives the same profile, your server loses the bridge, its next call waits forever, and every later call (even `browser_tabs list`) queues behind it past 120 s. Signs: the Welcome tab's `mcpRelayUrl` port changes between your calls, and output files appear from tasks that are not yours.
- Before browser work, check for other live agent sessions on the profile (running agent processes, recent transcripts that called this server). If one is active, wait or tell the user the profile is busy.
- If your server is already wedged, `TaskStop` does not cancel the stuck call. Kill only your own server process (the `@playwright/mcp ... --profile-dir-name <dir>` node process whose parent is your agent's PID), never another session's. The tools vanish until the user reconnects the server (`/mcp` in Claude Code), which starts a fresh server that takes over the bridge.
- Idle servers from old sessions are harmless, but each takes the bridge back when it next makes a call.

**Check this first if a browser call errors.** `browser_navigate` often returns `TypeError: Cannot read properties of undefined (reading 'url')` or `Target page, context or browser has been closed` even though the page loads. The tool's tab list is stale: the page opened, but the tool still points at `about:blank` or the Welcome tab. Do not retry navigate (each retry opens another window), and never answer it with `browser_close`, a reconnect, an extension restart or a server reinstall. Instead: (1) `browser_run_code_unsafe` with `async (page) => page.context().pages().map(p => p.url())` to refresh the list; (2) `browser_tabs select` the tab with the target URL; (3) drive it with `browser_evaluate` (a `.click()` from evaluate is safe; a real `browser_click` that navigates can drop the connection again, so repeat step 1 after any navigation). If the list still shows only `about:blank`, `browser_close` once, open the URL with `browser_tabs new`, and repeat step 1. Report the browser as down only if `browser_tabs list` also fails.

**chrome.debugger fallback** when the tab list stays stale: from the Welcome tab (`chrome-extension://.../connect.html`) use `browser_evaluate`: find the target with `chrome.tabs.query`, `chrome.debugger.detach` then `attach({tabId},'1.3')` (a leftover attach from another session makes attach fail), and drive it with `Runtime.evaluate`. `DOM.setFileInputFiles` fails with "Not allowed"; to upload, write a script file containing the file as base64 and run it with `browser_run_code_unsafe` and `filename` (the code cannot `require` files, and the result echoes the code, so delete the script and saved result after). Some form frameworks ignore values set with a native setter: type with `Input.insertText` after `focus()` and `select()`. Some dropdowns open only for trusted `Input.dispatchMouseEvent` clicks, and only after `chrome.windows.update(windowId,{focused:true,state:'normal'})` makes the tab visible; read coordinates from `getBoundingClientRect()` right before each click. Finish with `chrome.debugger.detach` then `chrome.tabs.remove`.

**Close every tab you are not filling.** Those errors often still open a real tab that detaches from your group, so retrying leaves duplicates. Retry a failed open at most once, then `list`. At the end of every task and before any handoff, sweep all of Chrome, not just your group: select the extension's Welcome tab (index 0) and run `browser_evaluate` with `async () => (await chrome.tabs.query({})).map(t => t.id + ' ' + t.url)`. Close strays with `chrome.tabs.remove([ids])`. To keep a deliberate handoff tab, first set its `document.title` to a unique marker, exclude that id, then restore the title. Close only tabs your task opened; never the user's.

- Tools missing even after tool search: the host loaded a different config than the one you edited. Check which config file that agent actually reads (some agents honor a config-home environment variable), copy the `chrome-*` entries there, and restart the session. Do not spawn servers yourself.
- Navigate hangs or "Extension not connected": open the profile in Chrome, check the Playwright Extension is enabled (`chrome://extensions`) and that its token matches `PLAYWRIGHT_MCP_EXTENSION_TOKEN` in every agent config. A reinstalled extension has a new token: update every config.
- "Tool not found": hosts load MCP servers at startup; restart the session.
- `chrome-devtools` opened a fresh empty browser: its config lost `--autoConnect`. If it hangs, the user has an "Allow remote debugging?" dialog to click.
- Site says logged out: follow "Logging in", otherwise tell the user.
- A clean, logged-out browser for a test: ask the user first; `--isolated` is otherwise banned.
