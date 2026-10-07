const { chromium } = require("playwright");
const fs = require("fs");
const assert = require("assert/strict");
(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const p = b.contexts()[0].pages()[0];
  const report = {
    environment: "Windows VS Code + WSL development host, actual CLI v1.2.14",
    steps: [],
  };
  const output = "C:/Users/Public/agy-2-acceptance/2.1-result.json";
  const file =
    "\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\agy-2.1-final\\acceptance-approved.txt";
  try {
    await p.keyboard.press("Control+Shift+P");
    await p
      .locator(".quick-input-widget input")
      .fill(">Developer: Reload Window");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(5000);
    await p.keyboard.press("Control+Shift+P");
    await p
      .locator(".quick-input-widget input")
      .fill(">Antigravity: Open Chat Sidebar");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(1500);
    let f;
    for (const frame of p.frames())
      if (await frame.locator("#message-input").count()) f = frame;
    if (!f) throw Error("No sidebar frame");
    await f.locator("#new-session-btn").click();
    await f.waitForFunction(
      () => !document.querySelector("#new-session-btn").disabled,
    );
    assert(
      (await f.locator(".workspace").innerText()).includes("agy-2.1-final"),
    );
    if ((await f.locator("#permission-btn").innerText()) === "Safe") {
      await f.locator("#permission-btn").click();
      await f
        .locator("#permission-btn")
        .filter({ hasText: "Danger" })
        .waitFor();
    }
    const a = await f.locator("#session-select").inputValue();
    await f
      .locator("#message-input")
      .fill(
        "Use invoke_subagent to spawn exactly two research subagents concurrently. First: reply ALPHA_WINDOW only, no tools and no file writes. Second: reply BETA_WINDOW only, no tools and no file writes. Wait for both and summarize. Do not change files.",
      );
    await f.locator("#send-btn").click();
    await f.locator("#stop-btn").waitFor();
    assert.equal(await f.locator("#session-select").isEnabled(), true);
    await f.locator("#new-session-btn").click();
    await f.waitForFunction(
      (old) => document.querySelector("#session-select").value !== old,
      a,
    );
    const planSession = await f.locator("#session-select").inputValue();
    report.steps.push(
      "new conversation during actual CLI execution; history selector remains enabled",
    );
    await f.locator("#mode-select").selectOption("plan");
    await f.waitForFunction(
      () => !document.querySelector("#mode-select").disabled,
    );
    await f
      .locator("#message-input")
      .fill(
        "Create acceptance-approved.txt containing APPROVED_ONLY in the current workspace. Give a short plan first and wait for my approval.",
      );
    await f.locator("#send-btn").click();
    await f.locator("#approve-plan-btn").waitFor({ timeout: 90000 });
    let exists = false;
    try {
      require("child_process").execFileSync("wsl.exe", [
        "-d",
        "Ubuntu-24.04",
        "--",
        "test",
        "-e",
        "/tmp/agy-2.1-final/acceptance-approved.txt",
      ]);
      exists = true;
    } catch (e) {
      if (e.status !== 1) throw e;
    }
    assert.equal(exists, false);
    assert.equal(await f.locator("#permission-btn").innerText(), "Plan 只读");
    report.steps.push(
      "actual Plan response visible; no project file before approval",
    );
    await f.locator("#session-select").selectOption(a);
    await f
      .locator("#agents-btn")
      .filter({ hasText: "2 Agents" })
      .waitFor({ timeout: 90000 });
    await f.locator("#agents-btn").click();
    await f.locator(".agent-card").first().waitFor();
    await f.locator(".agent-card").first().click();
    await f
      .locator(".agent-transcript")
      .filter({ hasText: "ALPHA_WINDOW" })
      .waitFor({ timeout: 30000 });
    report.steps.push(
      "background parent retained; 2 native agent cards; independent native transcript opens",
    );
    await f.locator("#session-select").selectOption(planSession);
    await f.locator("#approve-plan-btn").waitFor();
    await f.locator("#approve-plan-btn").click();
    await f
      .locator(".user")
      .filter({ hasText: "批准并执行方案" })
      .waitFor({ timeout: 90000 });
    await f.waitForFunction(
      () =>
        document
          .querySelector(".assistant:last-child")
          ?.textContent.includes("APPROVED_ONLY") &&
        !!document.querySelector("#send-btn"),
      { timeout: 90000 },
    );
    assert.equal(
      require("child_process")
        .execFileSync(
          "wsl.exe",
          [
            "-d",
            "Ubuntu-24.04",
            "--",
            "cat",
            "/tmp/agy-2.1-final/acceptance-approved.txt",
          ],
          { encoding: "utf8" },
        )
        .trim(),
      "APPROVED_ONLY",
    );
    report.steps.push(
      "explicit Plan approval switches to execution and creates only requested file",
    );
    await p.screenshot({
      path: "C:/Users/Public/agy-2-acceptance/2.1-window.png",
    });
    report.passed = true;
  } catch (e) {
    report.passed = false;
    report.error = e.stack;
    throw e;
  } finally {
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(report);
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
