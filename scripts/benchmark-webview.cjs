const { chromium } = require("playwright");
const { ConversationRepository } = require("../out/conversation/repository");
const { ConversationCoordinator } = require("../out/conversation/coordinator");
const { WebviewBridge } = require("../out/ui/webviewBridge");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-browser-"));
  const map = new Map();
  const state = {
    get: (k, d) => (map.has(k) ? map.get(k) : d),
    update: async (k, v) => map.set(k, v),
  };
  const root = path.resolve(__dirname, "..");
  const repo = new ConversationRepository({
    globalStorageUri: { fsPath: tmp },
    globalState: state,
    workspaceState: state,
  });
  const env = {
    config: () => ({
      cliPath: path.join(root, "test/fixtures/fake-agy.js"),
      defaultModel: "gemini-3.8-flash-high",
      reasoningEffort: "high",
      dangerouslySkipPermissions: false,
      autoScroll: true,
    }),
    workspace: () => ({ root, directories: [root] }),
    log() {},
    setPermissions: async () => {},
    terminal() {},
  };
  const controller = new ConversationCoordinator(env, repo);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  let timer;
  let delivery = [];
  let errors = [];
  const flush = async () => {
    if (!delivery.length) return;
    const batch = delivery;
    delivery = [];
    await page.evaluate((batch) => {
      for (const m of batch)
        window.dispatchEvent(new MessageEvent("message", { data: m }));
    }, batch);
  };
  const send = (m) => {
    delivery.push(JSON.parse(JSON.stringify(m)));
    if (!timer)
      timer = setTimeout(() => {
        timer = undefined;
        void flush().catch((e) => errors.push(e.message));
      }, 2);
  };
  controller.on("message", send);
  const bridge = new WebviewBridge(
    async (d) => {
      switch (d.command) {
        case "ready":
          controller.sendSnapshot();
          break;
        case "saveDraft":
          await controller.saveDraft(d.text, d.attachment);
          break;
        case "sendMessage":
          await controller.sendMessage(d.text, d.requestId);
          break;
        case "abortCurrentTurn":
          await controller.abortTurn();
          break;
        case "newSession":
          await controller.newSession();
          break;
      }
    },
    send,
    () => controller.currentSessionMeta?.id,
  );
  try {
    await page.exposeFunction("post", (d) => bridge.receive(d));
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ path: path.join(root, "media/chat.css") });
    await page.evaluate(() => {
      window.acquireVsCodeApi = () => ({
        postMessage: (d) => window.post(d),
        getState: () => ({}),
        setState() {},
      });
      window.delays = [];
      let received;
      window.addEventListener("message", (e) => {
        if (e.data.type === "streamDelta") received = e.data.receivedAt;
      });
      new MutationObserver(() => {
        if (received) {
          const at = received;
          received = undefined;
          requestAnimationFrame(() => window.delays.push(Date.now() - at));
        }
      }).observe(document.getElementById("root"), {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    await page.addScriptTag({ path: path.join(root, "media/chat.js") });
    await page.locator("#message-input").fill("hang");
    await page.locator("#send-btn").click();
    await page.locator(".assistant").waitFor();
    await page.waitForFunction(() =>
      document.querySelector(".assistant")?.textContent.includes("child:"),
    );
    const mainId = controller.currentSessionMeta.id;
    const background = [];
    for (let i = 0; i < 3; i++) {
      await controller.newSession();
      await controller.sendMessage("hang");
      background.push(controller.current());
    }
    await controller.switchSession(mainId);
    const main = controller.current();
    main.processManager.emit(
      "step_update",
      {
        step_index: 8,
        step_type: "subagent",
        tool_name: "invoke_subagent",
        state: "DONE",
        subagent_info: {
          subagents: Array.from({ length: 20 }, (_, i) => ({
            conversation_id: "benchmark-child-" + i,
            role: "Worker " + i,
          })),
        },
      },
      main.processManager.currentGeneration,
      Date.now(),
    );
    await page.locator("#agents-btn").click();
    await page.waitForSelector(".agent-card");
    const manager = main.processManager,
      generation = manager.currentGeneration;
    for (let i = 0; i < 1000; i++)
      manager.emit(
        "step_update",
        {
          step_index: 10 + i,
          step_type: "tool",
          tool_name: "tool-" + i,
          state: "DONE",
          tool_info: {
            name: "tool-" + i,
            parameters: { i },
            output: "o".repeat(80000),
          },
        },
        generation,
        Date.now(),
      );
    manager.emit(
      "step_update",
      {
        step_index: 2,
        step_type: "agent_response",
        state: "ACTIVE",
        text_delta: "x".repeat(100000),
      },
      generation,
      Date.now(),
    );
    await page.waitForFunction(
      () =>
        !!document.querySelector('[data-virtual-kind="tool"][data-virtual-total="1000"]') &&
        document
          .querySelector(".assistant")
          ?.textContent.includes("x".repeat(100000)),
    );
    await page.evaluate(() => (window.delays = []));
    for (let i = 0; i < 20; i++) {
      for (const r of background)
        r.processManager.emit(
          "step_update",
          {
            step_index: 2,
            step_type: "agent_response",
            state: "ACTIVE",
            text_delta: "b".repeat(5000),
          },
          r.processManager.currentGeneration,
          Date.now(),
        );
      manager.emit(
        "step_update",
        {
          step_index: 2,
          step_type: "agent_response",
          state: "ACTIVE",
          text_delta: "y",
        },
        generation,
        Date.now(),
      );
      await page.waitForFunction(
        (n) =>
          [...document.querySelectorAll(".stream-text")].some(
            (e) => e.textContent.length === n,
          ),
        100001 + i,
      );
      await page.waitForTimeout(20);
    }
    await page.locator("#message-input").fill("仍然可以输入");
    await page.locator(".messages").evaluate((e) => {
      e.scrollTop = 0;
    });
    const top = await page.locator(".messages").evaluate((e) => e.scrollTop);
    manager.emit(
      "step_update",
      {
        step_index: 2,
        step_type: "agent_response",
        state: "ACTIVE",
        text_delta: "z",
      },
      generation,
      Date.now(),
    );
    await page.waitForTimeout(80);
    assert.equal(
      await page.locator(".messages").evaluate((e) => e.scrollTop),
      top,
    );
    const latencies = await page.evaluate(() => window.delays);
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
    const started = Date.now();
    await page.locator("#stop-btn").click();
    await page.waitForSelector("#send-btn");
    const stopMs = Date.now() - started;
    await repo.flush();
    const report = {
      backgroundConversations: 3,
      agentCards: 20,
      environment:
        "headless Chromium; actual React bundle + bridge + controller + POSIX fake CLI",
      textCharacters: 100021,
      toolCards: 1000,
      toolOutputBytes: 80000000,
      samples: latencies.length,
      latencies,
      p95Ms: p95,
      stopMs,
      scrollPreserved: true,
      inputResponsive: true,
      errors,
    };
    fs.writeFileSync(
      path.resolve(root, process.env.AGY_BENCHMARK_OUTPUT || "diagnostics/2.1-performance.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(report);
    assert.ok(p95 <= 100, "P95 <=100ms");
    assert.equal(errors.length, 0);
  } finally {
    clearTimeout(timer);
    await controller.dispose();
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
