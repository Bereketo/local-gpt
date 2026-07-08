const storageKey = "local-gpt-state-v1";

const defaults = {
  provider: "ollama",
  endpoints: {
    ollama: "http://127.0.0.1:11434",
    "llama.cpp": "http://127.0.0.1:8080"
  },
  selectedModels: {},
  conversations: [],
  activeConversationId: null,
  temperature: 0.7,
  contextWindow: 4096
};

const providerSelect = document.querySelector("#providerSelect");
const baseUrlInput = document.querySelector("#baseUrlInput");
const modelSelect = document.querySelector("#modelSelect");
const refreshModelsButton = document.querySelector("#refreshModelsButton");
const connectionStatus = document.querySelector("#connectionStatus");
const setupPanel = document.querySelector("#setupPanel");
const conversationList = document.querySelector("#conversationList");
const messagesEl = document.querySelector("#messages");
const newChatButton = document.querySelector("#newChatButton");
const renameChatButton = document.querySelector("#renameChatButton");
const deleteChatButton = document.querySelector("#deleteChatButton");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const temperatureInput = document.querySelector("#temperatureInput");
const temperatureValue = document.querySelector("#temperatureValue");
const contextInput = document.querySelector("#contextInput");

let state = loadState();
let isStreaming = false;
let currentAbortController = null;
let providerHealth = null;

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey));
    return {
      ...defaults,
      ...parsed,
      endpoints: { ...defaults.endpoints, ...(parsed?.endpoints ?? {}) },
      selectedModels: parsed?.selectedModels ?? {},
      conversations: parsed?.conversations ?? []
    };
  } catch {
    return structuredClone(defaults);
  }
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function formatModelSize(bytes) {
  if (!bytes) return "";
  const gb = bytes / 1024 / 1024 / 1024;
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
}

function activeConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeConversationId);
}

function buildConversation() {
  return {
    id: crypto.randomUUID(),
    title: "New local chat",
    createdAt: new Date().toISOString(),
    messages: []
  };
}

function ensureActiveConversation() {
  if (state.conversations.length === 0) {
    const conversation = buildConversation();
    state.conversations.push(conversation);
    state.activeConversationId = conversation.id;
  }

  if (!activeConversation()) {
    state.activeConversationId = state.conversations[0].id;
  }
}

function createConversation() {
  const conversation = buildConversation();
  state.conversations.unshift(conversation);
  state.activeConversationId = conversation.id;
  saveState();
  renderConversations();
  renderMessages();
}

function renameActiveConversation() {
  const conversation = activeConversation();
  if (!conversation) return;

  const title = prompt("Rename chat", conversation.title)?.trim();
  if (!title) return;

  conversation.title = title.slice(0, 80);
  saveState();
  renderConversations();
}

function deleteActiveConversation() {
  const conversation = activeConversation();
  if (!conversation) return;

  const confirmed = confirm(`Delete "${conversation.title}"?`);
  if (!confirmed) return;

  state.conversations = state.conversations.filter((item) => item.id !== conversation.id);
  ensureActiveConversation();
  saveState();
  renderConversations();
  renderMessages();
}

function setStatus(text, variant = "") {
  connectionStatus.textContent = text;
  connectionStatus.className = `status-pill ${variant}`.trim();
}

function providerName(provider = state.provider) {
  return provider === "llama.cpp" ? "llama.cpp" : "Ollama";
}

function healthTone(health) {
  if (!health) return "";
  if (!health.ok) return "error";
  return health.modelCount > 0 ? "ready" : "warning";
}

function healthTitle(health) {
  if (!health) return "Checking provider";
  if (!health.ok) return `${providerName(health.provider)} is offline`;
  if (health.modelCount === 0) return `${providerName(health.provider)} is reachable`;
  return `${providerName(health.provider)} is ready`;
}

function healthMeta(health) {
  if (!health) return "Waiting for provider check";
  const latency = Number.isFinite(health.latencyMs) ? `${health.latencyMs} ms` : "unknown latency";
  return `${health.baseUrl} · ${latency}`;
}

