import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const databasePath = process.env.DATABASE_PATH ?? path.join(dataDir, "local-gpt.sqlite");

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 5173);
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const llamaBaseUrl = process.env.LLAMA_CPP_BASE_URL ?? "http://127.0.0.1:8080";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"]
]);

mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    profile TEXT NOT NULL DEFAULT 'general',
    system_prompt TEXT NOT NULL DEFAULT '',
    temperature REAL,
    context_window INTEGER,
    max_tokens INTEGER,
    model TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
    content TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);
  CREATE INDEX IF NOT EXISTS idx_messages_conversation_position ON messages(conversation_id, position);
`);

const conversationColumns = db.prepare("PRAGMA table_info(conversations)").all().map((column) => column.name);
const migrations = [
  ["profile", "ALTER TABLE conversations ADD COLUMN profile TEXT NOT NULL DEFAULT 'general'"],
  ["system_prompt", "ALTER TABLE conversations ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''"],
  ["temperature", "ALTER TABLE conversations ADD COLUMN temperature REAL"],
  ["context_window", "ALTER TABLE conversations ADD COLUMN context_window INTEGER"],
  ["max_tokens", "ALTER TABLE conversations ADD COLUMN max_tokens INTEGER"],
  ["model", "ALTER TABLE conversations ADD COLUMN model TEXT"]
];

for (const [column, statement] of migrations) {
  if (!conversationColumns.includes(column)) db.exec(statement);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function optionalNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeMessage(message, index, conversationId) {
  return {
    id: typeof message.id === "string" && message.id ? message.id : createId(),
    conversationId,
    role: ["system", "user", "assistant"].includes(message.role) ? message.role : "user",
    content: typeof message.content === "string" ? message.content : "",
    position: index,
    createdAt: typeof message.createdAt === "string" && message.createdAt ? message.createdAt : nowIso()
  };
}

function serializeConversation(row, messages) {
  return {
    id: row.id,
    title: row.title,
    pinned: Boolean(row.pinned),
    profile: row.profile ?? "general",
    systemPrompt: row.system_prompt ?? "",
    temperature: row.temperature,
    contextWindow: row.context_window,
    maxTokens: row.max_tokens,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.created_at
    }))
  };
}

function getConversation(id) {
  const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
  if (!row) return null;

  const messages = db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY position ASC")
    .all(id);
  return serializeConversation(row, messages);
}

function listConversations(search = "") {
  const trimmedSearch = search.trim();
  const rows = trimmedSearch
    ? db
        .prepare(`
          SELECT DISTINCT conversations.*
          FROM conversations
          LEFT JOIN messages ON messages.conversation_id = conversations.id
          WHERE conversations.title LIKE ? OR messages.content LIKE ?
          ORDER BY conversations.pinned DESC, conversations.updated_at DESC
        `)
        .all(`%${trimmedSearch}%`, `%${trimmedSearch}%`)
    : db
        .prepare("SELECT * FROM conversations ORDER BY pinned DESC, updated_at DESC")
        .all();

  const messagesByConversation = new Map();
  if (rows.length > 0) {
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    const messages = db
      .prepare(`SELECT * FROM messages WHERE conversation_id IN (${placeholders}) ORDER BY position ASC`)
      .all(...ids);
    for (const message of messages) {
      const existing = messagesByConversation.get(message.conversation_id) ?? [];
      existing.push(message);
      messagesByConversation.set(message.conversation_id, existing);
    }
  }

  return rows.map((row) => serializeConversation(row, messagesByConversation.get(row.id) ?? []));
}

function upsertConversation(payload) {
  const id = typeof payload.id === "string" && payload.id ? payload.id : createId();
  const existing = getConversation(id);
  const createdAt = payload.createdAt ?? existing?.createdAt ?? nowIso();
  const updatedAt = nowIso();
  const title = typeof payload.title === "string" && payload.title.trim()
    ? payload.title.trim().slice(0, 120)
    : existing?.title ?? "New local chat";
  const profile = typeof payload.profile === "string" && payload.profile.trim()
    ? payload.profile.trim().slice(0, 40)
    : existing?.profile ?? "general";
  const systemPrompt = typeof payload.systemPrompt === "string"
    ? payload.systemPrompt.trim()
    : existing?.systemPrompt ?? "";
  const temperature = Object.hasOwn(payload, "temperature")
    ? optionalNumber(payload.temperature)
    : existing?.temperature ?? null;
  const contextWindow = Object.hasOwn(payload, "contextWindow")
    ? optionalNumber(payload.contextWindow)
    : existing?.contextWindow ?? null;
  const maxTokens = Object.hasOwn(payload, "maxTokens")
    ? optionalNumber(payload.maxTokens)
    : existing?.maxTokens ?? null;
  const model = typeof payload.model === "string" && payload.model.trim()
    ? payload.model.trim()
    : existing?.model ?? null;
  const pinned = Object.hasOwn(payload, "pinned")
    ? payload.pinned === true || payload.pinned === 1
      ? 1
      : 0
    : existing?.pinned
      ? 1
      : 0;
  const messages = Array.isArray(payload.messages) ? payload.messages : existing?.messages ?? [];

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO conversations (
        id, title, pinned, profile, system_prompt, temperature, context_window,
        max_tokens, model, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        pinned = excluded.pinned,
        profile = excluded.profile,
        system_prompt = excluded.system_prompt,
        temperature = excluded.temperature,
        context_window = excluded.context_window,
        max_tokens = excluded.max_tokens,
        model = excluded.model,
        updated_at = excluded.updated_at
    `).run(
      id,
      title,
      pinned,
      profile,
      systemPrompt,
      temperature,
      contextWindow,
      maxTokens,
      model,
      createdAt,
      updatedAt
    );

    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
    const insertMessage = db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    messages.map((message, index) => normalizeMessage(message, index, id)).forEach((message) => {
      insertMessage.run(
        message.id,
        message.conversationId,
        message.role,
        message.content,
        message.position,
        message.createdAt
      );
    });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return getConversation(id);
}

