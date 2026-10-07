const test = require('node:test');
const assert = require('node:assert/strict');
const {fileURLToPath} = require('node:url');
const {resolveFileReference} = require('../out/core/fileReference');
const options = (extra = {}) => ({roots: ['/session', '/opened', '/editor'], home: '/home/test', platform: 'linux', exists: () => false, fileUriToPath: fileURLToPath, ...extra});

test('file references preserve root priority, Unicode, spaces, tilde, missing paths and line/column', () => {
  const seen = [];
  const o = options({roots: ['/session', undefined, '/session', '/opened'], exists: value => {seen.push(value); return value === '/opened/文 件.ts';}});
  assert.deepEqual(resolveFileReference('文%20件.ts#L12C3', o), {filePath: '/opened/文 件.ts', line: 12, column: 3});
  assert.deepEqual(seen, ['/session/文 件.ts', '/opened/文 件.ts']);
  assert.deepEqual(resolveFileReference('/absolute/a.ts:8:2', o), {filePath: '/absolute/a.ts', line: 8, column: 2});
  assert.deepEqual(resolveFileReference('~/notes.md', o), {filePath: '/home/test/notes.md', line: undefined});
  assert.deepEqual(resolveFileReference('missing.txt', o), {filePath: '/session/missing.txt', line: undefined});
  assert.deepEqual(resolveFileReference('name%bad.txt', options({roots: []})), {filePath: undefined, line: undefined});
  assert.deepEqual(resolveFileReference('C:\\项目\\file name.ts:4', o), {filePath: '/mnt/c/项目/file name.ts', line: 4});
  assert.throws(() => resolveFileReference('javascript:alert(1)', o), /不支持/);
});

test('encoded filename delimiters and literal percent are decoded once without becoming location suffixes', () => {
  const o = options();
  assert.deepEqual(resolveFileReference('file:///tmp/name%23L12', o), {filePath: '/tmp/name#L12', line: undefined});
  assert.deepEqual(resolveFileReference('file:///tmp/name%2520.txt#L2', o), {filePath: '/tmp/name%20.txt', line: 2});
  assert.deepEqual(resolveFileReference('file:///tmp/name%3A12', o), {filePath: '/tmp/name:12', line: undefined});
  assert.deepEqual(resolveFileReference('name%3A12', o), {filePath: '/session/name:12', line: undefined});
});

test('Windows file URI maps to WSL and native Windows resolver uses its path flavor', () => {
  assert.deepEqual(resolveFileReference('file:///C:/project/a%20b.ts:8', options()), {filePath: '/mnt/c/project/a b.ts', line: 8});
  assert.deepEqual(resolveFileReference('C:\\project\\a.ts:4:2', options({platform: 'win32', roots: ['C:\\project']})), {filePath: 'C:\\project\\a.ts', line: 4, column: 2});
});
