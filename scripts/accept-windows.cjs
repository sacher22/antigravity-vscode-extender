const { chromium } = require("playwright");
const fs = require("fs");
const assert = require("assert/strict");
(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const p = b.contexts()[0].pages()[0];
  const report = {
    realWindow: true,
    environment: "Windows VS Code 1.140.0 + WSL extension development host",
    steps: [],
    ime: "Synthetic composition tests only; Chinese text insertion is tested in actual window.",
  };
  try {
    await p.keyboard.press("Control+Shift+P");
    await p
      .locator(".quick-input-widget input")
      .fill(">Developer: Reload Window");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(5000);
    let f;
    for (const frame of p.frames())
      if (await frame.locator("#message-input").count()) f = frame;
    if (!f) throw new Error("No React Webview frame");
    const first = await f.locator("#session-select").inputValue();
    assert.match(
      await f.locator(".workspace").innerText(),
      /antigravity-vscode-extender/,
    );
    report.steps.push("workspace name correct");
    if ((await f.locator("#permission-btn").innerText()) === "Safe") {
      await f.locator("#permission-btn").click();
      await f
        .locator("#permission-btn")
        .filter({ hasText: "Danger" })
        .waitFor();
    }
    await f.locator("#message-input").fill("Reply exactly WINDOWPASS.");
    await f.locator("#send-btn").click();
    await f
      .locator(".assistant")
      .filter({ hasText: "WINDOWPASS" })
      .waitFor({ timeout: 60000 });
    await f.locator("#send-btn").waitFor({ timeout: 60000 });
    report.steps.push("actual CLI send and completed response");
    await f.locator("#mode-select").selectOption("plan");
    await f.waitForFunction(
      () =>
        document.querySelector("#mode-select").value === "plan" &&
        !document.querySelector("#mode-select").disabled,
    );
    await f.locator("#message-input").fill("请保留这个未发送草稿");
    await f.locator("#new-session-btn").click();
    await f.waitForFunction(
      (old) => document.querySelector("#session-select").value !== old,
      first,
    );
    assert.equal(await f.locator(".message").count(), 0);
    assert.equal(await f.locator("#mode-select").inputValue(), "normal");
    assert.equal(await f.locator("#message-input").inputValue(), "");
    report.steps.push(
      "Plan switch then plus creates new blank normal conversation",
    );
    await f.locator("#session-select").selectOption(first);
    await f.locator(".assistant").filter({ hasText: "WINDOWPASS" }).waitFor();
    await f.waitForFunction(
      () =>
        document.querySelector("#message-input").value ===
        "请保留这个未发送草稿",
    );
    assert.equal(await f.locator("#mode-select").inputValue(), "plan");
    report.steps.push("history and draft restore");
    await f.locator("#mode-select").selectOption("normal");
    await f.waitForFunction(
      () => !document.querySelector("#mode-select").disabled,
    );
    await p.keyboard.press("Control+Shift+P");
    await p
      .locator(".quick-input-widget input")
      .fill(">Developer: Reload Window");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(5000);
    f = undefined;
    for (const frame of p.frames())
      if (await frame.locator("#message-input").count()) f = frame;
    if (!f) throw new Error("No frame after reload");
    await f.locator(".assistant").filter({ hasText: "WINDOWPASS" }).waitFor();
    assert.equal(
      await f.locator("#message-input").inputValue(),
      "请保留这个未发送草稿",
    );
    assert.equal(await f.locator("#mode-select").inputValue(), "normal");
    await f.locator("#new-session-btn").click();
    await f.waitForFunction(
      (old) => document.querySelector("#session-select").value !== old,
      first,
    );
    report.steps.push(
      "reload restores transcript draft mode, plus still works",
    );
    await p.screenshot({
      path: "C:/Users/Public/agy-2-acceptance/accepted.png",
    });
    report.passed = true;
  } catch (e) {
    report.passed = false;
    report.error = e.stack;
    throw e;
  } finally {
    fs.writeFileSync(
      "C:/Users/Public/agy-2-acceptance/result.json",
      JSON.stringify(report, null, 2),
    );
    console.log(report);
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