function patchConversation(id, payload) {
  const existing = getConversation(id);
  if (!existing) return null;

  return upsertConversation({
    ...existing,
    title: payload.title ?? existing.title,
    pinned: typeof payload.pinned === "boolean" ? payload.pinned : existing.pinned,
    profile: payload.profile ?? existing.profile,
    systemPrompt: payload.systemPrompt ?? existing.systemPrompt,
    temperature: Object.hasOwn(payload, "temperature") ? payload.temperature : existing.temperature,
    contextWindow: Object.hasOwn(payload, "contextWindow") ? payload.contextWindow : existing.contextWindow,
    maxTokens: Object.hasOwn(payload, "maxTokens") ? payload.maxTokens : existing.maxTokens,
    model: Object.hasOwn(payload, "model") ? payload.model : existing.model,
    messages: existing.messages
  });
}

function deleteConversation(id) {
  const result = db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  return result.changes > 0;
}

function resolveBaseUrl(provider, requestedBaseUrl) {
  if (requestedBaseUrl && typeof requestedBaseUrl === "string") {
    return requestedBaseUrl.replace(/\/$/, "");
  }

  return provider === "llama.cpp" ? llamaBaseUrl : ollamaBaseUrl;
}

function providerInstructions(provider) {
  if (provider === "llama.cpp") {
    return {
      title: "Start llama.cpp server",
      commands: [
        "./llama-server -m /path/to/model.gguf --host 127.0.0.1 --port 8080"
      ],
      note: "Local GPT expects the llama.cpp OpenAI-compatible endpoints at /v1/models and /v1/chat/completions."
    };
  }

  return {
    title: "Start Ollama",
    commands: ["ollama serve", "ollama pull llama3.2"],
    note: "Ollama must be running locally and have at least one model installed."
  };
}

