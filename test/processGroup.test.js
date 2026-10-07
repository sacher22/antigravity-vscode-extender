const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {processGroupExited} = require("../out/core/processGroup");

test("stop verification accepts disappearing proc entries but never treats denied access as exited", async () => {
  const kill = process.kill, readdir = fs.promises.readdir, readFile = fs.promises.readFile;
  let code = "ESRCH";
  const group = 987654321;
  try {
    process.kill = (pid, signal) => {
      if (pid === -group && signal === 0) return true;
      return kill(pid, signal);
    };
    fs.promises.readdir = async (...args) => args[0] === "/proc" ? ["123", "self"] : readdir(...args);
    fs.promises.readFile = async (...args) => {
      if (args[0] === "/proc/123/stat") throw Object.assign(new Error("injected proc read"), {code});
      return readFile(...args);
    };
    assert.equal(await processGroupExited(group), true);
    code = "ENOENT";
    assert.equal(await processGroupExited(group), true);
    code = "EACCES";
    assert.equal(await processGroupExited(group), false);
    code = "EIO";
    assert.equal(await processGroupExited(group), false);
  } finally {process.kill = kill; fs.promises.readdir = readdir; fs.promises.readFile = readFile;}
});
