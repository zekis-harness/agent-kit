// Operator-owned acceptance, run outside the synthetic worker repository.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const [id, directory] = process.argv.slice(2);
assert.ok(id && directory, 'usage: node evals/check.mjs CASE REPOSITORY');
const root = resolve(directory);
const load = name => import(pathToFileURL(join(root, name)).href);
const read = name => readFileSync(join(root, name), 'utf8');
const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'));
const task = corpus.find(task => task.id === id);
assert.ok(task, `unknown case: ${id}`);
function regression(name) {
  assert.ok(existsSync(join(root, name)), `missing regression: ${name}`);
  const result = spawnSync(process.execPath, ['--test', join(root, name)], { timeout: 10000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
}
switch (id) {
  case 'rename': {
    const mod = await load('math.mjs');
    assert.equal(mod.calcTotal, undefined);
    assert.equal(mod.sumPrices([]), 0);
    assert.equal(mod.sumPrices([2, -1, 4]), 5);
    assert.equal((await load('invoice.mjs')).invoice([2, 3]), 5);
    assert.ok(!read('invoice.mjs').includes('calcTotal'));
    break;
  }
  case 'empty-average': {
    const { average } = await load('average.mjs');
    assert.equal(average([]), null);
    assert.equal(average([2, 4, 9]), 5);
    assert.equal(average([-4, 0]), -2);
    regression('average.test.mjs');
    break;
  }
  case 'stable-unique': {
    const { unique } = await load('unique.mjs');
    const xs = Object.freeze(['b', 'a', 'b', 'A', '', '']);
    assert.deepEqual(unique(xs), ['b', 'a', 'A', '']);
    assert.deepEqual(unique([]), []);
    regression('unique.test.mjs');
    break;
  }
  case 'search':
    assert.deepEqual(JSON.parse(read('findings.json')), { audited: ['beta', 'zebra'] });
    for (const [file, text] of Object.entries(task.files)) assert.equal(read(file), text);
    break;
  case 'docs': {
    assert.equal(read('port.mjs'), task.files['port.mjs']);
    const text = read('usage.md');
    for (const part of ['8080', '65535', 'RangeError', 'parsePort', 'import']) assert.ok(text.includes(part), `missing ${part}`);
    assert.match(text, /\b1\b/);
    const examples = [...text.matchAll(/```(?:js|javascript|mjs)\s*\n([\s\S]*?)```/g)];
    assert.ok(examples.length, 'need an executable ESM example');
    for (const [, code] of examples) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, timeout: 10000, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    break;
  }
  case 'debug-clock': {
    const { expired } = await load('expiry.mjs');
    assert.equal(expired(100, 99), false);
    assert.equal(expired(100, 100), true);
    assert.equal(expired(100, 101), true);
    assert.equal(expired(0), true);
    assert.equal(expired(Number.MAX_SAFE_INTEGER), false);
    assert.doesNotMatch(read('expiry.test.mjs'), /setTimeout|sleep/);
    regression('expiry.test.mjs');
    break;
  }
  case 'csv': {
    const { csvCell } = await load('csv.mjs');
    for (const [input, expected] of [['', ''], ['plain', 'plain'], ['a,b', '"a,b"'], ['a"b', '"a""b"'], ['x\ny', '"x\ny"'], ['\r', '"\r"']]) {
      assert.equal(csvCell(input), expected);
    }
    regression('csv.test.mjs');
    break;
  }
  case 'path-prefix': {
    const { isChild } = await load('child.mjs');
    for (const [a, b, expected] of [['/a', '/a', false], ['/a', '/ab/x', false], ['/a', '/a/b', true], ['/', '/x', true], ['/', '/', false], ['/b', '/a/b', false]]) {
      assert.equal(isChild(a, b), expected, `${a} ${b}`);
    }
    regression('child.test.mjs');
    break;
  }
  case 'pagination': {
    const { page } = await load('page.mjs');
    const xs = Object.freeze([1, 2, 3, 4]);
    assert.deepEqual(page(xs, 1, 2), [2, 3]);
    assert.deepEqual(page(xs, 8, 2), []);
    assert.deepEqual(page(xs, 0, 0), []);
    for (const invalid of [-1, 0.1, NaN, Infinity, '2', undefined]) {
      assert.throws(() => page(xs, invalid, 1), RangeError);
      assert.throws(() => page(xs, 0, invalid), RangeError);
    }
    regression('page.test.mjs');
    break;
  }
  case 'config-merge': {
    const { mergeConfig } = await load('config.mjs');
    assert.deepEqual(mergeConfig(Object.freeze({ a: 1, b: 2 }), Object.freeze({ a: undefined, b: null, c: false, d: 0, e: '' })), { a: 1, b: null, c: false, d: 0, e: '' });
    assert.deepEqual(mergeConfig({}, { a: undefined }), {});
    regression('config.test.mjs');
    break;
  }
}
console.log(`accepted: ${id}`);
