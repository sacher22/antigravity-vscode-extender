const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {randomUUID} = require("node:crypto");
const {nativeLogCursorAsync, nativeHistoryWithCursorAsync} = require("../out/conversation/nativeHistory");
const {ConversationRepository} = require("../out/conversation/repository");
const {ConversationController} = require("../out/conversation/controller");
async function fixture() {
  const id = "cursor-test-" + randomUUID();
  const root = path.join(os.homedir(), ".gemini/antigravity-cli/brain", id);
  const directory = path.join(root, ".system_generated/logs");
  await fs.mkdir(directory, {recursive: true});
  return {id, root, file: path.join(directory, "transcript.jsonl")};
}
const line = content => JSON.stringify({source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content}) + "\n";

test("handoff cursor commits complete records and later imports fragmented UTF-8 exactly once", async () => {
  const f = await fixture();
  try {
    const first = Buffer.from(line("old response"));
    const second = Buffer.from(line("中文🙂".repeat(100)));
    const split = Math.floor(second.length / 2);
    await fs.writeFile(f.file, Buffer.concat([first, second.subarray(0, split)]));
    const cursor = await nativeLogCursorAsync(f.id);
    assert.equal(cursor.offset, first.length);
    assert.equal(cursor.observedSize, first.length + split);
    const incomplete = await nativeHistoryWithCursorAsync(f.id, cursor.offset, cursor);
    assert.equal(incomplete.messages.length, 0);
    assert.equal(incomplete.nextOffset, cursor.offset);
    assert(incomplete.hasMore);
    await fs.appendFile(f.file, second.subarray(split));
    const page = await nativeHistoryWithCursorAsync(f.id, cursor.offset, cursor);
    assert.equal(page.messages[0].content, "中文🙂".repeat(100));
    assert.equal(page.nextOffset, first.length + second.length);
    const repeated = await nativeHistoryWithCursorAsync(f.id, page.nextOffset, page.cursor);
    assert.equal(repeated.messages.length, 0);
    assert.equal(repeated.nextOffset, page.nextOffset);
  } finally {await fs.rm(f.root, {recursive: true, force: true});}
});

test("replaced or shortened native logs reject the saved cursor without modifying it", async () => {
  const f = await fixture();
  try {
    const original = line("saved response");
    await fs.writeFile(f.file, original);
    const cursor = await nativeLogCursorAsync(f.id);
    const preserved = structuredClone(cursor);
    await fs.rename(f.file, f.file + ".original");
    await fs.writeFile(f.file, original);
    await assert.rejects(nativeHistoryWithCursorAsync(f.id, cursor.offset, cursor), /替换|截断/);
    await fs.unlink(f.file);
    await fs.rename(f.file + ".original", f.file);
    await fs.truncate(f.file, 0);
    await assert.rejects(nativeHistoryWithCursorAsync(f.id, cursor.offset, cursor), /截断/);
    await fs.writeFile(f.file, line("other response"));
    await assert.rejects(nativeHistoryWithCursorAsync(f.id, cursor.offset, cursor), /替换|截断|改写/);
    assert.deepEqual(cursor, preserved);
  } finally {await fs.rm(f.root, {recursive: true, force: true});}
});

test("missing initial log may be created, but disappearance of an established log is an error", async () => {
  const f = await fixture();
  try {
    const absent = await nativeLogCursorAsync(f.id);
    assert.equal(absent.offset, 0);
    await fs.writeFile(f.file, line("created later"));
    const page = await nativeHistoryWithCursorAsync(f.id, 0, absent);
    assert.equal(page.messages.length, 1);
    await fs.unlink(f.file);
    await assert.rejects(nativeHistoryWithCursorAsync(f.id, page.nextOffset, page.cursor));
    await assert.rejects(nativeHistoryWithCursorAsync(f.id, page.nextOffset + 1, page.cursor), /不一致/);
  } finally {await fs.rm(f.root, {recursive: true, force: true});}
});

test("controller persists native identity across restart and preserves history on replacement failure", async () => {
  const f = await fixture();
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "agy-cursor-controller-"));
  const state = {get: (_, fallback) => fallback, update: async () => {}};
  const context = {globalStorageUri: {fsPath: storage}, globalState: state};
  const env = {config: () => ({defaultModel: "m", reasoningEffort: "high"}), workspace: () => ({root: storage, directories: [storage]}), log() {}};
  let controller;
  try {
    await fs.writeFile(f.file, line("old native response"));
    const cursor = await nativeLogCursorAsync(f.id);
    const repo = new ConversationRepository(context);
    const session = repo.createSession("cursor-session", "m", "high");
    session.messages = [{id: "existing", role: "assistant", content: "old native response"}];
    session.cliConversationId = f.id;
    session.nativeLogOffsets = {[f.id]: cursor.offset};
    session.nativeLogCursors = {[f.id]: cursor};
    repo.saveSession(session);await repo.flush();
    controller = new ConversationController(env, repo);
    controller.prepareOrSwitchSessionUI(session.id);
    await fs.appendFile(f.file, line("new native response"));
    await controller.syncNativeHistory();
    assert.deepEqual(session.messages.map(message => message.content), ["old native response", "new native response"]);
    await controller.dispose();controller = undefined;
    const restoredRepo = await ConversationRepository.open(context);
    controller = new ConversationController(env, restoredRepo);
    controller.prepareOrSwitchSessionUI(session.id);
    const restored = controller.currentSessionMeta;
    const before = structuredClone(restored.nativeLogCursors[f.id]);
    await controller.syncNativeHistory();
    assert.equal(restored.messages.length, 2);
    await fs.rename(f.file, f.file + ".original");
    await fs.writeFile(f.file, line("replacement"));
    await assert.rejects(controller.syncNativeHistory(), /替换|截断/);
    assert.equal(restored.messages.length, 2);
    assert.deepEqual(restored.nativeLogCursors[f.id], before);
    assert.equal(restored.nativeLogOffsets[f.id], before.offset);
  } finally {
    await controller?.dispose();
    await fs.rm(storage, {recursive: true, force: true});
    await fs.rm(f.root, {recursive: true, force: true});
  }
});
test('native import rejects pathname replacement during read before publishing messages', async () => {
  const f=await fixture();
  const original=fs.realpath;
  try {
    await fs.writeFile(f.file,line('old'));
    const prior=await nativeLogCursorAsync(f.id);
    await fs.appendFile(f.file,line('append'));
    let calls=0;
    fs.realpath=async (...args)=>{
      if(args[0] === f.file && ++calls === 2){await fs.rename(f.file,f.file+'.old');await fs.writeFile(f.file,line('replacement'));}
      return original(...args);
    };
    await assert.rejects(nativeHistoryWithCursorAsync(f.id,prior.offset,prior),/读取期间替换/);
  } finally {fs.realpath=original;await fs.rm(f.root,{recursive:true,force:true});}
});
