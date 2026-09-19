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

  let isPlanModeActive = false;

  let currentContext = null;
  let isGenerating = false;
  let activeAssistantBubble = null;
  let activeToolCards = {}; // stepIndex -> HTMLElement
  let currentRawText = "";
  let isDangerMode = true;

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
        return wrapCodeBlocks(rawHtml);
      } catch (e) {
        return escapeHtml(md);
      }
    }
    return escapeHtml(md);
  }

  function escapeHtml(str) {
    return str.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function wrapCodeBlocks(html) {
    const div = document.createElement("div");
    div.innerHTML = html;

    const preElements = div.querySelectorAll("pre");
    preElements.forEach((pre) => {
      const code = pre.querySelector("code");
      const codeText = code ? code.innerText : pre.innerText;
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

      const copyBtn = header.querySelector(".copy-btn");
      copyBtn.addEventListener("click", () => {
        vscode.postMessage({ command: "copyToClipboard", text: codeText });
        copyBtn.innerText = "Copied!";
        setTimeout(() => { copyBtn.innerText = "Copy"; }, 2000);
      });

      const insertBtn = header.querySelector(".insert-btn");
      insertBtn.addEventListener("click", () => {
        vscode.postMessage({ command: "applyCodeToEditor", code: codeText });
      });

      const diffBtn = header.querySelector(".diff-btn");
      diffBtn.addEventListener("click", () => {
        vscode.postMessage({ command: "viewDiff", code: codeText });
      });
    });

    return div.innerHTML;
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
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
    scrollToBottom();
  }

  function prepareAssistantMessage() {
    const msg = document.createElement("div");
    msg.className = "message assistant";

    const role = document.createElement("div");
    role.className = "message-role";
    role.textContent = "Antigravity";

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.innerHTML = "<em>Thinking...</em>";

    msg.appendChild(role);
    msg.appendChild(bubble);
    messagesContainer.appendChild(msg);

    activeAssistantBubble = bubble;
    currentRawText = "";
    activeToolCards = {};
    scrollToBottom();
    return bubble;
  }

  function updateAssistantText(delta) {
    if (!activeAssistantBubble) {
      prepareAssistantMessage();
    }
    currentRawText += delta;
    activeAssistantBubble.innerHTML = renderMarkdown(currentRawText);
    scrollToBottom();
  }

  function updateToolCard(stepIndex, toolName, state, toolInfo) {
    if (!activeAssistantBubble) {
      prepareAssistantMessage();
    }

    let card = activeToolCards[stepIndex];
    if (!card) {
      card = document.createElement("div");
      card.className = "tool-card";

      const header = document.createElement("div");
      header.className = "tool-header";

      const info = document.createElement("div");
      info.className = "tool-info";

      const spinner = document.createElement("div");
      spinner.className = "tool-spinner";
      info.appendChild(spinner);

      const name = document.createElement("span");
      name.textContent = `Tool: ${toolName}`;
      info.appendChild(name);

      const statusBadge = document.createElement("span");
      statusBadge.className = "tool-status-badge";
      statusBadge.textContent = "Running";

      header.appendChild(info);
      header.appendChild(statusBadge);

      const body = document.createElement("div");
      body.className = "tool-body";

      const outputPre = document.createElement("pre");
      outputPre.className = "tool-output";
      body.appendChild(outputPre);

      card.appendChild(header);
      card.appendChild(body);

      header.addEventListener("click", () => {
        body.classList.toggle("expanded");
      });

      // Insert before current text bubble
      const parent = activeAssistantBubble.parentNode;
      parent.insertBefore(card, activeAssistantBubble);
      activeToolCards[stepIndex] = card;
    }

    const spinner = card.querySelector(".tool-spinner");
    const statusBadge = card.querySelector(".tool-status-badge");
    const outputPre = card.querySelector(".tool-output");

    if (state === "DONE") {
      if (spinner) spinner.style.display = "none";
      if (statusBadge) {
        statusBadge.textContent = "✓ Completed";
        statusBadge.className = "tool-status-badge tool-status-done";
      }
    } else if (state === "FAILED") {
      if (spinner) spinner.style.display = "none";
      if (statusBadge) {
        statusBadge.textContent = "✕ Failed";
        statusBadge.className = "tool-status-badge tool-status-failed";
      }
    }

    if (toolInfo && outputPre) {
      let content = "";
      if (toolInfo.parameters) {
        content += `Params:\n${JSON.stringify(toolInfo.parameters, null, 2)}\n\n`;
      }
      if (toolInfo.output) {
        content += `Output:\n${toolInfo.output}`;
      }
      outputPre.textContent = content;
    }
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

  function setGenerating(generating) {
    isGenerating = generating;
    if (generating) {
      sendBtn.style.display = "none";
      stopBtn.style.display = "inline-flex";
      statusInfo.textContent = "Agent executing...";
    } else {
      sendBtn.style.display = "inline-flex";
      stopBtn.style.display = "none";
      statusInfo.textContent = "Ready";
    }
  }

  function handleSend() {
    const text = chatInput.value.trim();
    if (!text || isGenerating) return;

    appendUserMessage(text);
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
    setGenerating(false);
  });

  permToggleBtn.addEventListener("click", () => {
    const nextMode = !isDangerMode;
    updatePermissionUI(nextMode);
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
      // Toggle plan mode or insert /plan
      isPlanModeActive = true;
      if (planModePill) planModePill.classList.remove("hidden");
      chatInput.placeholder = "[Plan Mode] 描述你想规划的目标与方案...";
      chatInput.value = "";
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
    vscode.postMessage({ command: "newSession" });
  });

  sessionSelect.addEventListener("change", () => {
    const targetId = sessionSelect.value;
    if (targetId) {
      vscode.postMessage({ command: "switchSession", conversationId: targetId });
    }
  });

  modelSelect.addEventListener("change", () => {
    vscode.postMessage({
      command: "changeModel",
      model: modelSelect.value,
      effort: effortSelect.value
    });
  });

  effortSelect.addEventListener("change", () => {
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
      isPlanModeActive = false;
      if (planModePill) planModePill.classList.add("hidden");
      chatInput.placeholder = "Ask Antigravity anything... (Type / for commands & skills)";
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
        messagesContainer.innerHTML = "";
        activeAssistantBubble = null;
        activeToolCards = {};
        currentRawText = "";

        if (msg.config) {
          updatePermissionUI(msg.config.dangerouslySkipPermissions);
        }

        if (session.messages && session.messages.length > 0) {
          session.messages.forEach((m) => {
            if (m.role === "user") {
              appendUserMessage(m.text);
            } else if (m.role === "assistant") {
              const bubble = prepareAssistantMessage();
              currentRawText = m.text;
              bubble.innerHTML = renderMarkdown(m.text);

              if (m.toolCalls && m.toolCalls.length > 0) {
                m.toolCalls.forEach((tc) => {
                  updateToolCard(tc.stepIndex, tc.name, tc.state, {
                    parameters: tc.parameters,
                    output: tc.output
                  });
                });
              }
            }
          });
        }
        if (session.model) {
          modelSelect.value = session.model;
        }
        if (session.effort) {
          effortSelect.value = session.effort;
        }
        setGenerating(false);
        break;
      }

      case "permissionChanged": {
        updatePermissionUI(msg.dangerouslySkipPermissions);
        break;
      }

      case "sessionList": {
        sessionSelect.innerHTML = "";
        msg.sessions.forEach((s) => {
          const opt = document.createElement("option");
          opt.value = s.id;
          opt.textContent = s.title;
          if (s.id === msg.currentId) {
            opt.selected = true;
          }
          sessionSelect.appendChild(opt);
        });
        break;
      }

      case "streamDelta": {
        updateAssistantText(msg.delta);
        break;
      }

      case "toolUpdate": {
        updateToolCard(msg.stepIndex, msg.toolName, msg.state, msg.toolInfo);
        break;
      }

      case "turnComplete": {
        setGenerating(false);
        if (msg.usage) {
          statusInfo.textContent = `Tokens: ${msg.usage.total_tokens || msg.usage.output_tokens} | Duration: ${msg.result?.duration_seconds || 0}s`;
        }
        break;
      }

      case "statusChange": {
        setGenerating(msg.status === "running");
        break;
      }

      case "error": {
        setGenerating(false);
        if (activeAssistantBubble) {
          activeAssistantBubble.innerHTML += `<div style="color:var(--accent-red); margin-top:8px;">⚠️ ${msg.message}</div>`;
        } else {
          const b = prepareAssistantMessage();
          b.innerHTML = `<div style="color:var(--accent-red)">⚠️ ${msg.message}</div>`;
        }
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
