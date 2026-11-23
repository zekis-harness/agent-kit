#!/usr/bin/env node
// Patches the globally installed @playwright/mcp so agents never take over the
// user's tab: the connect page opens in its own window, the extension connects
// in background mode, new tabs open inactive (never switching the user's tab), and
// tab select does not call Page.bringToFront (which focuses the window).
// Right after connecting, yield-focus.ps1 hands OS focus back to the user and
// parks the agent window behind everything. Agent tabs are then hidden (no
// requestAnimationFrame), so browser_click switches to a force click there.
// browser_close (and server shutdown) closes every agent tab; unpatched, the
// extension only ungroups them and they stay open in the user's Chrome. A tab
// whose window.name is "agent-keep" (a handoff for the user) is left open.
// Idempotent. Rerun after every `npm i -g @playwright/mcp`, then reconnect
// the chrome-* MCP servers. Usage: node patch-mcp-nofocus.mjs [--check] [mcpPackageDir]
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const pkgDir = process.argv.slice(2).find(a => !a.startsWith('--'))
  ?? path.join(execSync('npm root -g').toString().trim(), '@playwright', 'mcp');
const file = path.join(pkgDir, 'node_modules', 'playwright-core', 'lib', 'coreBundle.js');
const checkOnly = process.argv.includes('--check');

const patches = [
  {
    name: 'connect page in background mode',
    from: 'url3.searchParams.set("protocolVersion", this._protocolVersion.toString());',
    to: 'url3.searchParams.set("protocolVersion", this._protocolVersion.toString());\n        url3.searchParams.set("background", "true"); /*nofocus*/',
  },
  {
    name: 'connect page in its own window',
    from: 'args.push(href);\n        (0, import_child_process5.spawn)',
    to: 'args.push("--new-window", href); /*nofocus*/\n        (0, import_child_process5.spawn)',
  },
  {
    name: 'new tabs open inactive',
    from: 'this._sendToExtension("chrome.tabs.create", [{ url: url3 }]);',
    to: 'this._sendToExtension("chrome.tabs.create", [{ url: url3, active: false }]); /*nofocus*/',
  },
  {
    name: 'minimize the new agent window after connect',
    from: 'debugLogger2("Extension connection established");',
    to: `debugLogger2("Extension connection established");\n        if (process.platform === "win32") try { (0, import_child_process5.execFileSync)("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ${JSON.stringify(path.join(import.meta.dirname, 'yield-focus.ps1'))}], { windowsHide: true, timeout: 8000 }); } catch {} /*nofocus*/`,
  },
  {
    name: 'browser_click forces the click in a hidden tab',
    from: '          ...tab2.actionTimeoutOptions\n        };\n        response2.addAction({\n          name: "click",',
    to: '          ...tab2.actionTimeoutOptions\n        };\n        if (await tab2.page.evaluate(() => document.visibilityState === "hidden").catch(() => false)) options.force = true; /*nofocus*/\n        response2.addAction({\n          name: "click",',
  },
  {
    name: 'browser_close and shutdown close the tabs, not just ungroup them',
    from: '        await disposeAll(this._disposables);\n        for (const tab2 of this._tabs)\n          await tab2.dispose();',
    to: '        await disposeAll(this._disposables);\n        await globalThis.__closeAgentTabs?.(this._tabs); /*closetabs*/\n        for (const tab2 of this._tabs)\n          await tab2.dispose();',
  },
  {
    name: 'track live contexts, close helper honoring window.name agent-keep',
    from: 'testDebug("create context");',
    to: 'testDebug("create context");\n        (globalThis.__agentContexts ??= new Set()).add(this); globalThis.__closeAgentTabs ??= (tabs) => Promise.race([Promise.all(tabs.map(async (t) => { if (await t.page.evaluate(() => window.name).catch(() => "") === "agent-keep") return; await t.page.close().catch(() => {}); })), new Promise((r) => setTimeout(r, 5000))]); /*closetabs*/',
  },
  {
    name: 'session end without browser_close still closes the tabs',
    from: 'testDebug3("gracefully closing " + gracefullyCloseSet.size);',
    to: 'testDebug3("gracefully closing " + gracefullyCloseSet.size);\n    await globalThis.__closeAgentTabs?.([...globalThis.__agentContexts ?? []].flatMap((c) => c._tabs)); /*closetabs*/',
  },
  {
    name: 'tab select skips bringToFront',
    from: 'await tab2.page.bringToFront();\n        await tab2.updateWebMCPTools();',
    to: '/*nofocus*/\n        await tab2.updateWebMCPTools();',
  },
];

let src = fs.readFileSync(file, 'utf8');
let failed = false;
for (const p of patches) {
  if (src.includes(p.to)) { console.log(`ok      ${p.name}`); continue; }
  if (!src.includes(p.from)) { console.log(`MISSING ${p.name} (upstream code changed, update this script)`); failed = true; continue; }
  if (checkOnly) { console.log(`todo    ${p.name}`); failed = true; continue; }
  src = src.replace(p.from, p.to);
  console.log(`patched ${p.name}`);
}
if (!checkOnly) fs.writeFileSync(file, src);
console.log(file);
process.exit(failed ? 1 : 0);
