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
const conversationList = document.querySelector("#conversationList");
const messagesEl = document.querySelector("#messages");
const newChatButton = document.querySelector("#newChatButton");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const temperatureInput = document.querySelector("#temperatureInput");
const temperatureValue = document.querySelector("#temperatureValue");
const contextInput = document.querySelector("#contextInput");

let state = loadState();
let isStreaming = false;
let currentAbortController = null;

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

function setStatus(text, variant = "") {
  connectionStatus.textContent = text;
  connectionStatus.className = `status-pill ${variant}`.trim();
}

function providerName(provider = state.provider) {
  return provider === "llama.cpp" ? "llama.cpp" : "Ollama";
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

  wrapper.append(avatar, bubble);
  return wrapper;
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
  return escaped.replace(/```([\s\S]*?)```/g, (_match, code) => `<pre><code>${code.trim()}</code></pre>`);
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

  try {
    const response = await fetch(`/api/models?provider=${encodeURIComponent(provider)}&baseUrl=${encodeURIComponent(baseUrl)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.details || data.error || "Unable to load models");

    modelSelect.innerHTML = "";
    if (data.models.length === 0) {
      modelSelect.innerHTML = `<option value="">No models found</option>`;
      setStatus("No models found", "error");
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
  if (!prompt || !conversation || !model || isStreaming) return;

  const userMessage = { role: "user", content: prompt };
  const assistantMessage = { role: "assistant", content: "" };
  conversation.messages.push(userMessage, assistantMessage);
  if (conversation.title === "New local chat") {
    conversation.title = prompt.slice(0, 56);
  }
  messageInput.value = "";
  autosizeTextarea();
  saveState();
  renderConversations();
  renderMessages();

  isStreaming = true;
  currentAbortController = new AbortController();
  sendButton.disabled = true;
  sendButton.disabled = false;
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
refreshModels();
