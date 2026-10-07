const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {fileURLToPath, pathToFileURL} = require('node:url');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');

function harness() {
  const code = 'new code\n';
  const uri = value => ({fsPath: value.startsWith('file:') ? fileURLToPath(value) : value, toString: () => value});
  const file = value => uri(pathToFileURL(value).toString());
  const document = name => ({uri: file(name), version: 3, text: 'old body', getText() {return this.text;}, positionAt: offset => ({offset})});
  const target = document('/workspace/one/file.ts'), other = document('/workspace/two/file.ts');
  const documents = new Map([target, other].map(doc => [doc.uri.toString(), doc]));
  const state = {session: {id: 'session-a', workspaceRoot: '/workspace', messages: [{id: 'message', role: 'assistant', status: 'completed', content: '```ts\n' + code + '```'}]}, applySuccess: true};
  const published = [], applied = [], diffs = [], contents = new Map(), removed = [], shown = [], external = [];
  let closeDocument, disposed = 0;
  const mock = {
    Uri: {file, parse: uri},
    Position: class {constructor(line, character) {this.line = line; this.character = character;}},
    env: {openExternal: async value => {external.push(value.toString()); return true;}},
    Range: class {constructor(start, end) {this.start = start; this.end = end;}},
    WorkspaceEdit: class {replace(target, range, text) {this.change = {target, range, text};}},
    commands: {executeCommand: async (...args) => diffs.push(args)},
    window: {activeTextEditor: {document: target}, showTextDocument: async (doc, options) => {shown.push({doc, options});}},
    workspace: {
      workspaceFolders: [{uri: file('/workspace')}],
      openTextDocument: async value => state.open ? state.open(value) : documents.get(value.toString()),
      applyEdit: async edit => {if (!state.applySuccess) return false; applied.push(edit.change); return true;},
      onDidCloseTextDocument: handler => {closeDocument = handler; return {dispose() {disposed++;}};},
    },
  };
  const original = Module._load, modulePath = require.resolve('../out/ui/editorActions');
  delete require.cache[modulePath];
  Module._load = function(name, ...args) {return name === 'vscode' ? mock : original.call(this, name, ...args);};
  let EditorActions;
  try {EditorActions = require(modulePath).EditorActions;} finally {Module._load = original;}
  const actions = new EditorActions(() => state.session, {
    setContent: (uri, code) => contents.set(uri.toString(), code),
    removeContent: uri => {removed.push(uri); contents.delete(uri);},
  }, message => published.push(message));
  return {actions, code, state, target, other, mock, published, applied, diffs, contents, removed, shown, external, close: doc => closeDocument(doc), get disposed() {return disposed;}};
}

test('editor preview IDs distinguish same basenames and apply retains reviewed target after active editor changes', async () => {
  const h = harness();
  try {
    await h.actions.showDiffView(h.code, 'one/file.ts', 'message', 0);
    await h.actions.showDiffView(h.code, 'two/file.ts', 'message', 0);
    const [first, second] = h.published;
    assert.notEqual(first.previewId, second.previewId);
    assert.notEqual(h.diffs[0][2].toString(), h.diffs[1][2].toString());
    h.mock.window.activeTextEditor = {document: h.other};
    await h.actions.applyCode(first.previewId, h.code, 'message', 0);
    assert.equal(h.applied[0].target.toString(), h.target.uri.toString());
    assert.equal(h.applied[0].text, h.code);
    await assert.rejects(h.actions.applyCode(first.previewId, h.code, 'message', 0), /预览/);
    h.close({uri: h.diffs[1][2]});
    await assert.rejects(h.actions.applyCode(second.previewId, h.code, 'message', 0), /预览/);
    assert.equal(h.contents.size, 0);
  } finally {h.actions.dispose();}
  assert.equal(h.disposed, 1);
});

