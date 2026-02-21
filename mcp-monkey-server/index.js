#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────
const WS_PORT = parseInt(process.env.MCP_MONKEY_PORT || "8765", 10);
const EXECUTION_TIMEOUT_MS = 30_000; // 30 seconds

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────

/** @type {Map<string, { description: string, urlPattern: string, code: string }>} */
const scriptRegistry = new Map();

/** @type {Map<string, import('@modelcontextprotocol/sdk/server/mcp.js').RegisteredTool>} */
const toolHandles = new Map();

/** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
const pendingRequests = new Map();

/** @type {WebSocket | null} */
let extensionSocket = null;

// ─────────────────────────────────────────────────────────────
// MCP Server
// ─────────────────────────────────────────────────────────────
const mcpServer = new McpServer(
  {
    name: "mcp-monkey",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: { listChanged: true },
      logging: {},
    },
  }
);

// ─────────────────────────────────────────────────────────────
// Dynamic Tool Registration
// ─────────────────────────────────────────────────────────────

/**
 * Register (or update) a script as a callable MCP tool.
 */
function registerScriptAsTool(name, description, urlPattern, code) {
  // Store in our registry
  scriptRegistry.set(name, { description, urlPattern, code });

  // Create a safe tool name (lowercase, hyphens)
  const toolName = `monkey_${name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()}`;

  // If a tool with this name already exists, remove it first
  const existingHandle = toolHandles.get(toolName);
  if (existingHandle) {
    try {
      existingHandle.remove();
    } catch {
      // Ignore errors from removing non-existent tools
    }
  }

  // Register the tool with the MCP server and store the handle
  const handle = mcpServer.registerTool(
    toolName,
    {
      description: `[MCP-Monkey] ${description}\n\nTarget URL: ${urlPattern}`,
      inputSchema: {
        args: z
          .string()
          .optional()
          .describe(
            "Optional JSON string of arguments to pass to the script"
          ),
      },
    },
    async ({ args }) => {
      return executeScriptInBrowser(name, args);
    }
  );

  toolHandles.set(toolName, handle);
  log(`Registered tool: ${toolName} → "${name}"`);
}

/**
 * Remove a script tool from the registry.
 */
function unregisterScript(name) {
  const toolName = `monkey_${name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()}`;
  scriptRegistry.delete(name);

  // Use the stored RegisteredTool handle to remove the tool
  const handle = toolHandles.get(toolName);
  if (handle) {
    try {
      handle.remove();
    } catch {
      // Silently skip if removal fails
    }
    toolHandles.delete(toolName);
  }

  log(`Unregistered tool: ${toolName}`);
}

/**
 * Notify the MCP client that the tool list has changed.
 */
function notifyToolsChanged() {
  try {
    mcpServer.sendToolListChanged();
    log("Sent notifications/tools/list_changed to MCP client");
  } catch (err) {
    log(`Warning: Could not send tool list changed notification: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Script Execution
// ─────────────────────────────────────────────────────────────

/**
 * Send a script execution request to the browser extension
 * and wait for the result.
 */
function executeScriptInBrowser(scriptName, args) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      resolve({
        content: [
          {
            type: "text",
            text: "Error: Chrome extension is not connected. Please ensure MCP-Monkey extension is running and connected.",
          },
        ],
        isError: true,
      });
      return;
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Set up timeout
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({
        content: [
          {
            type: "text",
            text: `Error: Script execution timed out after ${EXECUTION_TIMEOUT_MS / 1000}s`,
          },
        ],
        isError: true,
      });
    }, EXECUTION_TIMEOUT_MS);

    // Store the pending request
    pendingRequests.set(requestId, { resolve, reject, timer });

    // Send execution request to the extension
    const script = scriptRegistry.get(scriptName);
    extensionSocket.send(
      JSON.stringify({
        type: "execute_script",
        requestId,
        scriptName,
        code: script?.code || "",
        urlPattern: script?.urlPattern || "",
        args: args || "",
      })
    );

    log(`Sent execute_script request: ${requestId} → "${scriptName}"`);
  });
}

// ─────────────────────────────────────────────────────────────
// WebSocket Server (for Chrome Extension)
// ─────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });

wss.on("listening", () => {
  log(`WebSocket server listening on ws://localhost:${WS_PORT}`);
});

wss.on("connection", (ws) => {
  log("Chrome extension connected via WebSocket");
  extensionSocket = ws;

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log("Received invalid JSON from extension");
      return;
    }

    switch (msg.type) {
      case "register_script": {
        const { name, description, urlPattern, code } = msg;
        registerScriptAsTool(name, description, urlPattern, code);
        await notifyToolsChanged();
        ws.send(JSON.stringify({ type: "script_registered", name }));
        break;
      }

      case "unregister_script": {
        const { name } = msg;
        unregisterScript(name);
        await notifyToolsChanged();
        ws.send(JSON.stringify({ type: "script_unregistered", name }));
        break;
      }

      case "scripts_sync": {
        // Bulk registration of all scripts on connect
        const { scripts } = msg;
        if (Array.isArray(scripts)) {
          for (const script of scripts) {
            registerScriptAsTool(
              script.name,
              script.description,
              script.urlPattern,
              script.code
            );
          }
          if (scripts.length > 0) {
            await notifyToolsChanged();
          }
          log(`Synced ${scripts.length} script(s) from extension`);
        }
        break;
      }

      case "execution_result": {
        const { requestId, result, error } = msg;
        const pending = pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(requestId);

          if (error) {
            pending.resolve({
              content: [
                {
                  type: "text",
                  text: `Script execution error: ${error}`,
                },
              ],
              isError: true,
            });
          } else {
            pending.resolve({
              content: [
                {
                  type: "text",
                  text:
                    typeof result === "string"
                      ? result
                      : JSON.stringify(result, null, 2),
                },
              ],
            });
          }
          log(`Received execution result for: ${requestId}`);
        }
        break;
      }

      case "pong": {
        // Keepalive response — no action needed
        break;
      }

      default:
        log(`Unknown message type from extension: ${msg.type}`);
    }
  });

  ws.on("close", () => {
    log("Chrome extension disconnected");
    if (extensionSocket === ws) {
      extensionSocket = null;
    }
  });

  ws.on("error", (err) => {
    log(`WebSocket error: ${err.message}`);
  });
});

wss.on("error", (err) => {
  log(`WebSocket server error: ${err.message}`);
});

// ─────────────────────────────────────────────────────────────
// Logging (to stderr so it doesn't pollute MCP stdio)
// ─────────────────────────────────────────────────────────────
function log(message) {
  process.stderr.write(`[mcp-monkey] ${message}\n`);
}

// ─────────────────────────────────────────────────────────────
// Start MCP Server (stdio transport)
// ─────────────────────────────────────────────────────────────
async function main() {
  log("Starting MCP-Monkey server...");

  // Register a built-in status tool
  mcpServer.registerTool(
    "mcp_monkey_status",
    {
      description:
        "Check the status of the MCP-Monkey bridge. Returns connection state and list of available browser scripts.",
      inputSchema: {},
    },
    async () => {
      const connected =
        extensionSocket !== null &&
        extensionSocket.readyState === WebSocket.OPEN;
      const scripts = Array.from(scriptRegistry.entries()).map(
        ([name, info]) => ({
          name,
          description: info.description,
          urlPattern: info.urlPattern,
        })
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                extensionConnected: connected,
                registeredScripts: scripts,
                wsPort: WS_PORT,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Connect MCP over stdio
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log("MCP server connected via stdio");
  log(`Waiting for Chrome extension on ws://localhost:${WS_PORT}...`);
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