async function loadProviderModels(provider, baseUrl) {
  if (provider === "llama.cpp") {
    const response = await fetch(`${baseUrl}/v1/models`);
    const data = await response.json();
    const models = Array.isArray(data.data)
      ? data.data.map((model) => ({ name: model.id, details: model }))
      : [];

    return { response, models };
  }

  const response = await fetch(`${baseUrl}/api/tags`);
  const data = await response.json();
  const models = Array.isArray(data.models)
    ? data.models.map((model) => ({
        name: model.name,
        size: model.size,
        modifiedAt: model.modified_at,
        details: model.details
      }))
    : [];

  return { response, models };
}

async function checkProviderHealth(provider, baseUrl) {
  const startedAt = performance.now();

  try {
    const { response, models } = await loadProviderModels(provider, baseUrl);
    const latencyMs = Math.round(performance.now() - startedAt);

    return {
      provider,
      baseUrl,
      ok: response.ok,
      status: response.status,
      latencyMs,
      modelCount: models.length,
      models,
      message: response.ok
        ? models.length > 0
          ? `${models.length} model${models.length === 1 ? "" : "s"} available`
          : "Provider is reachable, but no models are installed"
        : `Provider returned HTTP ${response.status}`,
      instructions: providerInstructions(provider)
    };
  } catch (error) {
    return {
      provider,
      baseUrl,
      ok: false,
      status: 0,
      latencyMs: Math.round(performance.now() - startedAt),
      modelCount: 0,
      models: [],
      message: "Provider is unreachable",
      details: error instanceof Error ? error.message : String(error),
      instructions: providerInstructions(provider)
    };
  }
}

