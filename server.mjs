#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Load config ---
const configPath = process.env.CONFIG_PATH || join(__dirname, "config.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));

const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL || config.n8n.webhook_url;
const AUTH_TOKENS = new Set(
  process.env.AUTH_TOKENS
    ? process.env.AUTH_TOKENS.split(",")
    : config.auth.tokens
);
const PORT = parseInt(process.env.PORT || config.server.port, 10);
const HOST = process.env.HOST || config.server.host;

// --- Build tools from config ---
function buildTools(collections, groups) {
  const tools = [];

  for (const col of collections) {
    tools.push({
      name: `search_${col.id}_docs`,
      description: col.description,
      _meta: {
        collection: col.qdrant_collection,
        category: col.category || null,
      },
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query describing what you're looking for",
          },
          top_k: {
            type: "number",
            description: "Number of results to return (default: 5)",
            default: 5,
          },
        },
        required: ["query"],
      },
    });
  }

  // Per-group "search all in group" tools
  const groupCollections = {};
  for (const col of collections) {
    if (!groupCollections[col.group]) groupCollections[col.group] = [];
    groupCollections[col.group].push({
      collection: col.qdrant_collection,
      category: col.category || null,
    });
  }

  for (const [groupId, groupMeta] of Object.entries(groups)) {
    const cols = groupCollections[groupId];
    if (!cols || cols.length === 0) continue;

    const colNames = [...new Set(cols.map((c) => c.collection))];
    tools.push({
      name: `search_all_${groupId}`,
      description:
        `Search across ALL collections in the "${groupId}" group: ${colNames.join(", ")}. ` +
        groupMeta.description +
        ". Use when the query may span multiple collections within this group.",
      _meta: { targets: cols },
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query describing what you're looking for",
          },
          top_k: {
            type: "number",
            description: "Number of results to return (default: 5)",
            default: 5,
          },
        },
        required: ["query"],
      },
    });
  }

  return tools;
}

const tools = buildTools(config.collections, config.groups);

// Build lookup: tool name -> meta
const toolMetaMap = {};
for (const t of tools) {
  toolMetaMap[t.name] = t._meta;
}

function publicTools() {
  return tools.map(({ _meta, ...rest }) => rest);
}

// --- Search logic ---
async function searchKnowledgeBase(query, meta, topK = 5) {
  try {
    const body = { query, top_k: topK };

    if (meta.targets) {
      // Group search — multiple collections/categories
      body.targets = meta.targets;
    } else {
      body.collection = meta.collection;
      if (meta.category) {
        body.category = meta.category;
      }
    }

    const response = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `N8N webhook returned ${response.status}: ${response.statusText}`
      );
    }

    const data = await response.json();

    let results;
    if (Array.isArray(data)) {
      results = data;
    } else if (data.success && data.results) {
      results = data.results;
    } else if (data.success === false) {
      throw new Error(data.error || "Search failed");
    } else {
      results = [data];
    }

    if (!results || results.length === 0) {
      return `No results found for query: "${query}"`;
    }

    const formatted = results.map((result, i) => {
      const content =
        result.document?.pageContent ||
        result.pageContent ||
        result.text ||
        JSON.stringify(result);
      const metadata = result.document?.metadata || result.metadata || {};
      const source =
        metadata.source ||
        metadata.file_name ||
        (metadata.loc?.lines
          ? `lines ${metadata.loc.lines.from}-${metadata.loc.lines.to}`
          : "unknown");
      const score = result.score
        ? ` (relevance: ${(result.score * 100).toFixed(1)}%)`
        : "";

      return `--- Result ${i + 1}${score} ---\nSource: ${source}\n\n${content}`;
    });

    return `Found ${results.length} results for "${query}":\n\n${formatted.join("\n\n")}`;
  } catch (error) {
    return `Error searching knowledge base: ${error.message}. Make sure N8N is running and the search workflow is active.`;
  }
}

// --- Express + Streamable HTTP ---
const app = express();
// Don't parse JSON for /mcp — StreamableHTTPServerTransport handles it
app.use((req, res, next) => {
  if (req.path === "/mcp") return next();
  express.json()(req, res, next);
});

// Auth middleware
function authMiddleware(req, res, next) {
  if (AUTH_TOKENS.size === 1 && AUTH_TOKENS.has("CHANGE-ME-your-secret-token-here")) {
    return next();
  }

  // Accept token from header or query parameter
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token;
  let token;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (queryToken) {
    token = queryToken;
  }

  if (!token || !AUTH_TOKENS.has(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// Health check (no auth)
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    collections: config.collections.map((c) => c.id),
    groups: Object.keys(config.groups),
  });
});

// Sessions store
const sessions = new Map();

function createMCPServer() {
  const server = new Server(
    { name: "knowledge-base", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: publicTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const meta = toolMetaMap[name];
    if (!meta) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const result = await searchKnowledgeBase(
      args.query,
      meta,
      args.top_k || 5
    );

    return {
      content: [{ type: "text", text: result }],
    };
  });

  return server;
}

// Streamable HTTP endpoint - handles POST, GET, DELETE on /mcp
app.post("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  // Existing session
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    await session.transport.handleRequest(req, res);
    return;
  }

  // New session - only for initialize requests
  if (sessionId && !sessions.has(sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // No session ID = new connection
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      sessions.set(newSessionId, { transport, server });
    },
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) sessions.delete(sid);
  };

  const server = createMCPServer();
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.get("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "Missing or invalid session ID" });
    return;
  }
  const session = sessions.get(sessionId);
  await session.transport.handleRequest(req, res);
});

app.delete("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const session = sessions.get(sessionId);
  await session.transport.handleRequest(req, res);
  sessions.delete(sessionId);
});

app.listen(PORT, HOST, () => {
  console.log(`MCP Knowledge Base server running on http://${HOST}:${PORT}`);
  console.log(`Streamable HTTP endpoint: http://${HOST}:${PORT}/mcp`);
  console.log(`Collections: ${config.collections.map((c) => c.id).join(", ")}`);
  console.log(`Groups: ${Object.keys(config.groups).join(", ")}`);
});