function renderSetupPanel() {
  const health = providerHealth;
  const tone = healthTone(health);
  const models = health?.models ?? [];
  const topModels = models.slice(0, 4);
  const instructions = health?.instructions;
  const canChat = health?.ok && health.modelCount > 0;

  setupPanel.className = `setup-panel ${tone}`.trim();
  setupPanel.innerHTML = `
    <div class="setup-summary">
      <div class="health-dot" aria-hidden="true"></div>
      <div>
        <h2>${escapeHtml(healthTitle(health))}</h2>
        <p>${escapeHtml(health?.message ?? "Checking whether your local model server is available.")}</p>
      </div>
    </div>
    <div class="setup-meta">
      <span>${escapeHtml(healthMeta(health))}</span>
      <span>${models.length} model${models.length === 1 ? "" : "s"}</span>
    </div>
    ${
      canChat
        ? `<div class="model-strip">${topModels.map(renderModelChip).join("")}${models.length > topModels.length ? `<span class="model-chip muted">+${models.length - topModels.length} more</span>` : ""}</div>`
        : renderSetupInstructions(instructions, health)
    }
  `;
}

function renderModelChip(model) {
  const size = model.size ? formatModelSize(model.size) : "local";
  return `<span class="model-chip">${escapeHtml(model.name)} <small>${escapeHtml(size)}</small></span>`;
}

function renderSetupInstructions(instructions, health) {
  if (!instructions) {
    return `<div class="setup-actions"><button class="ghost-button" type="button" data-action="refresh-health">Check again</button></div>`;
  }

  const commandHtml = instructions.commands
    .map((command) => `<code>${escapeHtml(command)}</code>`)
    .join("");

  return `
    <div class="setup-guide">
      <div>
        <strong>${escapeHtml(instructions.title)}</strong>
        <p>${escapeHtml(instructions.note)}</p>
        ${health?.details ? `<p class="setup-detail">${escapeHtml(health.details)}</p>` : ""}
      </div>
      <div class="command-stack">${commandHtml}</div>
      <button class="ghost-button" type="button" data-action="refresh-health">Check again</button>
    </div>
  `;
}

function renderConversations() {
  ensureActiveConversation();
  conversationList.innerHTML = "";

  for (const conversation of state.conversations) {
    const button = document.createElement("button");
    button.className = `conversation-item ${conversation.id === state.activeConversationId ? "active" : ""}`;
    button.type = "button";
    button.innerHTML = `
      <strong>${escapeHtml(conversation.title)}</strong>
      <span>${conversation.messages.length} messages</span>
    `;
    button.addEventListener("click", () => {
      state.activeConversationId = conversation.id;
      saveState();
      renderConversations();
      renderMessages();
    });
    conversationList.append(button);
  }
}

