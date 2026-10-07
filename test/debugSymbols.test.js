const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

test('debug symbol capture uses script root, validates hashes and refuses existing or aliased build output', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-symbols-'));
  const root = path.join(tmp, 'source'), script = path.join(root, 'scripts/archive-debug-symbols.cjs');
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const run = output => spawnSync(process.execPath, [script, output], {cwd: os.tmpdir(), encoding: 'utf8'});
  try {
    for (const dir of ['scripts', 'out/nested', 'media']) fs.mkdirSync(path.join(root, dir), {recursive: true});
    fs.copyFileSync(path.resolve('scripts/archive-debug-symbols.cjs'), script);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({version: '9.9.9'}));
    fs.writeFileSync(path.join(root, 'out/nested/runtime.js'), 'module.exports = 1');
    fs.writeFileSync(path.join(root, 'out/nested/runtime.js.map'), 'map bytes 中文');
    fs.writeFileSync(path.join(root, 'media/chat.js.map'), 'browser map');
    const external = path.join(tmp, 'external.map');
    fs.writeFileSync(external, 'excluded symlink content');
    fs.symlinkSync(external, path.join(root, 'media/alias.map'));
    const output = path.join(tmp, 'symbols');
    const captured = run(output);
    assert.equal(captured.status, 0, captured.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json')));
    assert.equal(manifest.packageVersion, '9.9.9');
    assert.deepEqual(Object.keys(manifest.files).sort(), ['media/chat.js.map', 'out/nested/runtime.js.map']);
    for (const [relative, info] of Object.entries(manifest.files)) {
      const copy = path.join(output, relative);
      assert.equal(info.sha256, digest(copy));
      assert.equal(info.sha256, digest(path.join(root, relative)));
      assert.equal(info.size, fs.statSync(copy).size);
      assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
    }
    assert.equal(manifest.files['out/nested/runtime.js.map'].jsSha256, digest(path.join(root, 'out/nested/runtime.js')));
    assert.equal(fs.statSync(output).mode & 0o777, 0o700);
    const previous = digest(path.join(output, 'manifest.json'));
    assert.notEqual(run(output).status, 0);
    assert.equal(digest(path.join(output, 'manifest.json')), previous);
    const inside = path.join(root, 'out/new-symbols');
    assert.notEqual(run(inside).status, 0);
    assert.equal(fs.existsSync(inside), false);
    fs.symlinkSync(path.join(root, 'out'), path.join(tmp, 'linked-build'), 'dir');
    const aliased = path.join(tmp, 'linked-build/new-symbols');
    assert.notEqual(run(aliased).status, 0);
    assert.equal(fs.existsSync(aliased), false);
    assert.notEqual(spawnSync(process.execPath, [script], {encoding: 'utf8'}).status, 0);
  } finally {fs.rmSync(tmp, {recursive: true, force: true});}
});