for (const changed of ['version', 'content', 'session']) test(`editor apply rejects ${changed} changed after preview`, async () => {
  const h = harness();
  try {
    await h.actions.showDiffView(h.code, 'one/file.ts', 'message', 0);
    const preview = h.published[0];
    if (changed === 'version') h.target.version++;
    if (changed === 'content') h.target.text = 'different text with same version';
    if (changed === 'session') h.state.open = async () => {h.state.session = {...h.state.session, id: 'other-session'}; return h.target;};
    await assert.rejects(h.actions.applyCode(preview.previewId, h.code, 'message', 0), /变化|预览/);
    assert.equal(h.applied.length, 0);
    assert.equal(h.contents.size, 1);
  } finally {h.actions.dispose();}
  assert.equal(h.contents.size, 0);
});

test('editor preview rejects stale code and session change during document open; failed apply can retry', async () => {
  const h = harness();
  try {
    await assert.rejects(h.actions.showDiffView('unrelated code', undefined, 'message', 0), /代码块/);
    h.state.open = async () => {h.state.session = {...h.state.session, id: 'other-session'}; return h.target;};
    await assert.rejects(h.actions.showDiffView(h.code, 'one/file.ts', 'message', 0), /会话已切换/);
    assert.equal(h.contents.size, 0);
    delete h.state.open;
    await h.actions.showDiffView(h.code, 'one/file.ts', 'message', 0);
    const preview = h.published[0];
    h.state.applySuccess = false;
    await assert.rejects(h.actions.applyCode(preview.previewId, h.code, 'message', 0), /应用修改失败/);
    assert.equal(h.contents.size, 1);
    h.state.applySuccess = true;
    await h.actions.applyCode(preview.previewId, h.code, 'message', 0);
    assert.equal(h.applied.length, 1);
    assert.equal(h.contents.size, 0);
  } finally {h.actions.dispose();}
});

for (const outcome of ['command-error', 'session', 'version', 'source', 'closed']) test(`diff command ${outcome} does not publish or retain an unusable preview`, async () => {
  const h = harness();
  try {
    h.mock.commands.executeCommand = async (...args) => {
      if (outcome === 'command-error') throw new Error('diff command unavailable');
      if (outcome === 'session') h.state.session = {...h.state.session, id: 'new-session'};
      if (outcome === 'version') h.target.version++;
      if (outcome === 'source') h.state.session.messages[0].content = '```ts\nchanged code\n```';
      if (outcome === 'closed') h.close({uri: args[2]});
    };
    await assert.rejects(h.actions.showDiffView(h.code, 'one/file.ts', 'message', 0), /unavailable|变化|切换|代码块|预览/);
    assert.equal(h.published.length, 0);
    assert.equal(h.contents.size, 0);
    assert.equal(h.removed.length, 1);
  } finally {h.actions.dispose();}
});

test('disposing editor actions during document open prevents creating or applying a later preview', async () => {
  const h = harness();
  try {
    h.state.open = async () => {h.actions.dispose(); return h.target;};
    await assert.rejects(h.actions.showDiffView(h.code, 'one/file.ts', 'message', 0), /操作已结束/);
    assert.equal(h.contents.size, 0);
    assert.equal(h.published.length, 0);
    assert.equal(h.applied.length, 0);
  } finally {h.actions.dispose();}
  assert.equal(h.disposed, 1);
});

function fileOpeningHarness() {
  const h = harness();
  h.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-editor-open-'));
  const roots = ['session', 'folder', 'editor'].map(name => path.join(h.tmp, name));
  for (const root of roots) fs.mkdirSync(root);
  h.state.session.workspaceRoot = roots[0];
  h.mock.workspace.workspaceFolders = [{uri: h.mock.Uri.file(roots[1])}];
  h.mock.window.activeTextEditor = {document: {uri: {...h.mock.Uri.file(path.join(roots[2], 'active.ts')), scheme: 'file'}}};
  h.state.open = async value => ({uri: value, lineCount: 3, lineAt: line => ({text: ['first', 'second', ''][line]})});
  h.write = (index, name) => {const file = path.join(roots[index], name); fs.writeFileSync(file, 'first\nsecond\n'); return file;};
  h.cleanup = () => {h.actions.dispose(); fs.rmSync(h.tmp, {recursive: true, force: true});};
  return h;
}

