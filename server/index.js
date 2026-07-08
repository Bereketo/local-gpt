import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");

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

function resolveBaseUrl(provider, requestedBaseUrl) {
  if (requestedBaseUrl && typeof requestedBaseUrl === "string") {
    return requestedBaseUrl.replace(/\/$/, "");
  }

  return provider === "llama.cpp" ? llamaBaseUrl : ollamaBaseUrl;
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

  try {
    if (provider === "llama.cpp") {
      const response = await fetch(`${baseUrl}/v1/models`);
      const data = await response.json();
      sendJson(res, response.ok ? 200 : response.status, {
        provider,
        baseUrl,
        models: Array.isArray(data.data)
          ? data.data.map((model) => ({ name: model.id, details: model }))
          : []
      });
      return;
    }

    const response = await fetch(`${baseUrl}/api/tags`);
    const data = await response.json();
    sendJson(res, response.ok ? 200 : response.status, {
      provider,
      baseUrl,
      models: Array.isArray(data.models)
        ? data.models.map((model) => ({
            name: model.name,
            size: model.size,
            modifiedAt: model.modified_at,
            details: model.details
          }))
        : []
    });
  } catch (error) {
    sendJson(res, 502, {
      error: "Provider is unreachable",
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
          num_ctx: body.contextWindow
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