async function forwardStream(res, upstream) {
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

async function handleModels(req, res) {
  const query = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const provider = query.get("provider") ?? "ollama";
  const baseUrl = resolveBaseUrl(provider, query.get("baseUrl"));

  const health = await checkProviderHealth(provider, baseUrl);
  sendJson(res, health.ok ? 200 : 502, {
    provider,
    baseUrl,
    models: health.models,
    error: health.ok ? undefined : health.message,
    details: health.details
  });
}

async function readProviderAction(req) {
  const body = await readJson(req);
  const provider = body.provider ?? "ollama";
  const baseUrl = resolveBaseUrl(provider, body.baseUrl);
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (provider !== "ollama") {
    return {
      error: {
        status: 400,
        body: { error: "Model management is currently available for Ollama only." }
      }
    };
  }

  if (!name) {
    return {
      error: {
        status: 400,
        body: { error: "A model name is required." }
      }
    };
  }

  return { baseUrl, name };
}

async function handlePullModel(req, res) {
  try {
    const action = await readProviderAction(req);
    if (action.error) {
      sendJson(res, action.error.status, action.error.body);
      return;
    }

    const upstream = await fetch(`${action.baseUrl}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: action.name, stream: false })
    });
    const data = await upstream.json().catch(() => ({}));

    sendJson(res, upstream.ok ? 200 : upstream.status, {
      ok: upstream.ok,
      model: action.name,
      message: upstream.ok ? `Pulled ${action.name}` : data.error ?? "Model pull failed",
      details: data
    });
  } catch (error) {
    sendJson(res, 502, {
      error: "Model pull failed",
      details: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleDeleteModel(req, res) {
  try {
    const action = await readProviderAction(req);
    if (action.error) {
      sendJson(res, action.error.status, action.error.body);
      return;
    }

    const upstream = await fetch(`${action.baseUrl}/api/delete`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: action.name })
    });
    const data = await upstream.json().catch(() => ({}));

    sendJson(res, upstream.ok ? 200 : upstream.status, {
      ok: upstream.ok,
      model: action.name,
      message: upstream.ok ? `Deleted ${action.name}` : data.error ?? "Model delete failed",
      details: data
    });
  } catch (error) {
    sendJson(res, 502, {
      error: "Model delete failed",
      details: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleHealth(req, res) {
  const query = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const provider = query.get("provider") ?? "ollama";
  const baseUrl = resolveBaseUrl(provider, query.get("baseUrl"));
  const health = await checkProviderHealth(provider, baseUrl);

  sendJson(res, 200, health);
}

async function handleConversations(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];

  try {
    if (req.method === "GET" && !id) {
      sendJson(res, 200, { conversations: listConversations(url.searchParams.get("search") ?? "") });
      return;
    }

    if (req.method === "POST" && !id) {
      const body = await readJson(req);
      sendJson(res, 201, { conversation: upsertConversation(body) });
      return;
    }

    if (req.method === "GET" && id) {
      const conversation = getConversation(id);
      if (!conversation) {
        sendJson(res, 404, { error: "Conversation not found" });
        return;
      }
      sendJson(res, 200, { conversation });
      return;
    }

    if (req.method === "PUT" && id) {
      const body = await readJson(req);
      sendJson(res, 200, { conversation: upsertConversation({ ...body, id }) });
      return;
    }

    if (req.method === "PATCH" && id) {
      const body = await readJson(req);
      const conversation = patchConversation(id, body);
      if (!conversation) {
        sendJson(res, 404, { error: "Conversation not found" });
        return;
      }
      sendJson(res, 200, { conversation });
      return;
    }

    if (req.method === "DELETE" && id) {
      sendJson(res, deleteConversation(id) ? 200 : 404, {
        deleted: true
      });
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, 500, {
      error: "Conversation request failed",
      details: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "Request body must be valid JSON." });
    return;
  }

  const provider = body.provider ?? "ollama";
  const baseUrl = resolveBaseUrl(provider, body.baseUrl);
  const messages = Array.isArray(body.messages) ? body.messages : [];

  if (!body.model || messages.length === 0) {
    sendJson(res, 400, { error: "A model and at least one message are required." });
    return;
  }

  try {
    if (provider === "llama.cpp") {
      const upstream = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: body.model,
          messages,
          stream: true,
          temperature: body.temperature,
          max_tokens: body.maxTokens
        })
      });
      await forwardStream(res, upstream);
      return;
    }

    const upstream = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: body.model,
        messages,
        stream: true,
        options: {
          temperature: body.temperature,
          num_ctx: body.contextWindow,
          num_predict: body.maxTokens
        }
      })
    });
    await forwardStream(res, upstream);
  } catch (error) {
    sendJson(res, 502, {
      error: "Chat request failed",
      details: error instanceof Error ? error.message : String(error)
    });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cleanPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const requestedPath = path.normalize(path.join(publicDir, cleanPath));

  if (!requestedPath.startsWith(publicDir) || !existsSync(requestedPath)) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const ext = path.extname(requestedPath);
  res.writeHead(200, {
    "content-type": mimeTypes.get(ext) ?? "application/octet-stream"
  });
  createReadStream(requestedPath).pipe(res);
}

const server = createServer(async (req, res) => {
  if (req.url?.startsWith("/api/conversations")) {
    await handleConversations(req, res);
    return;
  }

  if (req.url?.startsWith("/api/health")) {
    await handleHealth(req, res);
    return;
  }

  if (req.url === "/api/models/pull" && req.method === "POST") {
    await handlePullModel(req, res);
    return;
  }

  if (req.url === "/api/models/delete" && req.method === "POST") {
    await handleDeleteModel(req, res);
    return;
  }

  if (req.url?.startsWith("/api/models")) {
    await handleModels(req, res);
    return;
  }

  if (req.url === "/api/chat" && req.method === "POST") {
    await handleChat(req, res);
    return;
  }

  await serveStatic(req, res);
});

server.listen(port, host, () => {
  console.log(`Local GPT is running at http://${host}:${port}`);
  console.log(`Ollama endpoint: ${ollamaBaseUrl}`);
  console.log(`llama.cpp endpoint: ${llamaBaseUrl}`);
});
