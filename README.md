# MCP Knowledge Base Server

Remote MCP server for semantic search across knowledge base collections via N8N + Qdrant. Runs as a Docker container, accessible from Claude Code CLI, Claude Web, and Claude Desktop.

**Server URL:** `https://mcp.sokolovy-home.crazedns.ru/mcp`

## Architecture

```
Claude Code / Claude Web
        |
        | Streamable HTTP (POST /mcp)
        v
  MCP Server (Express + MCP SDK)
        |
        | HTTP POST (collection + category)
        v
  N8N Webhook --> Qdrant (vector search)
```

- **MCP Server** (`server.mjs`) — Node.js HTTP server, dynamically generates search tools from `config.json`, sends `collection` and optional `category` to N8N
- **N8N** — orchestrates search: receives query with collection name, calls Qdrant, returns results
- **Qdrant** — vector database, stores document embeddings. Supports both standalone collections (e.g. `keenetic_cli`) and shared collections with category filtering (e.g. `knowledge_base` with categories `wincc`, `svghmi`, etc.)

## Features

- **Remote access** — Streamable HTTP transport, works through any proxy/CDN
- **Dynamic collections** — add new collections via `config.json`, no code changes
- **Collection groups** — isolates unrelated collections (e.g. industrial docs won't mix with personal records)
- **Mixed Qdrant architecture** — standalone collections + shared collections with `metadata.category` filtering
- **Auth** — Bearer token via header or query parameter
- **Docker** — single container, easy to deploy alongside N8N and Qdrant

## Collections & Groups

Collections are organized into groups. Each collection gets its own search tool, and each group gets a `search_all_<group>` tool.

Two types of collections:
- **Standalone** — separate Qdrant collection, no category (e.g. `keenetic_cli`)
- **Shared with category** — one Qdrant collection, filtered by `metadata.category` (e.g. `knowledge_base` with `wincc`, `svghmi`, `plc_instructions`, `tia_openness`)

Example config:
```
industrial:  svghmi, wincc, tia_openness, plc  (all in Qdrant "knowledge_base", filtered by category)
networking:  keenetic                           (standalone Qdrant collection "keenetic_cli")
personal:    medical_cirill, medical_yuliya     (Qdrant "medical", filtered by category)
```

Generated tools:
- `search_svghmi_docs`, `search_wincc_docs`, `search_tia_openness_docs`, `search_plc_docs`
- `search_all_industrial` (searches all 4 above)
- `search_keenetic_docs`, `search_all_networking`

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
  knowledge-base https://mcp.sokolovy-home.crazedns.ru/mcp \
  -H "Authorization: Bearer <your-token>"
```

### 4. Connect Claude Web / Claude Desktop

Add custom connector with URL:
```
https://mcp.sokolovy-home.crazedns.ru/mcp?token=<your-token>
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
      "qdrant_collection": "knowledge_base",
      "category": "wincc",
      "description": "Search WinCC Unified documentation..."
    },
    {
      "id": "keenetic",
      "group": "networking",
      "qdrant_collection": "keenetic_cli",
      "description": "Search Keenetic router CLI commands..."
    }
  ]
}
```

Collection fields:
- `id` — unique identifier, used to generate tool name (`search_<id>_docs`)
- `group` — which group this collection belongs to
- `qdrant_collection` — actual Qdrant collection name
- `category` (optional) — filter by `metadata.category` within shared Qdrant collection
- `description` — description shown to Claude to decide when to use this tool

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `N8N_WEBHOOK_URL` | N8N webhook endpoint | from config.json |
| `AUTH_TOKENS` | Comma-separated auth tokens | from config.json |
| `PORT` | Server port | 3100 |
| `HOST` | Bind address | 0.0.0.0 |
| `CONFIG_PATH` | Path to config.json | ./config.json |

### Adding a new collection

**Standalone collection** (separate Qdrant collection, no category):

1. In N8N, load documents into Qdrant with collection name `vpn` (no metadata category needed)
2. Add to `config.json`:
   ```json
   {
     "id": "vpn",
     "group": "networking",
     "qdrant_collection": "vpn",
     "description": "VPN configuration, WireGuard, OpenVPN, proxy setup"
   }
   ```
3. Restart container

**Shared collection with category** (e.g. adding a person to existing `medical` collection):

1. In N8N, load documents into Qdrant collection `medical` with metadata `category: cirill`
2. Add to `config.json`:
   ```json
   {
     "id": "medical_cirill",
     "group": "personal",
     "qdrant_collection": "medical",
     "category": "cirill",
     "description": "Medical records and test results for Cirill"
   }
   ```
3. Restart container

## N8N Webhook Protocol

**Request** (POST JSON):

Single collection search:
```json
{
  "query": "show interface",
  "collection": "keenetic_cli",
  "top_k": 5
}
```

Single collection with category filter:
```json
{
  "query": "how to create a widget",
  "collection": "knowledge_base",
  "category": "svghmi",
  "top_k": 5
}
```

Group search (multiple targets):
```json
{
  "query": "timer instruction",
  "targets": [
    { "collection": "knowledge_base", "category": "wincc" },
    { "collection": "knowledge_base", "category": "plc_instructions" }
  ],
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

### N8N Workflow Setup

The webhook workflow consists of 3 nodes: **Webhook** → **Code in JavaScript** → **Qdrant Vector Store**

**Code node** (processes incoming request):
```javascript
const body = $input.first().json.body;

const output = {
  query: body.query,
  collection: body.collection || 'knowledge_base',
  top_k: body.top_k || 4,
  filter: body.category
    ? { must: [{ key: "metadata.category", match: { value: body.category } }] }
    : {}
};

return [{ json: output }];
```

**Qdrant Vector Store** node settings (all with `fx` expression mode enabled):
- **Collection**: `{{ $json.collection }}`
- **Prompt**: `{{ $json.query }}`
- **Limit**: `{{ $json.top_k }}`
- **Search Filter**: `{{ JSON.stringify($json.filter) }}`

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

6. Verify: open `https://mcp.sokolovy-home.crazedns.ru/health` in browser

### Updating

- **Config change** (new collection): edit `/docker-data/mcp-knowledge-base/config.json`, restart container
- **Code change** (server.mjs): copy new file to `/config/mcp-knowledge-base/`, then **Build** + **Down** + **Up** in Compose

### External access

Uses Keenetic KeenDNS with direct connection mode for domain `mcp.sokolovy-home.crazedns.ru`.

## Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | No | Health check, lists collections and groups |
| `/mcp` | POST | Yes | MCP Streamable HTTP (initialize + requests) |
| `/mcp` | GET | Yes | MCP SSE stream (server notifications) |
| `/mcp` | DELETE | Yes | Close MCP session |
