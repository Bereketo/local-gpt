# Local GPT

A local-first chat interface for models served by Ollama or llama.cpp. The app runs a small Node server that serves the UI and proxies streaming model responses from your machine.

## Run

```sh
npm run dev
```

Open `http://127.0.0.1:5173`.

## Providers

### Ollama

Default endpoint:

```txt
http://127.0.0.1:11434
```

Start Ollama and make sure at least one model is installed:

```sh
ollama pull llama3.2
ollama serve
```

### llama.cpp

Default endpoint:

```txt
http://127.0.0.1:8080
```

Start the llama.cpp server with OpenAI-compatible endpoints enabled. The app calls:

```txt
/v1/models
/v1/chat/completions
```

## Configuration

You can override defaults when starting the app:

```sh
PORT=5173 \
OLLAMA_BASE_URL=http://127.0.0.1:11434 \
LLAMA_CPP_BASE_URL=http://127.0.0.1:8080 \
npm run dev
```

Chats and UI preferences are stored in browser local storage.
