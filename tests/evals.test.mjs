import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const checker = fileURLToPath(new URL('../evals/check.mjs', import.meta.url));
const corpus = JSON.parse(readFileSync(new URL('../evals/corpus.json', import.meta.url)));
const solutions = {
  rename: {
    'math.mjs': 'export const sumPrices = xs => xs.reduce((a,b)=>a+b,0);',
    'invoice.mjs': "import {sumPrices} from './math.mjs'; export const invoice=sumPrices;"
  },
  'empty-average': { 'average.mjs': 'export const average = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;' },
  'stable-unique': { 'unique.mjs': 'export const unique = xs => [...new Set(xs)];' },
  search: { 'findings.json': '{"audited":["beta","zebra"]}' },
  docs: { 'usage.md': "parsePort defaults to 8080; range 1-65535; throws RangeError.\n```js\nimport {parsePort} from './port.mjs';\nconsole.log(parsePort());\n```" },
  'debug-clock': { 'expiry.mjs': 'export const expired = (expiry, now=Date.now()) => now >= expiry;' },
  csv: { 'csv.mjs': 'export const csvCell = x => /[,"\\r\\n]/.test(x) ? \'"\' + x.replaceAll(\'"\',\'""\') + \'"\' : x;' },
  'path-prefix': { 'child.mjs': "export const isChild = (r,c) => r !== c && c.startsWith(r === '/' ? '/' : r+'/');" },
  pagination: { 'page.mjs': 'export function page(xs,o,n) { if(!Number.isInteger(o)||!Number.isInteger(n)||o<0||n<0) throw new RangeError(); return xs.slice(o,o+n); }' },
  'config-merge': { 'config.mjs': 'export const mergeConfig = (a,b) => ({...a,...Object.fromEntries(Object.entries(b).filter(([,v])=>v!==undefined))});' }
};
const regressions = {
  'empty-average': ['average.test.mjs', 'average.mjs', 'average([])', 'null'],
  'stable-unique': ['unique.test.mjs', 'unique.mjs', "unique(['a','a'])", "['a']"],
  'debug-clock': ['expiry.test.mjs', 'expiry.mjs', 'expired(1,1)', 'true'],
  csv: ['csv.test.mjs', 'csv.mjs', "csvCell('x')", "'x'"],
  'path-prefix': ['child.test.mjs', 'child.mjs', "isChild('/a','/ab')", 'false'],
  pagination: ['page.test.mjs', 'page.mjs', 'page([1,2],1,1)', '[2]'],
  'config-merge': ['config.test.mjs', 'config.mjs', 'mergeConfig({a:1},{a:undefined})', '{a:1}']
};
const exports = { 'empty-average': 'average', 'stable-unique': 'unique', 'debug-clock': 'expired', csv: 'csvCell', 'path-prefix': 'isChild', pagination: 'page', 'config-merge': 'mergeConfig' };
for (const task of corpus) {
  test(`should independently reject seeded ${task.id} and accept a correct solution`, () => {
    const root = mkdtempSync(join(tmpdir(), 'kit-eval-test-'));
    try {
      for (const [file, text] of Object.entries(task.files)) writeFileSync(join(root, file), text);
      const check = () => spawnSync(process.execPath, [checker, task.id, root], { encoding: 'utf8', timeout: 20000 });
      assert.notEqual(check().status, 0);
      for (const [file, text] of Object.entries(solutions[task.id])) writeFileSync(join(root, file), text);
      if (regressions[task.id]) {
        const [file, source, expression, expected] = regressions[task.id];
        writeFileSync(join(root, file), `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {${exports[task.id]}} from './${source}'; test('should preserve behavior',()=>assert.deepEqual(${expression},${expected}));`);
      }
      const result = check();
      assert.equal(result.status, 0, result.stderr);
      if (task.id === 'search' || task.id === 'docs') {
        const source = Object.keys(task.files)[0];
        writeFileSync(join(root, source), task.files[source] + '\n// modified\n');
        assert.notEqual(check().status, 0, 'read-only cases must preserve source');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
