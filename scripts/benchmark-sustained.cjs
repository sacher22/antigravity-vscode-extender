const { chromium } = require("playwright");
const { ConversationRepository } = require("../out/conversation/repository");
const { ConversationCoordinator } = require("../out/conversation/coordinator");
const { WebviewBridge } = require("../out/ui/webviewBridge");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
(async () => {
  const resourceProbe = process.env.AGY_BENCHMARK_RESOURCES === "1";
  if (resourceProbe && typeof global.gc !== "function")
    throw new Error("Resource probe requires node --expose-gc (diagnostic only)");
  const resourceSamples = [];
  const messageCounts = {};
  let resourceTimer;
  const collectHost = async () => {
    for (let i = 0; i < 3; i++) {
      global.gc();
      await new Promise(resolve => setImmediate(resolve));
    }
    return process.memoryUsage();
  };
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
  const providerPipeline = process.env.AGY_BENCHMARK_PROVIDER === "1";
  const context = {globalStorageUri: {fsPath: tmp}, globalState: state, workspaceState: state, subscriptions: []};
  let controller, provider, receiver, disposeView;
  if (providerPipeline) {
    const Module = require("node:module"), load = Module._load;
    const config = env.config();
    const mock = {commands: {executeCommand: async () => {}}, Range: class {}, WorkspaceEdit: class {},
      Uri: {joinPath: (base, ...parts) => ({fsPath: path.join(base.fsPath, ...parts)})}, ConfigurationTarget: {Global: 1},
      window: {createOutputChannel: () => ({appendLine() {}, dispose() {}})},
      workspace: {workspaceFolders: [{uri: {fsPath: root}}], getWorkspaceFolder: () => undefined,
        getConfiguration: () => ({get: (key, fallback) => config[key] ?? fallback, update: async () => {}})}};
    Module._load = function(name, ...args) {return name === "vscode" ? mock : load.call(this, name, ...args);};
    try {
      const {AgyService} = require("../out/services/agyService"), {ChatViewProvider} = require("../out/ui/chatViewProvider");
      controller = new AgyService(context, repo);
      provider = new ChatViewProvider({fsPath: root}, controller, repo, {});
    } finally {Module._load = load;}
  } else controller = new ConversationCoordinator(env, repo);
  const ownedGroups = new Set();
  if (resourceProbe) resourceTimer = setInterval(() => {
    const sample = {atMs: performance.now(), memory: process.memoryUsage(),
      writeQueue: repo.writeQueueStats};
    resourceSamples.push(sample);
    if (process.env.AGY_BENCHMARK_PROGRESS) fs.appendFileSync(process.env.AGY_BENCHMARK_PROGRESS,
      JSON.stringify({...sample, messageCounts: {...messageCounts}}) + "\n");
  }, 500);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  // Each process has its own monotonic origin. Calibrate across the transport;
  // do not mix Date.now with performance clocks (wall time can be adjusted).
  const calibrateClock = async () => {
    const samples = [];
    for (let i = 0; i < 9; i++) {
      const before = performance.timeOrigin + performance.now();
      const browserNow = await page.evaluate(() => performance.timeOrigin + performance.now());
      const after = performance.timeOrigin + performance.now();
      samples.push({rttMs: after - before, offsetMs: (before + after) / 2 - browserNow});
    }
    const best = samples.reduce((a, b) => a.rttMs <= b.rttMs ? a : b);
    return {...best, uncertaintyMs: best.rttMs / 2, samples};
  };
  const clockCalibration = await calibrateClock();
  let timer;
  let delivery = [];
  let errors = [];
  const deltas = Number(process.env.AGY_SUSTAINED_DELTAS || 1000);
  const initialCharacters = Number(process.env.AGY_SUSTAINED_INITIAL_CHARS || 100000);
  const contentKind = process.env.AGY_SUSTAINED_CONTENT || "plain";
  const complete = process.env.AGY_SUSTAINED_COMPLETE === "1";
  const prefix = ["code", "unclosed-code"].includes(contentKind) ? "```text\n" : contentKind === "markdown" ? "**Heading** [file](src/extension.ts) " : "";
  const richMarkdown = process.env.AGY_SUSTAINED_RICH === "1";
  const richSections = 32;
  const richParagraphSize = Math.floor(initialCharacters / richSections);
  const initialText = richMarkdown
    ? Array.from({length: richSections}, (_, i) => `## Section ${i}\n\n**Heading** [file](src/extension.ts) and \`inline-${i}\`\n\n${"x".repeat(richParagraphSize)}\n\n- List ${i}\n- More ${i}\n\n> Quote ${i}\n\n\`\`\`text\ncode-${i}\n\`\`\`\n\n`).join("")
    : prefix + "x".repeat(initialCharacters);
  const intervalMs = Number(process.env.AGY_SUSTAINED_INTERVAL || 40);
  const deltaText = "y".repeat(100);
  const toolStream = process.env.AGY_SUSTAINED_TOOLS === "1";
  const toolCount = Number(process.env.AGY_SUSTAINED_TOOL_COUNT || 1000);
  const historicalSessions = Number(process.env.AGY_SUSTAINED_HISTORIES || 0);
  const backgroundCount = Number(process.env.AGY_SUSTAINED_BACKGROUNDS || 3);
  const agentCount = Number(process.env.AGY_SUSTAINED_AGENTS || 20);
  const toolOutputBytes = Number(process.env.AGY_SUSTAINED_OUTPUT_BYTES || 80000000);
  for (const [name, value, max] of [["backgrounds", backgroundCount, 10], ["agents", agentCount, 100],
    ["tools", toolCount, 10000], ["output", toolOutputBytes, 500000000]])
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("Invalid " + name + " count");
  if (!Number.isSafeInteger(historicalSessions) || historicalSessions < 0) throw new Error("Invalid history count");
  let historyOptionsReadyMs;
  const initialToolOutputBytes = Math.floor(toolOutputBytes / toolCount);
  const inputLatencies = [];
  const hostBefore = {
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
    at: performance.now(),
  };
  const flush = async () => {
    if (!delivery.length) return;
    const batch = delivery;
    delivery = [];
    await page.evaluate((batch) => {
      for (const m of batch)
        window.dispatchEvent(new MessageEvent("message", { data: m }));
    }, batch);
  };
  let stopStateObservedAt;
  const send = (m) => {
    if (m.type === "turnState" && m.state.phase === "stopping" && stopStateObservedAt === undefined)
      stopStateObservedAt = performance.timeOrigin + performance.now();
    messageCounts[m.type] = (messageCounts[m.type] || 0) + 1;
    delivery.push(JSON.parse(JSON.stringify(m)));
    if (!timer)
      timer = setTimeout(() => {
        timer = undefined;
        void flush().catch((e) => errors.push(e.message));
      }, 2);
  };
  if (!providerPipeline) controller.on("message", send);
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
  if (providerPipeline) provider.resolveWebviewView({visible: true, show() {},
    onDidChangeVisibility: () => ({dispose() {}}), onDidDispose: callback => {disposeView = callback;},
    webview: {options: {}, html: "", cspSource: "test:", asWebviewUri: value => value.fsPath,
      onDidReceiveMessage: callback => {receiver = callback;return {dispose() {}};},
      postMessage: message => {send(message);return Promise.resolve(true);}}}, {}, {});
  try {
    // List rendering/index cost only; disk startup has its own independent benchmark.
    for (let i = 0; i < historicalSessions; i++) repo.sessions.set("benchmark-history-" + i, {
      id: "benchmark-history-" + i, title: "History " + i, updatedAt: i, createdAt: i,
      model: "gemini-3.8-flash-high", effort: "high", totalTokens: 0, messages: [], messageCount: 0,
    });
    await page.exposeFunction("post", (d) => providerPipeline ? receiver(d) : bridge.receive(d));
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ path: path.join(root, "media/chat.css") });
    await page.evaluate((clockOffsetMs) => {
      window.acquireVsCodeApi = () => ({
        postMessage: (d) => window.post(d),
        getState: () => ({}),
        setState() {},
      });
      window.delays = [];
      const expected = new Map();
      let pending = [];
      const measure = () => {
        const visible = Array.from(
          document.querySelectorAll(".stream-text"),
        ).map((node) => ({
          step: Number(node.dataset.stepIndex),
          length: node.textContent.length,
        }));
        const confirmed = pending.filter((record) =>
          visible.some(
            (node) => node.step === record.step && node.length >= record.length,
          ),
        );
        if (!confirmed.length) return;
        pending = pending.filter((record) => !confirmed.includes(record));
        requestAnimationFrame(() => {
          const now = performance.timeOrigin + performance.now() + clockOffsetMs;
          for (const record of confirmed)
            window.delays.push(now - record.receivedAt);
        });
      };
      window.addEventListener("message", (event) => {
        const m = event.data;
        if (m.type === "streamDelta") {
          const length = (expected.get(m.stepIndex) || 0) + m.delta.length;
          expected.set(m.stepIndex, length);
          pending.push({ step: m.stepIndex, length, receivedAt: m.receivedAt });
        }
        if (m.type === "initSession") {
          for (const block of m.activeTurn?.message?.blocks || [])
            expected.set(block.stepIndex, block.text.length);
        }
      });
      new MutationObserver(measure).observe(document.getElementById("root"), {
        subtree: true,
        childList: true,
        characterData: true,
      });
    }, clockCalibration.offsetMs);
    const historyReadyStart = performance.now();
    await page.addScriptTag({ path: path.join(root, "media/chat.js") });
    if (historicalSessions) {
      await page.waitForFunction(count => document.querySelectorAll("#session-select option").length >= Math.min(count + 1, 200), historicalSessions);
      historyOptionsReadyMs = performance.now() - historyReadyStart;
    }
    await page.locator("#message-input").fill("hang");
    await page.locator("#send-btn").click();
    await page.locator(".assistant").waitFor();
    await page.waitForFunction(() =>
      document.querySelector(".assistant")?.textContent.includes("child:"),
    );
    ownedGroups.add(controller.current().processManager.processPid);
    const mainId = controller.currentSessionMeta.id;
    const background = [];
    for (let i = 0; i < backgroundCount; i++) {
      await controller.newSession();
      await controller.sendMessage("hang");
      background.push(controller.current());ownedGroups.add(controller.current().processManager.processPid);
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
          subagents: Array.from({ length: agentCount }, (_, i) => ({
            conversation_id: "benchmark-child-" + i,
            role: "Worker " + i,
          })),
        },
      },
      main.processManager.currentGeneration,
      performance.timeOrigin + performance.now(),
    );
    await page.locator("#agents-btn").click();
    await page.waitForSelector(".agent-card");
    const manager = main.processManager,
      generation = manager.currentGeneration;
    for (let i = 0; i < toolCount; i++)
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
            output: "o".repeat(initialToolOutputBytes),
          },
        },
        generation,
        performance.timeOrigin + performance.now(),
      );
    manager.emit(
      "step_update",
      {
        step_index: 2,
        step_type: "agent_response",
        state: "ACTIVE",
        text_delta: initialText,
      },
      generation,
      performance.timeOrigin + performance.now(),
    );
    await page.waitForFunction(
      ({length, count}) =>
        !!document.querySelector(`[data-virtual-kind="tool"][data-virtual-total="${count}"]`) &&
        Array.from(document.querySelectorAll('.stream-text[data-step-index="2"]')).some(node => node.textContent.length === length),
      {length: initialText.length, count: toolCount},
    );
    await page.evaluate(() => (window.delays = []));
    const sustainedStart = performance.now();
    const inputProbe = (async () => {
      for (let i = 0; i < 100; i++) {
        await page.waitForTimeout(200);
        const started = performance.now();
        const text = "输入探测 " + i;
        await page.locator("#message-input").fill(text);
        await page.waitForFunction(
          (text) => document.querySelector("#message-input")?.value === text,
          text,
        );
        inputLatencies.push(performance.now() - started);
      }
    })();
    for (let i = 0; i < deltas; i++) {
      for (const r of background)
        r.processManager.emit(
          "step_update",
          {
            step_index: 2,
            step_type: "agent_response",
            state: "ACTIVE",
            text_delta: "b".repeat(128),
          },
          r.processManager.currentGeneration,
          performance.timeOrigin + performance.now(),
        );
      manager.emit(
        "step_update",
        {
          step_index: 2,
          step_type: "agent_response",
          state: "ACTIVE",
          text_delta: deltaText,
        },
        generation,
        performance.timeOrigin + performance.now(),
      );
      if (toolStream)
        for (let j = 0; j < 20; j++)
          manager.emit(
            "step_update",
            {
              step_index: 10 + ((i * 20 + j) % toolCount),
              step_type: "tool",
              tool_name: "tool-stream",
              state: i % 2 ? "DONE" : "ACTIVE",
              tool_info: { output: "tool output version " + i },
            },
            generation,
            performance.timeOrigin + performance.now(),
          );
      await page.waitForTimeout(intervalMs);
    }
    await inputProbe;
    await page.waitForFunction(
      (n) =>
        Array.from(document.querySelectorAll(".stream-text")).some(
          (node) => node.textContent.length === n,
        ),
      initialText.length + deltas * deltaText.length,
    );
    const sustainedMs = performance.now() - sustainedStart;
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
      performance.timeOrigin + performance.now(),
    );
    await page.waitForTimeout(80);
    assert.equal(
      await page.locator(".messages").evaluate((e) => e.scrollTop),
      top,
    );
    const latencies = await page.evaluate(() => window.delays);
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
    let completionTrace;
    const traceEvents = [];
    if (process.env.AGY_SUSTAINED_TRACE) {
      completionTrace = await page.context().newCDPSession(page);
      completionTrace.on("Tracing.dataCollected", event => traceEvents.push(...event.value));
      if (process.env.AGY_TRACE_PROFILE === "1") {
        await completionTrace.send("Profiler.enable");
        await completionTrace.send("Profiler.start");
      }
      await completionTrace.send("Tracing.start", {
        categories: "toplevel,devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack",
        transferMode: "ReportEvents",
      });
    }
    await page.evaluate(() => {
      performance.mark("agy-completion-window-start");
      window.completionTasks = [];
      window.completionObserver = new PerformanceObserver(list => window.completionTasks.push(...list.getEntries().map(entry => ({startTime: entry.startTime, duration: entry.duration}))));
      window.completionObserver.observe({type: "longtask"});
    });
    await page.evaluate(() => {
      document.getElementById("stop-btn")?.addEventListener("click", () => {
        window.stopClickedAt = performance.timeOrigin + performance.now();
      }, {once: true, capture: true});
    });
    const mainGroup = manager.processPid;
    let groupExitObservedAt, terminalCommitObservedAt;
    const onTerminalCommit = event => {
      if (event.sessionId === mainId && event.status === (complete ? "completed" : "aborted"))
        terminalCommitObservedAt = performance.timeOrigin + performance.now();
    };
    repo.on("messageCommitted", onTerminalCommit);
    const started = performance.timeOrigin + performance.now();
    const exitObservation = complete ? undefined : (async () => {
      const {processGroupExited} = require("../out/core/processGroup");
      while (!await processGroupExited(mainGroup)) {
        if (performance.timeOrigin + performance.now() - started > 15000)
          throw new Error("Stopped own CLI/tool group did not exit within 15 seconds");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      groupExitObservedAt = performance.timeOrigin + performance.now();
    })();
    // Keep an early observation failure handled until the awaited assertion below.
    exitObservation?.catch(() => {});
    if (complete) {
      if (contentKind === "code")
        manager.emit("step_update", {step_index: 2, step_type: "agent_response", state: "DONE", text_delta: "\n```"}, generation, performance.timeOrigin + performance.now());
      manager.emit("result", {status: "SUCCESS", duration_seconds: sustainedMs / 1000}, generation, performance.timeOrigin + performance.now());
    } else await page.locator("#stop-btn").click();
    if (process.env.AGY_ACK_LEGACY !== "1")
      await page.waitForFunction(() => {
        const button = document.getElementById("send-btn");
        return button && button.getClientRects().length > 0;
      });
    else await page.waitForSelector("#send-btn");
    const buttonRecoveredAt = performance.timeOrigin + performance.now();
    const stopMs = buttonRecoveredAt - started;
    await exitObservation;
    const browserStopClickedAt = await page.evaluate(() => window.stopClickedAt);
    const calibratedStopClickAt = browserStopClickedAt === undefined ? undefined : browserStopClickedAt + clockCalibration.offsetMs;
    await page.waitForTimeout(200);
    const completionTasks = await page.evaluate(() => window.completionTasks);
    if (completionTrace) {
      const profile = process.env.AGY_TRACE_PROFILE === "1" ? (await completionTrace.send("Profiler.stop")).profile : undefined;
      const completed = new Promise(resolve => completionTrace.once("Tracing.tracingComplete", resolve));
      await completionTrace.send("Tracing.end");
      await completed;
      fs.writeFileSync(process.env.AGY_SUSTAINED_TRACE, JSON.stringify({traceEvents, profile}));
      await completionTrace.detach();
    }

    const finalContent = await page.locator('.assistant .markdown[data-step-index="2"]').textContent();
    if (richMarkdown) {
      for (let i = 0; i < richSections; i++)
        for (const marker of ["Section " + i, "List " + i, "Quote " + i, "code-" + i])
          assert(finalContent.includes(marker), "all rich Markdown sections retained");
      assert.equal(await page.locator('.assistant .markdown[data-step-index="2"] h2').count(), richSections);
      assert.equal(await page.locator('.assistant .markdown[data-step-index="2"] pre > code').count(), richSections);
      assert.equal(await page.locator('.assistant .markdown[data-step-index="2"] a').count(), richSections);
      assert.equal(main.currentSessionMeta.messages.find(message => message.role === "assistant").blocks.find(block => block.stepIndex === 2).text, initialText + deltaText.repeat(deltas) + "z", "complete rich source preserved in execution history");
    } else assert(finalContent.includes("x".repeat(initialCharacters)), "complete initial text is retained");
    assert(finalContent.includes(deltaText.repeat(deltas)), "all streamed text is retained");
    if (contentKind === "markdown") {
      assert.deepEqual(await page.locator('.assistant .markdown[data-step-index="2"] strong').allTextContents(),
        Array(richMarkdown ? richSections : 1).fill("Heading"), "every strong heading is retained");
      assert(await page.locator('.assistant .markdown[data-step-index="2"] a').count() >= 1, "file link survives long paragraph segmentation");
    }
    const selectionPreserved = await page.locator('.assistant .markdown[data-step-index="2"]').evaluate((element, rich) => {
      const target = rich ? element : element.querySelector("code") || element.querySelector("p") || element;
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const copied = selection.toString();
      // Compare to native selection on the same unsegmented markup. Chromium
      // omits a trailing code newline even without our segments.
      const reference = target.cloneNode(rich);
      if (rich) for (const segment of reference.querySelectorAll(".text-segment"))
        segment.replaceWith(document.createTextNode(segment.textContent));
      else reference.textContent = target.textContent;
      const wrapper = document.createElement("div");
      wrapper.className = "markdown";
      if (target.tagName === "CODE") {
        const pre = document.createElement("pre");
        pre.appendChild(reference);
        wrapper.appendChild(pre);
      } else wrapper.appendChild(reference);
      document.body.appendChild(wrapper);
      selection.removeAllRanges();
      range.selectNodeContents(reference);
      selection.addRange(range);
      const original = selection.toString();
      selection.removeAllRanges();
      wrapper.remove();
      return copied === original;
    }, richMarkdown);
    await repo.flush();
    const flushCompletedAt = performance.timeOrigin + performance.now();
    repo.off("messageCommitted", onTerminalCommit);
    assert(terminalCommitObservedAt !== undefined, "terminal assistant message committed");
    const stopMeasurements = complete ? undefined : {
      clickToStoppingEstimateMs: stopStateObservedAt === undefined ? undefined : stopStateObservedAt - calibratedStopClickAt,
      clickToGroupExitObservedEstimateMs: groupExitObservedAt - calibratedStopClickAt,
      stoppingToGroupExitObservedMs: groupExitObservedAt - stopStateObservedAt,
      clickToTerminalCommitEstimateMs: terminalCommitObservedAt - calibratedStopClickAt,
      terminalCommitToButtonRecoveredMs: buttonRecoveredAt - terminalCommitObservedAt,
      clickToButtonRecoveredEstimateMs: buttonRecoveredAt - calibratedStopClickAt,
      clickToFlushBarrierUpperBoundMs: flushCompletedAt - calibratedStopClickAt,
      clockUncertaintyMs: clockCalibration.uncertaintyMs,
      groupPollIntervalMs: 5,
      mainGroup,
      note: "Click/Host estimates use transport calibration; group exit is observed, not exact. Terminal commit follows successful message+metadata atomic writes, not fsync. Signed commit-to-button ordering can show input recovery before disk commit. Flush is a late persistence barrier upper bound. Completion leaves idle CLI alive until teardown."
    };
    const completionMeasurements = complete ? {terminalCommitAfterTriggerMs: terminalCommitObservedAt - started,
      buttonRecoveredAfterTriggerMs: buttonRecoveredAt - started,
      terminalCommitToButtonRecoveredMs: buttonRecoveredAt - terminalCommitObservedAt,
      note: "Commit observation follows successful message+metadata atomic writes; signed ordering may show button recovery before persistence. No fsync/crash durability guarantee."} : undefined;
    const hostAfter = process.memoryUsage();
    const queueAfter = repo.writeQueueStats, cachesAfter = repo.cacheStats;
    const hostCpuAfter = process.cpuUsage(hostBefore.cpu);
    const hostElapsedAfter = performance.now() - hostBefore.at;
    let resourceDiagnostics;
    if (resourceProbe) {
      clearInterval(resourceTimer);
      const cdp = await page.context().newCDPSession(page);
      const webviewBeforeGC = await cdp.send("Runtime.getHeapUsage");
      const hostAfterGC = await collectHost();
      await cdp.send("HeapProfiler.collectGarbage");
      const webviewAfterGC = await cdp.send("Runtime.getHeapUsage");
      // Own completed test session only; active background tasks remain until
      // the explicit test teardown. No user windows/records are touched.
      await repo.releaseTranscript(mainId, () => !main.processing);
      const hostAfterTranscriptReleaseGC = await collectHost();
      await controller.dispose();
      for (const session of repo.getAllSessions())
        await repo.releaseTranscript(session.id, () => true);
      const hostAfterTeardownGC = await collectHost();
      resourceDiagnostics = {samplingIntervalMs: 500, samples: resourceSamples,
        hostAfterGC, hostAfterTranscriptReleaseGC, hostAfterTeardownGC,
        webviewBeforeGC, webviewAfterGC, cachesAfterRelease: repo.cacheStats,
        note: "GC is forced only after latency/input/completion assertions, for diagnostics; no production GC policy"};
      await cdp.detach();
    }
    const clockCalibrationAfter = await calibrateClock();
    const clockDriftMs = clockCalibrationAfter.offsetMs - clockCalibration.offsetMs;
    const report = {
      clockCalibration, clockCalibrationAfter, clockDriftMs,
      historicalSessions, historyOptionsReadyMs, messageCounts,
      historyFixture: "in-memory metadata index; bounded recent list + native picker; disk initialization measured separately",
      backgroundConversations: backgroundCount,
      agentCards: agentCount,
      providerPipeline,
      requestBoundaries: controller.diagnosticsSnapshot().events.filter(event => event.milestone === "request-boundary"),
      renderDelivery: provider?.renderTelemetry.stats(),
      environment: providerPipeline
        ? "headless Chromium; actual React + Provider + Service + Controller + POSIX fake CLI; VS Code API mock"
        : "headless Chromium; actual React + Bridge + Controller + POSIX fake CLI",
      fixtureConfiguration: {model: env.config().defaultModel, effort: env.config().reasoningEffort, permissions: "Safe", modelRequests: 0},
      stopMeasurements, completionMeasurements,
      richMarkdown, richSections: richMarkdown ? richSections : undefined,
      textCharacters: initialText.length + deltas * deltaText.length + 1,
      contentKind,
      termination: complete ? "completed" : "aborted",
      completionTasks,
      completionLongTaskMaxMs: Math.max(0, ...completionTasks.map(task => task.duration)),
      selectionPreserved,
      emittedDeltas: deltas,
      continuousToolUpdates: toolStream ? deltas * 20 : 0,
      deltaCharacters: deltaText.length,
      intervalMs,
      sustainedMs,
      measurement:
        "confirmed streamed block length, then requestAnimationFrame; calibrated Host/browser monotonic epoch clocks",
      inputSamples: inputLatencies.length,
      inputP95Ms: [...inputLatencies].sort((a, b) => a - b)[
        Math.ceil(inputLatencies.length * 0.95) - 1
      ],
      inputLatencies,
      host: {
        before: hostBefore.memory,
        after: hostAfter,
        cpuMicroseconds: hostCpuAfter,
        elapsedMs: hostElapsedAfter,
      },
      resourceDiagnostics,
      toolCards: toolCount,
      mountedToolCards: await page.locator(".tool").count(),
      writeQueue: queueAfter,
      caches: cachesAfter,
      toolOutputBytes: initialToolOutputBytes * toolCount,
      samples: latencies.length,
      latencies,
      p95Ms: p95,
      stopMs,
      buttonRecoveryMeasurement: process.env.AGY_ACK_LEGACY !== "1" ? "direct DOM ID + nonempty client rect; RAF polling" : "Playwright waitForSelector",
      scrollPreserved: true,
      inputResponsive: true,
      errors,
    };
    fs.writeFileSync(
      path.resolve(
        root,
        process.env.AGY_BENCHMARK_OUTPUT ||
          "diagnostics/optimization-sustained.json",
      ),
      JSON.stringify(report, null, 2),
    );
    console.log(report);
    assert.ok(latencies.length >= 1000, "at least 1000 visible batches");
    assert.ok(latencies.every(value => Number.isFinite(value) && value >= 0), "latencies must be finite and nonnegative");
    assert.ok(Math.abs(clockDriftMs) <= 5, "monotonic clock calibration drift <=5ms");
    assert.ok(p95 <= 100, "P95 <=100ms");
    assert(selectionPreserved, "text selection matches native unsegmented content");
    assert.ok(report.inputP95Ms <= 50, "input P95 <=50ms");
    assert.ok(report.completionLongTaskMaxMs <= 100, "completion long tasks <=100ms");
    assert.equal(errors.length, 0);
  } finally {
    clearInterval(resourceTimer);
    clearTimeout(timer);
    disposeView?.();provider?.dispose();
    await controller.dispose();
    for (const group of ownedGroups) if (group) assert.equal(await require("../out/core/processGroup").processGroupExited(group), true, "own CLI/tool group exited");
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
