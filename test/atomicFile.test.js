const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {writeAtomicFile} = require('../out/conversation/atomicFile');

test('atomic temporary name collision never deletes an existing record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-atomic-collision-'));
  const file = path.join(root, 'record.json'), tmp = file + '.collision.tmp';
  fs.writeFileSync(file, 'committed original');
  fs.writeFileSync(tmp, 'another temporary owner');
  const uuid = crypto.randomUUID;
  let warnings = 0;
  try {
    crypto.randomUUID = () => 'collision';
    await assert.rejects(writeAtomicFile(file, 'new record', () => warnings++), error => error.code === 'EEXIST');
    assert.equal(fs.readFileSync(file, 'utf8'), 'committed original');
    assert.equal(fs.readFileSync(tmp, 'utf8'), 'another temporary owner');
    assert.equal(warnings, 0);
  } finally {crypto.randomUUID = uuid; fs.rmSync(root, {recursive: true, force: true});}
});

test('atomic cleanup callback failure cannot replace primary persistence error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-atomic-warning-'));
  const file = path.join(root, 'record.json');
  const rename = fs.promises.rename, remove = fs.promises.rm;
  let temporary, called = 0;
  const primary = Object.assign(new Error('original persistence failure'), {code: 'EIO'});
  try {
    fs.promises.rename = async from => {temporary = from; throw primary;};
    fs.promises.rm = async target => {assert.equal(target, temporary); throw new Error('secondary cleanup failure');};
    await assert.rejects(writeAtomicFile(file, 'new record', () => {called++; throw new Error('reporting failure');}), error => error === primary);
    assert.equal(called, 1);
    assert.equal(fs.readFileSync(temporary, 'utf8'), 'new record');
  } finally {
    fs.promises.rename = rename;
    fs.promises.rm = remove;
    fs.rmSync(root, {recursive: true, force: true});
  }
});
