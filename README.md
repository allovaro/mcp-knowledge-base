# MCP Knowledge Base Server

Remote MCP server for semantic search across knowledge base collections via N8N + Qdrant. Runs as a Docker container, accessible from Claude Code CLI, Claude Web, and Claude Desktop.

## Architecture

```
Claude Code / Claude Web
        |
        | Streamable HTTP (POST /mcp)
        v
  MCP Server (Express + MCP SDK)
        |
        | HTTP POST
        v
  N8N Webhook --> Qdrant (vector search)
```

- **MCP Server** (`server.mjs`) — Node.js HTTP server, dynamically generates search tools from `config.json`, proxies queries to N8N
- **N8N** — orchestrates search: receives query, calls Qdrant, returns results
- **Qdrant** — vector database, stores document embeddings organized by collections

## Features

- **Remote access** — Streamable HTTP transport, works through any proxy/CDN
- **Dynamic collections** — add new collections via `config.json`, no code changes
- **Collection groups** — isolates unrelated collections (e.g. industrial docs won't mix with personal records)
- **Auth** — Bearer token via header or query parameter
- **Docker** — single container, easy to deploy alongside N8N and Qdrant

## Collections & Groups

Collections are organized into groups. Each collection gets its own search tool, and each group gets a `search_all_<group>` tool.

Example config:
```
industrial:  svghmi, wincc, tia_openness, plc
networking:  keenetic
personal:    medical
```

Generated tools:
- `search_svghmi_docs`, `search_wincc_docs`, `search_tia_openness_docs`, `search_plc_docs`
- `search_all_industrial` (searches all 4 collections above)
- `search_keenetic_docs`, `search_all_networking`
- `search_medical_docs`, `search_all_personal`

Each tool accepts:
- `query` (string, required) — search query
- `top_k` (number, default 5) — number of results

## Setup

### 1. Add to existing Docker Compose

Add to your `docker-compose.yml` `services:` section:

```yaml
  mcp-knowledge-base:
    build: /path/to/mcp-knowledge-base
    container_name: mcp-knowledge-base
    restart: always
    ports:
      - "3100:3100"
    environment:
      - N8N_WEBHOOK_URL=http://n8n:5678/webhook/kb-search
      - AUTH_TOKENS=your-secret-token-here
    volumes:
      - /path/to/config.json:/app/config.json:ro
```

### 2. Generate auth token

```bash
openssl rand -hex 32
```

### 3. Connect Claude Code CLI

```bash
claude mcp add -t http -s user \
  knowledge-base https://your-server.example.com/mcp \
  -H "Authorization: Bearer <your-token>"
```

### 4. Connect Claude Web / Claude Desktop

Add custom connector with URL:
```
https://your-server.example.com/mcp?token=<your-token>
```

## Configuration

### config.json

```json
{
  "server": { "port": 3100, "host": "0.0.0.0" },
  "auth": { "tokens": ["CHANGE-ME-your-secret-token-here"] },
  "n8n": { "webhook_url": "http://localhost:5678/webhook/kb-search" },
  "groups": {
    "industrial": { "description": "Industrial automation, SCADA, PLC, HMI" },
    "networking": { "description": "Network equipment, routers" }
  },
  "collections": [
    {
      "id": "wincc",
      "group": "industrial",
      "description": "Search WinCC Unified documentation...",
      "qdrant_collection": "wincc"
    }
  ]
}
```

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `N8N_WEBHOOK_URL` | N8N webhook endpoint | from config.json |
| `AUTH_TOKENS` | Comma-separated auth tokens | from config.json |
| `PORT` | Server port | 3100 |
| `HOST` | Bind address | 0.0.0.0 |
| `CONFIG_PATH` | Path to config.json | ./config.json |

### Adding a new collection

1. Create the Qdrant collection and load documents via N8N
2. Add entry to `config.json`:
   ```json
   {
     "id": "my_docs",
     "group": "my_group",
     "description": "Description for Claude to know when to use this tool",
     "qdrant_collection": "my_docs"
   }
   ```
3. Restart the container — new tools appear automatically

## N8N Webhook Protocol

**Request** (POST JSON):
```json
{
  "query": "how to create a widget",
  "category": "svghmi",
  "top_k": 5
}
```

For group searches:
```json
{
  "query": "timer instruction",
  "category": "multi",
  "collections": ["wincc", "plc"],
  "top_k": 5
}
```

**Response** — one of:
```json
// Array (direct Qdrant output)
[{ "document": { "pageContent": "...", "metadata": {} }, "score": 0.87 }]

// Wrapped format
{ "success": true, "results": [...] }

// Error
{ "success": false, "error": "error description" }
```

## Deploy on OpenMediaVault (OMV)

OMV with omv-extras Docker/Compose plugin.

### File structure on OMV

```
/config/mcp-knowledge-base/       # Project sources (Dockerfile, server.mjs, etc.)
/docker-data/mcp-knowledge-base/  # Persistent data (config.json)
```

### Steps

1. **Copy project files** to OMV:
   ```bash
   scp -P <ssh-port> -r ./* user@omv-server:/config/mcp-knowledge-base/
   ```

2. **Copy config to data volume**:
   ```bash
   cp /config/mcp-knowledge-base/config.json /docker-data/mcp-knowledge-base/config.json
   ```

3. **Edit config** (`/docker-data/mcp-knowledge-base/config.json`) — set your collections, groups, descriptions

4. **Add service** to your existing N8N docker-compose (so they share the same network):
   ```yaml
     mcp-knowledge-base:
       build: /config/mcp-knowledge-base
       container_name: mcp-knowledge-base
       restart: always
       ports:
         - "3100:3100"
       environment:
         - N8N_WEBHOOK_URL=http://n8n:5678/webhook/kb-search
         - AUTH_TOKENS=<your-token>
       volumes:
         - /docker-data/mcp-knowledge-base/config.json:/app/config.json:ro
   ```

5. In **OMV Web UI** → **Services** → **Compose** → select the stack → **Build**, then **Up**

6. Verify: open `http://OMV-IP:3100/health` in browser

### Updating

- **Config change** (new collection): edit `/docker-data/mcp-knowledge-base/config.json`, restart container
- **Code change** (server.mjs): copy new file to `/config/mcp-knowledge-base/`, then **Build** + **Down** + **Up** in Compose

### External access

If using Keenetic KeenDNS — set domain to **direct connection** mode (not "through cloud"), as cloud mode may buffer/break HTTP streaming. Alternatively, use standard port forwarding.

## Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | No | Health check, lists collections and groups |
| `/mcp` | POST | Yes | MCP Streamable HTTP (initialize + requests) |
| `/mcp` | GET | Yes | MCP SSE stream (server notifications) |
| `/mcp` | DELETE | Yes | Close MCP session |
