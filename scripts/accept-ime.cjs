const { chromium } = require("playwright");
const fs = require("fs");
const { execFileSync } = require("child_process");
(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const p = b.contexts()[0].pages()[0];
  const r = { realOSInput: true };
  try {
    await p.keyboard.press("Control+Shift+P");
    await p
      .locator(".quick-input-widget input")
      .fill(">Developer: Reload Window");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(5000);
    const f = p.frames().find((f) => f.url().includes("fake.html"));
    await f.locator("#new-session-btn").click();
    await f.locator("#message-input").fill("");
    await f.evaluate(() => {
      window.imeEvents = [];
      for (const name of [
        "compositionstart",
        "compositionupdate",
        "compositionend",
        "keydown",
      ])
        document.querySelector("#message-input").addEventListener(name, (e) =>
          window.imeEvents.push({
            type: name,
            key: e.key,
            isComposing: e.isComposing,
            data: e.data,
          }),
        );
    });
    await p.bringToFront();
    await f.locator("#message-input").click();
    console.log(
      execFileSync(
        "powershell.exe",
        ["-NoProfile", "-File", "C:/Users/Public/agy-2-acceptance/ime.ps1"],
        { encoding: "utf8", windowsHide: true },
      ),
    );
    await p.waitForTimeout(500);
    r.events = await f.evaluate(() => window.imeEvents);
    r.draft = await f.locator("#message-input").inputValue();
    r.userMessages = await f.locator(".message.user").count();
    r.passed =
      r.events.some((e) => e.type === "compositionstart") &&
      r.events.some((e) => e.type === "compositionend") &&
      r.userMessages === 0;
    await f.locator("#message-input").fill("");
    await f.evaluate(() => (window.imeEvents = []));
    await f.locator("#message-input").click();
    console.log(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-File",
          "C:/Users/Public/agy-2-acceptance/ime.ps1",
          "space",
        ],
        { encoding: "utf8", windowsHide: true },
      ),
    );
    await p.waitForTimeout(300);
    r.spaceEvents = await f.evaluate(() => window.imeEvents);
    r.chineseDraft = await f.locator("#message-input").inputValue();
    r.passed =
      r.passed &&
      /[\u4e00-\u9fff]/.test(r.chineseDraft) &&
      (await f.locator(".message.user").count()) === 0;
    console.log(r);
    await f.locator("#message-input").fill("");
    await p.waitForTimeout(400);
  } catch (e) {
    r.error = e.message;
    console.log(r);
  } finally {
    fs.writeFileSync(
      "C:/Users/Public/agy-2-acceptance/ime-result.json",
      JSON.stringify(r, null, 2),
    );
    await b.close();
  }
})();
