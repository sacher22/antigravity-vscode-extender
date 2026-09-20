(function () {
  const vscode = acquireVsCodeApi();

  const messagesContainer = document.getElementById("messages");
  const chatInput = document.getElementById("chat-input");
  const sendBtn = document.getElementById("send-btn");
  const stopBtn = document.getElementById("stop-btn");
  const newChatBtn = document.getElementById("new-chat-btn");
  const sessionSelect = document.getElementById("session-select");
  const modelSelect = document.getElementById("model-select");
  const effortSelect = document.getElementById("effort-select");
  const permToggleBtn = document.getElementById("perm-toggle-btn");
  const contextPreview = document.getElementById("context-preview");
  const contextText = document.getElementById("context-text");
  const removeContextBtn = document.getElementById("remove-context-btn");
  const statusInfo = document.getElementById("status-info");
  const chipAttachFile = document.getElementById("chip-attach-file");
  const chipProblems = document.getElementById("chip-problems");
  const planModePill = document.getElementById("plan-mode-pill");
  const closePlanModeBtn = document.getElementById("close-plan-mode-btn");
  const MODEL_EFFORTS = {
    "gemini-3.8-flash-high": ["low", "medium", "high"],
    "gemini-3.7-flash-high": ["medium", "high"],
    "gemini-3.1-pro-high": ["high"]
  };

  let currentContext = null;
  let isGenerating = false;
  let activeAssistantTurn = null;
  let activeTextBlocks = {};
  let activeToolCards = {};
  let currentRawText = "";
  let isDangerMode = true;
  let autoScrollEnabled = true;
  let streamFlushTimer = null;
  let turnStatusTimer = null;
  let turnStartedAt = 0;
  let loadedSessionMessages = [];
  let historyLimit = 30;
  let firstRenderReported = false;
  let isRenderingHistory = false;

  // Configure marked safely
  if (typeof marked !== "undefined" && marked.setOptions) {
    try {
      marked.setOptions({
        breaks: true,
        gfm: true
      });
    } catch (e) {
      console.warn("marked setOptions error", e);
    }
  }

  function renderMarkdown(md) {
    if (window.marked) {
      try {
        const rawHtml = marked.parse(md);
        return decorateFileReferences(wrapCodeBlocks(sanitizeHtml(rawHtml)));
      } catch (e) {
        return escapeHtml(md);
      }
    }
    return escapeHtml(md);
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function sanitizeHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    template.content.querySelectorAll("script,style,iframe,object,embed,link,meta,form").forEach((el) => el.remove());
    template.content.querySelectorAll("*").forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith("on") || ((name === "href" || name === "src") && value.startsWith("javascript:"))) {
          el.removeAttribute(attr.name);
        }
      });
    });
    return template.innerHTML;
  }

  function isOpenableReference(value) {
    if (!value) return false;
    return /^(?:https?:\/\/|file:\/\/|\/|~\/|\.\.?\/)/i.test(value) ||
      /^[^?#]+\.(?:html?|svg|css|[cm]?[jt]sx?|json|md|py|java|go|rs|c|cc|cpp|h|hpp|sh|ya?ml|toml|txt)(?:(?:#L|:)\d+(?::\d+)?)?$/i.test(value);
  }

  function decorateFileReferences(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    template.content.querySelectorAll("a").forEach((anchor) => {
      const href = anchor.getAttribute("href") || "";
      if (isOpenableReference(href)) {
        anchor.classList.add("resource-link");
        anchor.title = "Open in VS Code";
      }
    });
    template.content.querySelectorAll("code").forEach((code) => {
      if (code.closest("pre") || code.closest("a")) return;
      const value = code.textContent?.trim() || "";
      if (!isOpenableReference(value)) return;
      const anchor = document.createElement("a");
      anchor.className = "resource-link";
      anchor.dataset.resourceHref = value;
      anchor.title = "Open in VS Code";
      code.replaceWith(anchor);
      anchor.appendChild(code);
    });
    const textNodes = [];
    const collectTextNodes = (node) => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE && !child.parentElement?.closest("a,code,pre")) {
          textNodes.push(child);
        } else if (child.nodeType === Node.ELEMENT_NODE && !child.closest("a,code,pre")) {
          collectTextNodes(child);
        }
      });
    };
    collectTextNodes(template.content);
    const filePattern = /((?:file:\/\/\/|~\/|\.{1,2}\/|\/)?(?:[\w.@-]+\/)*[\w.@-]+\.(?:html?|svg|css|[cm]?[jt]sx?|json|md|py|java|go|rs|c|cc|cpp|h|hpp|sh|ya?ml|toml|txt)(?:(?:#L|:)\d+(?::\d+)?)?)/gi;
    textNodes.forEach((textNode) => {
      const text = textNode.textContent || "";
      const matches = Array.from(text.matchAll(filePattern));
      if (!matches.length) return;
      const fragment = document.createDocumentFragment();
      let offset = 0;
      matches.forEach((match) => {
        const index = match.index || 0;
        fragment.appendChild(document.createTextNode(text.slice(offset, index)));
        const anchor = document.createElement("a");
        anchor.className = "resource-link";
        anchor.dataset.resourceHref = match[0];
        anchor.title = "Open in VS Code";
        anchor.textContent = match[0];
        fragment.appendChild(anchor);
        offset = index + match[0].length;
      });
      fragment.appendChild(document.createTextNode(text.slice(offset)));
      textNode.replaceWith(fragment);
    });
    return template.innerHTML;
  }

  function wrapCodeBlocks(html) {
    const div = document.createElement("div");
    div.innerHTML = html;

    const preElements = div.querySelectorAll("pre");
    preElements.forEach((pre) => {
      const code = pre.querySelector("code");
      let lang = "";
      if (code) {
        const classes = code.className.split(" ");
        for (const c of classes) {
          if (c.startsWith("language-")) {
            lang = c.replace("language-", "");
            break;
          }
        }
      }

      const wrapper = document.createElement("div");
      wrapper.className = "code-block-wrapper";

      const header = document.createElement("div");
      header.className = "code-block-header";
      header.innerHTML = `<span>${lang || "code"}</span>
        <div class="code-block-actions">
          <button class="code-action-btn diff-btn" title="View Diff against active file">Diff</button>
          <button class="code-action-btn copy-btn" title="Copy code">Copy</button>
          <button class="code-action-btn insert-btn" title="Insert or Apply to editor">Apply</button>
        </div>`;

      wrapper.appendChild(header);
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);

    });

    return div.innerHTML;
  }

  function isNearBottom() {
    return messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 80;
  }

  function scrollToBottom(force) {
    if (isRenderingHistory) return;
    if (force || (autoScrollEnabled && isNearBottom())) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  function appendUserMessage(text) {
    const msg = document.createElement("div");
    msg.className = "message user";

    const role = document.createElement("div");
    role.className = "message-role";
    role.textContent = "You";

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.innerHTML = renderMarkdown(text);

    msg.appendChild(role);
    msg.appendChild(bubble);
    messagesContainer.appendChild(msg);
    scrollToBottom(true);
  }

  function prepareAssistantMessage(showThinking = true) {
    const msg = document.createElement("div");
    msg.className = "message assistant";

    const role = document.createElement("div");
    role.className = "message-role";
    role.textContent = "Antigravity";

    const turn = document.createElement("div");
    turn.className = "assistant-turn";
    if (showThinking) {
      const thinking = document.createElement("div");
      thinking.className = "thinking-placeholder";
      thinking.textContent = "Waiting for Antigravity...";
      turn.appendChild(thinking);
    }

    msg.appendChild(role);
    msg.appendChild(turn);
    messagesContainer.appendChild(msg);

    activeAssistantTurn = turn;
    activeTextBlocks = {};
    firstRenderReported = false;
    currentRawText = "";
    activeToolCards = {};
    scrollToBottom();
    return turn;
  }

  function removeThinkingPlaceholder() {
    activeAssistantTurn?.querySelector(".thinking-placeholder")?.remove();
  }

  function ensureTextBlock(stepIndex) {
    if (!activeAssistantTurn) {
      prepareAssistantMessage();
    }
    removeThinkingPlaceholder();
    const key = String(stepIndex ?? 0);
    if (!activeTextBlocks[key]) {
      const bubble = document.createElement("div");
      bubble.className = "message-bubble assistant-text-block";
      const stable = document.createElement("div");
      const tail = document.createElement("div");
      tail.className = "stream-tail";
      bubble.appendChild(stable);
      bubble.appendChild(tail);
      activeAssistantTurn.appendChild(bubble);
      activeTextBlocks[key] = { element: bubble, stable, tail, raw: "", committed: 0 };
    }
    return activeTextBlocks[key];
  }

  function updateAssistantText(delta, stepIndex) {
    const block = ensureTextBlock(stepIndex);
    currentRawText += delta;
    block.raw += delta;
    if (!streamFlushTimer) {
      streamFlushTimer = setTimeout(() => flushAssistantText(false), 50);
    }
  }

  function findStableBoundary(text) {
    let boundary = -1;
    let candidate = text.indexOf("\n\n");
    while (candidate !== -1) {
      const prefix = text.slice(0, candidate + 2);
      const fenceCount = (prefix.match(/```/g) || []).length;
      if (fenceCount % 2 === 0) boundary = candidate + 2;
      candidate = text.indexOf("\n\n", candidate + 2);
    }
    return boundary;
  }

  function renderSessionHistory() {
    isRenderingHistory = true;
    messagesContainer.innerHTML = "";
    activeAssistantTurn = null;
    activeTextBlocks = {};
    activeToolCards = {};
    currentRawText = "";

    const visible = loadedSessionMessages.slice(-historyLimit);
    if (visible.length < loadedSessionMessages.length) {
      const loadButton = document.createElement("button");
      loadButton.className = "load-history-btn";
      loadButton.textContent = `Load earlier messages (${loadedSessionMessages.length - visible.length})`;
      loadButton.addEventListener("click", () => {
        const oldHeight = messagesContainer.scrollHeight;
        historyLimit += 30;
        renderSessionHistory();
        messagesContainer.scrollTop = messagesContainer.scrollHeight - oldHeight;
      });
      messagesContainer.appendChild(loadButton);
    }

    visible.forEach((message, index) => {
      const textContent = message.content || message.text || "";
      if (message.role === "user") {
        appendUserMessage(textContent);
      } else if (message.role === "assistant") {
        prepareAssistantMessage(false);
        if (textContent) updateAssistantText(textContent, -1);
        flushAssistantText(true);
        (message.toolCalls || []).forEach((tool) => {
          updateToolCard(tool.stepIndex, tool.name, tool.state, {
            parameters: tool.parameters,
            output: tool.output
          });
        });
        if (message.status === "awaiting_input" && index === visible.length - 1) {
          appendAwaitingInputActions(message.pendingInputKind || "question");
        }
      }
    });
    isRenderingHistory = false;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function flushAssistantText(final) {
    if (streamFlushTimer) clearTimeout(streamFlushTimer);
    streamFlushTimer = null;
    const follow = isNearBottom();
    Object.values(activeTextBlocks).forEach((block) => {
      if (final) {
        block.element.innerHTML = renderMarkdown(block.raw);
        return;
      }
      const pending = block.raw.slice(block.committed);
      const boundary = findStableBoundary(pending);
      if (boundary > 0) {
        block.stable.insertAdjacentHTML("beforeend", renderMarkdown(pending.slice(0, boundary)));
        block.committed += boundary;
      }
      block.tail.innerHTML = renderMarkdown(block.raw.slice(block.committed));
    });
    if (follow) scrollToBottom(true);
    if (!isRenderingHistory && !firstRenderReported && currentRawText) {
      firstRenderReported = true;
      vscode.postMessage({ command: "reportRender", kind: "firstText", clientRenderedAt: Date.now() });
    }
  }

  function toolSummary(toolName, toolInfo) {
    const params = toolInfo?.parameters || {};
    const command = params.CommandLine || params.command || params.cmd;
    const file = params.TargetFile || params.file_path || params.path;
    if (command) return String(command).split("\n")[0];
    if (file) return String(file).replace(/^.*[\\/]/, "");
    return String(toolName || "Tool").replace(/_/g, " ");
  }

  function toolFileReference(toolInfo) {
    const params = toolInfo?.parameters || {};
    return params.TargetFile || params.file_path || params.path || "";
  }

  function previewToolContent(data) {
    let content = "";
    if (data.parameters) content += `Params:\n${JSON.stringify(data.parameters, null, 2)}\n\n`;
    if (data.output) content += `Output:\n${data.output}`;
    const lines = content.split("\n");
    if (lines.length > 200) content = lines.slice(0, 200).join("\n") + `\n\n... ${lines.length - 200} more lines`;
    if (content.length > 32768) content = content.slice(0, 32768) + "\n\n... output truncated in preview";
    return content;
  }

  function updateToolCard(stepIndex, toolName, state, toolInfo) {
    if (!activeAssistantTurn) {
      prepareAssistantMessage();
    }
    removeThinkingPlaceholder();

    let entry = activeToolCards[stepIndex];
    if (!entry) {
      const card = document.createElement("div");
      card.className = "tool-card";

      const header = document.createElement("div");
      header.className = "tool-card-header";
      header.setAttribute("role", "button");
      header.setAttribute("tabindex", "0");

      const info = document.createElement("div");
      info.className = "tool-info-left";

      const spinner = document.createElement("div");
      spinner.className = "tool-spinner";
      info.appendChild(spinner);

      const name = document.createElement("a");
      name.className = "tool-summary";
      name.textContent = toolSummary(toolName, toolInfo);
      name.addEventListener("click", (event) => {
        const href = name.dataset.resourceHref;
        if (!href) return;
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({ command: "openResource", href });
      });
      info.appendChild(name);

      const statusBadge = document.createElement("span");
      statusBadge.className = "tool-badge running";
      statusBadge.textContent = "Running";

      const chevron = document.createElement("span");
      chevron.className = "tool-chevron";
      chevron.textContent = "›";

      header.appendChild(info);
      header.appendChild(statusBadge);
      header.appendChild(chevron);
      card.appendChild(header);
      activeAssistantTurn.appendChild(card);
      entry = { card, data: { parameters: null, output: "" }, expanded: false, userToggled: false };
      activeToolCards[stepIndex] = entry;

      const toggle = () => {
        entry.userToggled = true;
        setToolExpanded(entry, !entry.expanded);
      };
      header.addEventListener("click", toggle);
      header.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); }
      });
    }

    const card = entry.card;
    const spinner = card.querySelector(".tool-spinner");
    const statusBadge = card.querySelector(".tool-badge");
    const summary = card.querySelector(".tool-summary");
    if (toolInfo?.parameters) entry.data.parameters = toolInfo.parameters;
    if (toolInfo?.output !== undefined) entry.data.output = toolInfo.output;
    if (summary) summary.textContent = toolSummary(toolName, {
      ...toolInfo,
      parameters: toolInfo?.parameters || entry.data.parameters
    });
    const fileReference = toolFileReference({ parameters: toolInfo?.parameters || entry.data.parameters });
    if (summary) {
      summary.classList.toggle("resource-link", Boolean(fileReference));
      if (fileReference) summary.dataset.resourceHref = fileReference;
      else delete summary.dataset.resourceHref;
    }

    if (state === "DONE") {
      if (spinner) spinner.style.display = "none";
      if (statusBadge) {
        statusBadge.textContent = "Done";
        statusBadge.className = "tool-badge done";
      }
    } else if (state === "FAILED") {
      if (spinner) spinner.style.display = "none";
      if (statusBadge) {
        statusBadge.textContent = "Failed";
        statusBadge.className = "tool-badge failed";
      }
      if (!entry.userToggled) setToolExpanded(entry, true);
    }

    if (entry.expanded) {
      const output = card.querySelector(".tool-output");
      if (output) output.textContent = previewToolContent(entry.data);
    }
    scrollToBottom();
  }

  function setToolExpanded(entry, expanded) {
    entry.expanded = expanded;
    entry.card.classList.toggle("expanded", expanded);
    const chevron = entry.card.querySelector(".tool-chevron");
    if (chevron) chevron.textContent = expanded ? "⌄" : "›";
    let body = entry.card.querySelector(".tool-card-body");
    if (expanded && !body) {
      body = document.createElement("div");
      body.className = "tool-card-body";
      const output = document.createElement("pre");
      output.className = "tool-output";
      output.textContent = previewToolContent(entry.data);
      body.appendChild(output);
      entry.card.appendChild(body);
    } else if (!expanded && body) {
      body.remove();
    }
  }

  function appendAwaitingInputActions(kind) {
    if (!activeAssistantTurn || activeAssistantTurn.querySelector(".confirmation-actions")) return;
    const actions = document.createElement("div");
    actions.className = "confirmation-actions";
    if (kind === "confirmation") {
      const execute = document.createElement("button");
      execute.className = "confirmation-primary";
      execute.textContent = "执行";
      execute.addEventListener("click", () => {
        chatInput.value = "执行";
        handleSend();
      });
      const revise = document.createElement("button");
      revise.textContent = "修改计划";
      revise.addEventListener("click", () => chatInput.focus());
      actions.appendChild(execute);
      actions.appendChild(revise);
    } else {
      const answer = document.createElement("button");
      answer.className = "confirmation-primary";
      answer.textContent = "回答问题";
      answer.addEventListener("click", () => chatInput.focus());
      actions.appendChild(answer);
    }
    activeAssistantTurn.appendChild(actions);
  }

  function updatePermissionUI(danger) {
    isDangerMode = danger;
    if (danger) {
      permToggleBtn.className = "perm-badge danger-mode";
      permToggleBtn.innerHTML = `<span class="perm-icon">⚡</span><span class="perm-text">Danger</span>`;
      permToggleBtn.title = "Permission Mode: Danger (Auto-runs tools without approval). Click to switch to Safe mode.";
    } else {
      permToggleBtn.className = "perm-badge safe-mode";
      permToggleBtn.innerHTML = `<span class="perm-icon">🛡️</span><span class="perm-text">Safe</span>`;
      permToggleBtn.title = "Permission Mode: Safe (Tool approval required). Click to switch to Danger mode.";
    }
  }

  function syncEffortOptions() {
    const supported = MODEL_EFFORTS[modelSelect.value] || ["high"];
    Array.from(effortSelect.options).forEach((option) => {
      option.disabled = !supported.includes(option.value);
    });
    if (!supported.includes(effortSelect.value)) effortSelect.value = supported[supported.length - 1];
  }

  function setGenerating(generating) {
    isGenerating = generating;
    modelSelect.disabled = generating;
    effortSelect.disabled = generating;
    permToggleBtn.disabled = generating;
    newChatBtn.disabled = generating;
    sessionSelect.disabled = generating;
    if (generating) {
      sendBtn.style.display = "none";
      stopBtn.style.display = "inline-flex";
      stopBtn.disabled = false;
      stopBtn.textContent = "Stop";
      if (!turnStartedAt) turnStartedAt = Date.now();
      statusInfo.textContent = "Sending...";
      startStatusClock();
    } else {
      sendBtn.style.display = "inline-flex";
      stopBtn.style.display = "none";
      turnStartedAt = 0;
      if (turnStatusTimer) clearInterval(turnStatusTimer);
      turnStatusTimer = null;
      if (!statusInfo.textContent.startsWith("Tokens:")) statusInfo.textContent = "Ready";
    }
  }

  function startStatusClock() {
    if (turnStatusTimer) return;
    turnStatusTimer = setInterval(() => {
      if (!isGenerating || !turnStartedAt) return;
      const seconds = Math.floor((Date.now() - turnStartedAt) / 1000);
      const base = statusInfo.dataset.phase || "Working";
      statusInfo.textContent = `${base} · ${seconds}s`;
    }, 1000);
  }

  function updateTurnState(state) {
    const labels = {
      connecting: "Connecting",
      submitted: "Waiting for model",
      waiting: "Still waiting",
      responding: "Responding",
      tool: state.detail ? `Running ${state.detail}` : "Running tool",
      awaiting_input: "Waiting for your response",
      stopping: "Stopping",
      completed: "Ready",
      failed: "Failed",
      aborted: "Stopped"
    };
    statusInfo.dataset.phase = labels[state.phase] || "Working";
    if (state.startedAt) turnStartedAt = state.startedAt;
    statusInfo.textContent = statusInfo.dataset.phase;
    if (state.phase === "stopping") {
      stopBtn.disabled = true;
      stopBtn.textContent = "Stopping...";
    }
  }

  function handleSend() {
    const text = chatInput.value.trim();
    if (!text || isGenerating) return;

    appendUserMessage(text);
    document.querySelectorAll(".confirmation-actions").forEach((actions) => actions.remove());
    chatInput.value = "";
    chatInput.style.height = "auto";

    let contextPayload = null;
    let filePathPayload = null;
    if (currentContext) {
      contextPayload = currentContext.code;
      filePathPayload = currentContext.file;
      clearContext();
    }

    setGenerating(true);
    prepareAssistantMessage();

    vscode.postMessage({
      command: "sendMessage",
      text: text,
      clientSentAt: Date.now(),
      contextCode: contextPayload,
      filePath: filePathPayload
    });
  }

  function clearContext() {
    currentContext = null;
    contextPreview.style.display = "none";
  }

  // Event listeners
  sendBtn.addEventListener("click", handleSend);

  stopBtn.addEventListener("click", () => {
    vscode.postMessage({ command: "abortCurrentTurn" });
    stopBtn.disabled = true;
    stopBtn.textContent = "Stopping...";
    statusInfo.textContent = "Stopping...";
  });

  document.addEventListener("click", (event) => {
    const anchor = event.target.closest?.("a");
    if (anchor) {
      const href = anchor.dataset.resourceHref || anchor.getAttribute("href") || "";
      if (isOpenableReference(href)) {
        event.preventDefault();
        vscode.postMessage({ command: "openResource", href });
        return;
      }
    }
    const button = event.target.closest?.(".code-action-btn");
    if (!button) return;
    const wrapper = button.closest(".code-block-wrapper");
    const code = wrapper?.querySelector("pre code")?.textContent || wrapper?.querySelector("pre")?.textContent || "";
    if (button.classList.contains("copy-btn")) {
      vscode.postMessage({ command: "copyToClipboard", text: code });
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = "Copy"; }, 1200);
    } else if (button.classList.contains("insert-btn")) {
      vscode.postMessage({ command: "applyCodeToEditor", code });
    } else if (button.classList.contains("diff-btn")) {
      vscode.postMessage({ command: "viewDiff", code });
    }
  });

  permToggleBtn.addEventListener("click", () => {
    const nextMode = !isDangerMode;
    permToggleBtn.disabled = true;
    statusInfo.textContent = "Applying permission mode...";
    vscode.postMessage({ command: "togglePermission", dangerouslySkipPermissions: nextMode });
  });

  const DEFAULT_SLASH_COMMANDS = [
    { command: "/plan", label: "Plan mode", description: "Turn plan mode on (switch execution mode to planning)", icon: "💡", category: "Mode", isMode: true },
    { command: "/status", label: "Status", description: "Show chat ID, context usage, and rate limits", icon: "⏱️", category: "General" },
    { command: "/mcp", label: "MCP", description: "Show MCP server status & connections", icon: "🔌", category: "General" },
    { command: "/help", label: "Help", description: "Show available commands and usage guide", icon: "❓", category: "General" },
    { command: "/clear", label: "Clear", description: "Clear current chat history and reset context", icon: "🧹", category: "General" },
    { command: "/goal", label: "Goal", description: "Set or inspect active task goal", icon: "🎯", category: "General" }
  ];
  let slashCommands = DEFAULT_SLASH_COMMANDS;
  let slashSelectedIndex = 0;
  let isSlashMenuOpen = false;
  let filteredSlashCommands = [];

  const slashMenu = document.getElementById("slash-menu");

  function renderSlashMenu(items) {
    if (!slashMenu) return;
    filteredSlashCommands = items;
    if (!items || items.length === 0) {
      slashMenu.style.display = "none";
      isSlashMenuOpen = false;
      return;
    }

    if (slashSelectedIndex >= items.length) {
      slashSelectedIndex = 0;
    }

    let html = "";
    let currentCategory = "";

    items.forEach((it, idx) => {
      if (it.category && it.category !== currentCategory) {
        currentCategory = it.category;
        html += `<div class="slash-menu-header">${escapeHtml(currentCategory)}</div>`;
      }

      const isSelected = idx === slashSelectedIndex ? "selected" : "";
      const icon = it.icon || (it.category === "Skills" ? "⚡" : "🔹");
      const originTag = it.origin ? `<span class="slash-item-origin">${escapeHtml(it.origin)}</span>` : "";

      html += `
        <div class="slash-item ${isSelected}" data-index="${idx}">
          <div class="slash-item-left">
            <span class="slash-item-icon">${icon}</span>
            <div class="slash-item-text">
              <span class="slash-item-title">${escapeHtml(it.label || it.command)}</span>
              <span class="slash-item-cmd">${escapeHtml(it.command)}</span>
              <span class="slash-item-desc">${escapeHtml(it.description || "")}</span>
            </div>
          </div>
          ${originTag}
        </div>
      `;
    });

    slashMenu.innerHTML = html;
    slashMenu.style.setProperty("display", "flex", "important");
    slashMenu.style.setProperty("visibility", "visible", "important");
    slashMenu.style.setProperty("opacity", "1", "important");
    isSlashMenuOpen = true;

    // bind click
    slashMenu.querySelectorAll(".slash-item").forEach(el => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault(); // prevent losing focus
        const idx = parseInt(el.getAttribute("data-index") || "0", 10);
        selectSlashItem(items[idx]);
      });
    });

    // scroll into view
    const selectedEl = slashMenu.querySelector(".slash-item.selected");
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  }

  function selectSlashItem(item) {
    if (!item) return;
    slashMenu.style.display = "none";
    isSlashMenuOpen = false;

    if (item.command === "/plan") {
      chatInput.value = "";
      statusInfo.textContent = "Enabling Plan mode...";
      vscode.postMessage({ command: "togglePlanMode", isPlanMode: true });
      chatInput.focus();
      return;
    }

    // Replace current slash query with the command
    chatInput.value = item.command + " ";
    chatInput.focus();
  }

  function handleSlashInput() {
    const val = chatInput.value;
    // Check if starts with slash or cursor is at slash
    if (val.startsWith("/")) {
      const query = val.slice(1).toLowerCase().trim();
      if (!slashCommands || slashCommands.length === 0) {
        vscode.postMessage({ command: "getSlashCommands" });
      }
      const filtered = slashCommands.filter(it => 
        it.command.toLowerCase().includes("/" + query) ||
        it.label.toLowerCase().includes(query) ||
        (it.description && it.description.toLowerCase().includes(query))
      );
      renderSlashMenu(filtered);
    } else {
      if (isSlashMenuOpen) {
        slashMenu.style.display = "none";
        isSlashMenuOpen = false;
      }
    }
  }

  chatInput.addEventListener("keydown", (e) => {
    if (isSlashMenuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashSelectedIndex = (slashSelectedIndex + 1) % filteredSlashCommands.length;
        renderSlashMenu(filteredSlashCommands);
        return;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        slashSelectedIndex = (slashSelectedIndex - 1 + filteredSlashCommands.length) % filteredSlashCommands.length;
        renderSlashMenu(filteredSlashCommands);
        return;
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (filteredSlashCommands[slashSelectedIndex]) {
          selectSlashItem(filteredSlashCommands[slashSelectedIndex]);
        }
        return;
      } else if (e.key === "Escape") {
        e.preventDefault();
        slashMenu.style.display = "none";
        isSlashMenuOpen = false;
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  chatInput.addEventListener("input", () => {
    handleSlashInput();
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + "px";
  });

  chatInput.addEventListener("keyup", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "Enter" && e.key !== "Escape") {
      handleSlashInput();
    }
  });

  newChatBtn.addEventListener("click", () => {
    chatInput.value = "";
    chatInput.style.height = "auto";
    clearContext();
    statusInfo.textContent = "Ready";
    vscode.postMessage({ command: "newSession" });
  });

  sessionSelect.addEventListener("change", () => {
    const targetId = sessionSelect.value;
    if (targetId) {
      chatInput.value = "";
      chatInput.style.height = "auto";
      clearContext();
      vscode.postMessage({ command: "switchSession", conversationId: targetId });
    }
  });

  modelSelect.addEventListener("change", () => {
    syncEffortOptions();
    modelSelect.disabled = true;
    effortSelect.disabled = true;
    statusInfo.textContent = "Applying model...";
    vscode.postMessage({
      command: "changeModel",
      model: modelSelect.value,
      effort: effortSelect.value
    });
  });

  effortSelect.addEventListener("change", () => {
    modelSelect.disabled = true;
    effortSelect.disabled = true;
    statusInfo.textContent = "Applying effort...";
    vscode.postMessage({
      command: "changeModel",
      model: modelSelect.value,
      effort: effortSelect.value
    });
  });

  chipAttachFile.addEventListener("click", () => {
    vscode.postMessage({ command: "requestContext", contextType: "file" });
  });

  if (closePlanModeBtn) {
    closePlanModeBtn.addEventListener("click", () => {
      statusInfo.textContent = "Leaving Plan mode...";
      vscode.postMessage({ command: "togglePlanMode", isPlanMode: false });
    });
  }

  chipProblems.addEventListener("click", () => {
    vscode.postMessage({ command: "requestContext", contextType: "problems" });
  });

  removeContextBtn.addEventListener("click", clearContext);

  // Handle incoming messages from Extension
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "initSession": {
        const session = msg.session;
        loadedSessionMessages = session.messages || [];
        historyLimit = 30;

        if (msg.config) {
          updatePermissionUI(msg.config.dangerouslySkipPermissions);
          autoScrollEnabled = msg.config.autoScroll !== false;
        }

        renderSessionHistory();
        if (session.model) {
          modelSelect.value = session.model;
        }
        syncEffortOptions();
        if (session.effort) {
          effortSelect.value = session.effort;
        }
        setGenerating(false);
        break;
      }

      case "permissionChanged": {
        updatePermissionUI(msg.dangerouslySkipPermissions);
        permToggleBtn.disabled = false;
        statusInfo.textContent = "Ready";
        break;
      }

      case "modelChanged": {
        modelSelect.value = msg.model;
        syncEffortOptions();
        effortSelect.value = msg.effort;
        modelSelect.disabled = false;
        effortSelect.disabled = false;
        statusInfo.textContent = "Ready";
        break;
      }

      case "planModeChanged": {
        if (planModePill) planModePill.classList.toggle("hidden", !msg.enabled);
        chatInput.placeholder = msg.enabled
          ? "[Plan Mode] Describe the goal you want to plan..."
          : "Ask Antigravity anything... (Type / for commands & skills)";
        statusInfo.textContent = "Ready";
        break;
      }

      case "sessionList": {
        // Prevent triggering "change" event while updating options
        const currentVal = msg.currentId || sessionSelect.value;
        sessionSelect.innerHTML = "";
        msg.sessions.forEach((s) => {
          const opt = document.createElement("option");
          opt.value = s.id;
          opt.textContent = s.title;
          if (s.id === currentVal) {
            opt.selected = true;
          }
          sessionSelect.appendChild(opt);
        });
        break;
      }

      case "streamDelta": {
        updateAssistantText(msg.delta, msg.stepIndex);
        break;
      }

      case "toolUpdate": {
        updateToolCard(msg.stepIndex, msg.toolName, msg.state, msg.toolInfo);
        break;
      }

      case "turnComplete": {
        if (msg.result && msg.result.response && (!currentRawText || currentRawText.trim() === "")) {
          updateAssistantText(msg.result.response, -1);
        }
        flushAssistantText(true);
        setGenerating(false);
        if (msg.usage || msg.result?.usage) {
          const u = msg.usage || msg.result?.usage;
          statusInfo.textContent = `Tokens: ${u.total_tokens || u.output_tokens} | Duration: ${msg.result?.duration_seconds || 0}s`;
        }
        break;
      }

      case "turnAwaitingInput": {
        flushAssistantText(true);
        removeThinkingPlaceholder();
        appendAwaitingInputActions(msg.kind);
        setGenerating(false);
        statusInfo.textContent = msg.kind === "confirmation"
          ? "Waiting for plan approval"
          : "Waiting for your answer";
        chatInput.focus();
        break;
      }

      case "statusChange": {
        setGenerating(msg.status === "running");
        break;
      }

      case "turnState": {
        if (["completed", "failed", "aborted", "awaiting_input"].includes(msg.state.phase)) setGenerating(false);
        updateTurnState(msg.state);
        break;
      }

      case "connectionState": {
        const connecting = msg.state === "connecting";
        if (!isGenerating) {
          modelSelect.disabled = connecting;
          effortSelect.disabled = connecting;
          permToggleBtn.disabled = connecting;
          newChatBtn.disabled = connecting;
          sessionSelect.disabled = connecting;
          statusInfo.textContent = connecting ? "Connecting..." : "Ready";
        }
        break;
      }

      case "error": {
        const hadActiveTurn = isGenerating;
        setGenerating(false);
        if (!hadActiveTurn || !activeAssistantTurn) prepareAssistantMessage(false);
        removeThinkingPlaceholder();
        const errorBox = document.createElement("div");
        errorBox.className = "message-error";
        errorBox.textContent = msg.message;
        activeAssistantTurn.appendChild(errorBox);
        break;
      }

      case "slashCommands": {
        slashCommands = msg.commands || [];
        if (chatInput.value.startsWith("/")) {
          handleSlashInput();
        }
        break;
      }

      case "setContext": {
        currentContext = { code: msg.code, file: msg.file };
        contextText.textContent = `Attached: ${msg.title || msg.file || "Code snippet"} (${msg.lineCount || 0} lines)`;
        contextPreview.style.display = "flex";
        chatInput.focus();
        break;
      }
    }
  });

  // Signal ready
  vscode.postMessage({ command: "ready" });
})();
