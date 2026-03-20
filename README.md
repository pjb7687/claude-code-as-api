# Claude Code as an API

Dockerized Claude Code with an OpenAI / Anthropic / OpenRouter-compatible API. Send requests using any SDK and Claude Code handles them.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- A Claude Pro or Max subscription

## Quick Start

```bash
./start.sh
```

On first run, it will:
1. Prompt you to log in to Claude
2. Ask which API flavor to use (OpenAI, Anthropic, or OpenRouter)
3. Start the service

The API is available at `http://localhost:23411`.

## How It Works

This project uses Claude Code's [channels](https://docs.anthropic.com/en/docs/claude-code/channels) feature — an MCP-based mechanism that lets external services push messages into a running Claude Code session and receive replies.

```
Client (any SDK)
  |
  | POST /v1/chat/completions or /v1/messages
  v
localcc (MCP server + HTTP gateway)
  |
  | channel notification ──> Claude Code receives the message
  |                          Claude Code processes and calls reply tool
  | <── reply tool call ────
  v
localcc resolves the parked HTTP request
  |
  | JSON response in the chosen API flavor
  v
Client
```

1. An API request arrives at the localcc HTTP server
2. The message is delivered to Claude Code via an MCP channel notification
3. The HTTP request parks, waiting for a response
4. Claude Code processes the message and calls the `reply` tool
5. localcc formats the reply in the chosen API flavor and returns it

## API Flavors

Choose a flavor on first run. The choice is saved to `.localcc-flavor`. Delete the file to rechoose.

### OpenAI (default)

Endpoints: `/v1/chat/completions`, `/v1/responses`, `/v1/models`

```bash
curl http://localhost:23411/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "anthropic/claude-code", "messages": [{"role": "user", "content": "Hello"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:23411/v1", api_key="unused")
r = client.chat.completions.create(model="anthropic/claude-code", messages=[{"role": "user", "content": "Hello"}])
print(r.choices[0].message.content)
```

### Anthropic

Endpoint: `/v1/messages`

```bash
curl http://localhost:23411/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: unused" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model": "anthropic/claude-code", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'
```

```python
from anthropic import Anthropic
client = Anthropic(base_url="http://localhost:23411", api_key="unused")
r = client.messages.create(model="anthropic/claude-code", max_tokens=1024, messages=[{"role": "user", "content": "Hello"}])
print(r.content[0].text)
```

### OpenRouter

Endpoints: `/api/v1/chat/completions`, `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/api/v1/generation`, `/api/v1/auth/key`

```bash
curl http://localhost:23411/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "anthropic/claude-code", "messages": [{"role": "user", "content": "Hello"}]}'
```

### Images

All flavors support images. Use the format matching your flavor:

```bash
# OpenAI
curl http://localhost:23411/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "anthropic/claude-code", "messages": [{"role": "user", "content": [
    {"type": "text", "text": "What is this?"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
  ]}]}'

# Anthropic
curl http://localhost:23411/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: unused" -H "anthropic-version: 2023-06-01" \
  -d '{"model": "anthropic/claude-code", "max_tokens": 1024, "messages": [{"role": "user", "content": [
    {"type": "text", "text": "What is this?"},
    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "..."}}
  ]}]}'
```

### Streaming

All flavors support `"stream": true`. OpenAI/OpenRouter use `data: {json}\n\n` format. Anthropic uses `event: type\ndata: {json}\n\n` format.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LOCALCC_FLAVOR` | `openai` | API flavor: `openai`, `anthropic`, `openrouter` |
| `LOCALCC_PORT` | `8686` | HTTP server port inside container |
| `LOCALCC_TIMEOUT` | `120000` | Request timeout in ms |

Change the host port in `compose.yml` under `ports`. To switch flavors, delete `.localcc-flavor` and run `./start.sh` again.

## Project Structure

```
claude-code-as-api/
  start.sh               # Entry point — login, flavor selection, start
  compose.yml             # Docker Compose configuration
  claude/
    Dockerfile            # Container image
    entrypoint.sh         # Startup script (config, socat)
    start-claude.exp      # Expect script to auto-accept prompts
  localcc/
    server.ts             # MCP server + HTTP API gateway
    package.json
    .mcp.json             # MCP server registration
    .claude-plugin/
      plugin.json         # Plugin metadata
```

## Data

Credentials are stored in the `claude-home` Docker volume. To reset everything:

```bash
docker compose down -v
rm .localcc-flavor
```