function renderMessages() {
  const conversation = activeConversation();
  messagesEl.innerHTML = "";

  if (!conversation || conversation.messages.length === 0) {
    messagesEl.innerHTML = `
      <div class="empty-state">
        <div>
          <h2>Your models, your machine.</h2>
          <p>Connect to Ollama or llama.cpp, choose a model, and chat with a local assistant without sending conversation data to a hosted AI service.</p>
        </div>
      </div>
    `;
    return;
  }

  for (const message of conversation.messages) {
    messagesEl.append(renderMessage(message));
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessage(message) {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${message.role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = message.role === "user" ? "You" : "AI";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = renderMarkdownish(message.content);

  const actions = document.createElement("div");
  actions.className = "message-actions";
  actions.append(
    buildMessageAction("Copy", () => copyMessage(message)),
    buildMessageAction("Edit", () => editMessage(message))
  );
  if (message.role === "assistant") {
    actions.append(buildMessageAction("Regenerate", () => regenerateFrom(message)));
  }

  const content = document.createElement("div");
  content.className = "message-content";
  content.append(bubble, actions);

  wrapper.append(avatar, content);
  return wrapper;
}

function buildMessageAction(label, handler) {
  const button = document.createElement("button");
  button.className = "message-action";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

async function copyMessage(message) {
  try {
    await navigator.clipboard.writeText(message.content);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = message.content;
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

function editMessage(message) {
  if (isStreaming) return;
  const conversation = activeConversation();
  if (!conversation) return;
  if (message.role === "user" && !hasRunnableModel()) return;

  const edited = prompt("Edit message", message.content)?.trim();
  if (!edited) return;

  const index = conversation.messages.indexOf(message);
  if (index === -1) return;

  message.content = edited;
  if (message.role === "user") {
    conversation.messages = conversation.messages.slice(0, index + 1);
    regenerateAfterLastUser(conversation);
    return;
  }

  saveState();
  renderMessages();
}

function regenerateFrom(message) {
  if (isStreaming) return;
  const conversation = activeConversation();
  if (!conversation) return;
  if (!hasRunnableModel()) return;

  const index = conversation.messages.indexOf(message);
  if (index <= 0) return;

  conversation.messages = conversation.messages.slice(0, index);
  regenerateAfterLastUser(conversation);
}

function regenerateAfterLastUser(conversation) {
  if (!hasRunnableModel()) return;

  const lastUserMessage = [...conversation.messages].reverse().find((message) => message.role === "user");
  if (!lastUserMessage) return;

  const assistantMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };
  conversation.messages.push(assistantMessage);
  saveState();
  renderConversations();
  renderMessages();
  streamAssistantReply(conversation, assistantMessage);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderMarkdownish(value) {
  const escaped = escapeHtml(value);
  const withCode = escaped.replace(/```([\s\S]*?)```/g, (_match, code) => `<pre><code>${code.trim()}</code></pre>`);
  return withCode
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^\s*[-*] (.*)$/gm, "<div class=\"list-line\">• $1</div>");
}

function syncControls() {
  providerSelect.value = state.provider;
  baseUrlInput.value = state.endpoints[state.provider];
  temperatureInput.value = state.temperature;
  temperatureValue.value = state.temperature;
  contextInput.value = state.contextWindow;
}

async function refreshModels() {
  const provider = state.provider;
  const baseUrl = state.endpoints[provider];
  modelSelect.innerHTML = `<option value="">Loading models...</option>`;
  setStatus("Connecting...");
  providerHealth = null;
  renderSetupPanel();

  try {
    const response = await fetch(`/api/health?provider=${encodeURIComponent(provider)}&baseUrl=${encodeURIComponent(baseUrl)}`);
    const data = await response.json();
    providerHealth = data;
    renderSetupPanel();
    if (!data.ok) throw new Error(data.details || data.message || "Unable to load models");

    modelSelect.innerHTML = "";
    if (data.models.length === 0) {
      modelSelect.innerHTML = `<option value="">No models found</option>`;
      setStatus("No models installed", "error");
      return;
    }

    for (const model of data.models) {
      const option = document.createElement("option");
      option.value = model.name;
      const suffix = model.size ? ` · ${formatModelSize(model.size)}` : "";
      option.textContent = `${model.name}${suffix}`;
      modelSelect.append(option);
    }

    const savedModel = state.selectedModels[provider];
    modelSelect.value = savedModel && data.models.some((model) => model.name === savedModel)
      ? savedModel
      : data.models[0].name;
    state.selectedModels[provider] = modelSelect.value;
    saveState();
    setStatus(`${data.models.length} model${data.models.length === 1 ? "" : "s"} ready`, "connected");
  } catch (error) {
    modelSelect.innerHTML = `<option value="">Unavailable</option>`;
    if (!providerHealth) {
      providerHealth = {
        provider,
        baseUrl,
        ok: false,
        modelCount: 0,
        models: [],
        latencyMs: 0,
        message: "Provider is unreachable",
        details: error instanceof Error ? error.message : String(error)
      };
      renderSetupPanel();
    }
    setStatus(`${providerName(provider)} is offline`, "error");
  }
}

function parseOllamaChunk(line) {
  const data = JSON.parse(line);
  if (data.error) throw new Error(data.error);
  return data.message?.content ?? "";
}

function parseLlamaCppChunk(line) {
  if (!line.startsWith("data:")) return "";
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return "";
  const data = JSON.parse(payload);
  return data.choices?.[0]?.delta?.content ?? "";
}

async function streamChat() {
  if (isStreaming && currentAbortController) {
    currentAbortController.abort();
    return;
  }

  const prompt = messageInput.value.trim();
  const conversation = activeConversation();
  const model = modelSelect.value;
  if (!prompt || !conversation || isStreaming) return;
  if (!model) {
    setStatus(`Select an available ${providerName()} model`, "error");
    return;
  }

  const userMessage = { id: crypto.randomUUID(), role: "user", content: prompt };
  const assistantMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };
  conversation.messages.push(userMessage, assistantMessage);
  if (conversation.title === "New local chat") {
    conversation.title = prompt.slice(0, 56);
  }
  messageInput.value = "";
  autosizeTextarea();
  saveState();
  renderConversations();
  renderMessages();

  await streamAssistantReply(conversation, assistantMessage);
}

async function streamAssistantReply(conversation, assistantMessage) {
  const model = modelSelect.value;
  if (!conversation || !assistantMessage || !model || isStreaming) return;

  isStreaming = true;
  currentAbortController = new AbortController();
  sendButton.textContent = "Stop";

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: currentAbortController.signal,
      body: JSON.stringify({
        provider: state.provider,
        baseUrl: state.endpoints[state.provider],
        model,
        messages: conversation.messages
          .filter((message) => message.content.trim() !== "")
          .map(({ role, content }) => ({ role, content })),
        temperature: Number(state.temperature),
        contextWindow: Number(state.contextWindow)
      })
    });

    if (!response.ok || !response.body) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.details || error.error || "The model request failed.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        appendStreamLine(line, assistantMessage);
      }
    }

    appendStreamLine(buffer, assistantMessage);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      assistantMessage.content += assistantMessage.content ? "\n\nStopped." : "Stopped.";
    } else {
      assistantMessage.content = `Request failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    saveState();
    renderMessages();
  } finally {
    isStreaming = false;
    currentAbortController = null;
    sendButton.textContent = "Send";
  }
}

function appendStreamLine(line, assistantMessage) {
  const trimmed = line.trim();
  if (!trimmed) return;
  const token = state.provider === "llama.cpp"
    ? parseLlamaCppChunk(trimmed)
    : parseOllamaChunk(trimmed);
  assistantMessage.content += token;
  saveState();
  renderMessages();
}

function hasRunnableModel() {
  if (modelSelect.value) return true;
  setStatus(`Select an available ${providerName()} model`, "error");
  return false;
}

function autosizeTextarea() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`;
}

