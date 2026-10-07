const { chromium } = require("playwright");
const fs = require("fs");
(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const p = b.contexts()[0].pages()[0];
  const report = {
    environment: "actual Windows VS Code + WSL extension host, React sidebar",
    model: "gemini-3.8-flash-high",
    effort: "high",
    permission: "Danger",
    workspace: "/home/ubuntu/project/antigravity-vscode-extender",
    prompt: "Reply exactly BENCHPASS. Do not use tools.",
    cold: [],
    warm: [],
  };
  try {
    await p.keyboard.press("Control+Shift+P");
    await p
      .locator(".quick-input-widget input")
      .fill(">Developer: Reload Window");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(5000);
    const f = p.frames().find((f) => f.url().includes("fake.html"));
    if (!f) throw Error("No frame");
    await f.locator("#message-input").waitFor();
    if ((await f.locator("#permission-btn").innerText()) === "Safe") {
      await f.locator("#permission-btn").click();
      await f
        .locator("#permission-btn")
        .filter({ hasText: "Danger" })
        .waitFor();
    }
    await f.evaluate(() => {
      window.rounds = [];
      let sent, received, previous;
      document.addEventListener(
        "click",
        (e) => {
          if (e.target.id === "send-btn") {
            sent = Date.now();
            received = undefined;
            previous = document
              .querySelector(".assistant:last-child")
              ?.getAttribute("data-message-id");
          }
        },
        true,
      );
      window.addEventListener(
        "message",
        (e) => {
          if (
            sent &&
            ["streamDelta", "turnComplete"].includes(e.data.type) &&
            received === undefined
          )
            received = e.data.receivedAt;
        },
        true,
      );
      new MutationObserver(() => {
        const m = document.querySelector(".assistant:last-child");
        if (
          sent &&
          m?.getAttribute("data-message-id") !== previous &&
          [...(m?.querySelectorAll(".stream-text,.markdown") || [])].some((e) =>
            e.textContent.includes("BENCHPASS"),
          )
        ) {
          const started = sent,
            at = received;
          sent = undefined;
          received = undefined;
          requestAnimationFrame(() =>
            window.rounds.push({
              submitToVisibleMs: Date.now() - started,
              cliEventToVisibleMs: at === undefined ? null : Date.now() - at,
            }),
          );
        }
      }).observe(document.getElementById("root"), {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    let count = 0;
    for (const mode of ["cold", "warm"])
      for (let i = 0; i < 5; i++) {
        if (mode === "cold") {
          const old = await f.locator("#session-select").inputValue();
          await f.locator("#new-session-btn").click();
          await f.waitForFunction(
            () => document.querySelectorAll(".message").length === 0,
          );
        }
        await f.locator("#message-input").fill(report.prompt);
        await f.locator("#send-btn").click();
        await f.waitForFunction((n) => window.rounds.length > n, count, {
          timeout: 60000,
        });
        await f.locator("#send-btn").waitFor({ timeout: 60000 });
        report[mode].push(await f.evaluate(() => window.rounds.at(-1)));
        count++;
        console.log(mode, i + 1, report[mode].at(-1));
        fs.writeFileSync(
          "C:/Users/Public/agy-2-acceptance/benchmark.json",
          JSON.stringify(report, null, 2),
        );
      }
  } finally {
    fs.writeFileSync(
      "C:/Users/Public/agy-2-acceptance/benchmark.json",
      JSON.stringify(report, null, 2),
    );
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