test('file opening keeps session/workspace/editor root priority, URI decoding and clamped positions', async () => {
  const h = fileOpeningHarness();
  try {
    const name = '文 件%20.ts';
    const sessionFile = h.write(0, name);
    const folderFile = h.write(1, name);
    const editorFile = h.write(2, name);
    await h.actions.openResource(encodeURIComponent(name) + '#L2C99');
    assert.equal(h.shown[0].doc.uri.fsPath, sessionFile);
    assert.equal(h.shown[0].options.preview, true);
    assert.deepEqual({...h.shown[0].options.selection.start}, {line: 1, character: 6});
    fs.unlinkSync(sessionFile);
    await h.actions.openResource(encodeURIComponent(name) + ':99:99');
    assert.equal(h.shown[1].doc.uri.fsPath, folderFile);
    assert.deepEqual({...h.shown[1].options.selection.start}, {line: 2, character: 0});
    fs.unlinkSync(folderFile);
    await h.actions.openResource(encodeURIComponent(name) + ':0:0');
    assert.equal(h.shown[2].doc.uri.fsPath, editorFile);
    assert.deepEqual({...h.shown[2].options.selection.start}, {line: 0, character: 0});
    await h.actions.openResource(pathToFileURL(editorFile).toString());
    assert.equal(h.shown[3].doc.uri.fsPath, editorFile);
    assert.equal(h.shown[3].options.selection, undefined);
  } finally {h.cleanup();}
});

test('external links use only HTTP/HTTPS and filesystem failures are visible and retryable', async () => {
  const h = fileOpeningHarness();
  try {
    await h.actions.openResource('https://example.com/a#L2');
    await h.actions.openResource('http://example.com');
    assert.deepEqual(h.external, ['https://example.com/a#L2', 'http://example.com']);
    assert.equal(h.shown.length, 0);
    await assert.rejects(h.actions.openResource('command:workbench.action.closeWindow'), /不支持/);
    await assert.rejects(h.actions.openResource('javascript:alert(1)'), /不支持/);
    await assert.rejects(h.actions.openResource('missing.ts'), /File not found/);
    const filename = h.write(0, 'existing.ts');
    const open = h.state.open;
    h.state.open = async () => {throw new Error('open failed: EACCES');};
    await assert.rejects(h.actions.openResource('existing.ts'), /EACCES/);
    assert.equal(h.shown.length, 0);
    h.state.open = open;
    h.mock.window.showTextDocument = async () => {throw new Error('display failed');};
    await assert.rejects(h.actions.openResource('existing.ts'), /display failed/);
    h.mock.window.showTextDocument = async (doc, options) => h.shown.push({doc, options});
    await h.actions.openResource('existing.ts');
    assert.equal(h.shown[0].doc.uri.fsPath, filename);
  } finally {h.cleanup();}
});

for (const changed of ['session', 'disposed']) test(`file opening rejects ${changed} change while document is loading`, async () => {
  const h = fileOpeningHarness();
  try {
    h.write(0, 'existing.ts');
    const open = h.state.open;
    h.state.open = async value => {
      if (changed === 'session') h.state.session = {...h.state.session, id: 'switched', workspaceRoot: h.tmp};
      else h.actions.dispose();
      return open(value);
    };
    await assert.rejects(h.actions.openResource('existing.ts'), /会话|结束/);
    assert.equal(h.shown.length, 0);
    if (changed === 'disposed') {
      await assert.rejects(h.actions.openResource('https://example.com'), /结束/);
      assert.equal(h.external.length, 0);
    }
  } finally {h.cleanup();}
});