providerSelect.addEventListener("change", () => {
  state.provider = providerSelect.value;
  syncControls();
  saveState();
  refreshModels();
});

baseUrlInput.addEventListener("change", () => {
  state.endpoints[state.provider] = baseUrlInput.value.replace(/\/$/, "");
  saveState();
  refreshModels();
});

modelSelect.addEventListener("change", () => {
  state.selectedModels[state.provider] = modelSelect.value;
  saveState();
});

refreshModelsButton.addEventListener("click", refreshModels);
newChatButton.addEventListener("click", createConversation);
renameChatButton.addEventListener("click", renameActiveConversation);
deleteChatButton.addEventListener("click", deleteActiveConversation);
setupPanel.addEventListener("click", (event) => {
  const action = event.target instanceof HTMLElement ? event.target.dataset.action : "";
  if (action === "refresh-health") refreshModels();
});

temperatureInput.addEventListener("input", () => {
  state.temperature = Number(temperatureInput.value);
  temperatureValue.value = state.temperature;
  saveState();
});

contextInput.addEventListener("change", () => {
  state.contextWindow = Number(contextInput.value);
  saveState();
});

messageInput.addEventListener("input", autosizeTextarea);
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  streamChat();
});

syncControls();
ensureActiveConversation();
saveState();
renderConversations();
renderMessages();
renderSetupPanel();
refreshModels();
