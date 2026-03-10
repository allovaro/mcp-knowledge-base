#!/usr/bin/env node

/**
 * MCP Server: Knowledge Base Search
 * 
 * Connects Claude Code to your N8N-powered knowledge base.
 * 
 * Setup:
 *   npm install @modelcontextprotocol/sdk
 *   
 * Add to .claude/settings.json:
 *   {
 *     "mcpServers": {
 *       "knowledge-base": {
 *         "command": "node",
 *         "args": ["/path/to/mcp-kb-server.mjs"],
 *         "env": {
 *           "N8N_WEBHOOK_URL": "https://your-n8n.example.com/webhook/kb-search"
 *         }
 *       }
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "http://localhost:5678/webhook/kb-search";

const server = new Server(
  {
    name: "knowledge-base",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_svghmi_docs",
      description:
        "Search the svghmi.pro knowledge base for information about SVG to SVGHMI conversion, " +
        "widget development, marketplace products, converter features, CustomWebControl, " +
        "and svghmi.pro business/product documentation.",
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
    },
    {
      name: "search_wincc_docs",
      description:
        "Search WinCC Unified documentation for information about HMI development, " +
        "TIA Portal, PLC programming (S7-1200/1500), SCADA systems, " +
        "WinCC configuration, scripting, and Siemens industrial automation.",
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
    },
    {
      name: "search_tia_openness_docs",
      description:
        "Search TIA Portal Openness documentation for information about .NET API for programmatic " +
        "control of TIA Portal, automating project creation, PLC/HMI configuration via code, " +
        "Siemens.Engineering DLL libraries, export/import of blocks, screens, and tags.",
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
    },
    {
      name: "search_all_docs",
      description:
        "Search across ALL knowledge base documents (svghmi.pro, WinCC Unified, and TIA Openness). " +
        "Use this when the query spans multiple domains or you're unsure which category to search.",
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
    },
  ],
}));

async function searchKnowledgeBase(query, category = "all", topK = 5) {
  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        category,
        top_k: topK,
      }),
    });

    if (!response.ok) {
      throw new Error(`N8N webhook returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    // Handle both formats:
    // 1. Raw array from N8N webhook (direct Qdrant output)
    // 2. Wrapped format { success: true, results: [...] }
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
      return `No results found for query: "${query}" in category: ${category}`;
    }

    const formatted = results.map((result, i) => {
      // Handle various N8N Qdrant output formats
      const content = result.document?.pageContent || result.pageContent || result.text || JSON.stringify(result);
      const metadata = result.document?.metadata || result.metadata || {};
      const source = metadata.source || metadata.file_name || (metadata.loc?.lines ? `lines ${metadata.loc.lines.from}-${metadata.loc.lines.to}` : "unknown");
      const score = result.score ? ` (relevance: ${(result.score * 100).toFixed(1)}%)` : "";
      
      return `--- Result ${i + 1}${score} ---\nSource: ${source}\n\n${content}`;
    });

    return `Found ${results.length} results for "${query}":\n\n${formatted.join("\n\n")}`;
  } catch (error) {
    return `Error searching knowledge base: ${error.message}. Make sure N8N is running and the search workflow is active.`;
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const categoryMap = {
    search_svghmi_docs: "svghmi",
    search_wincc_docs: "wincc",
    search_tia_openness_docs: "tia_openness",
    search_all_docs: "all",
  };

  const category = categoryMap[name];
  if (!category) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  const result = await searchKnowledgeBase(
    args.query,
    category,
    args.top_k || 5
  );

  return {
    content: [{ type: "text", text: result }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Knowledge Base MCP server running");
