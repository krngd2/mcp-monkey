# 🐒 MCP-Monkey

**Bridge AI coding agents to your Chrome browser via the Model Context Protocol.**

MCP-Monkey lets you define custom JavaScript functions that run inside your authenticated browser sessions — and exposes them as callable tools to any MCP-compatible AI agent (Cursor, Windsurf, Claude Desktop, etc.). Think of it as [Tampermonkey](https://www.tampermonkey.net/) meets [MCP](https://modelcontextprotocol.io/).

---

## Why?

AI coding agents can't see what's on your screen. If you need an agent to check a deployment status on RunPod, read a Jira ticket, or scrape data from an internal dashboard, it simply can't — those pages require your login session.

MCP-Monkey solves this by letting you write small JavaScript snippets that run **in your actual browser tabs**, with your cookies and auth already present. The agent calls a tool, the script executes in the matching tab, and the result flows back.

---

## Architecture

```
┌──────────────┐      stdio (MCP)      ┌──────────────────┐    WebSocket     ┌─────────────────────┐
│   AI Agent   │ ◄──────────────────► │  MCP-Monkey      │ ◄─────────────► │  Chrome Extension    │
│ (Cursor, etc)│                       │  Server (Node.js)│    ws://8765    │  (Manifest V3)       │
└──────────────┘                       └──────────────────┘                 └──────────┬──────────┘
                                                                                       │
                                                                           chrome.scripting
                                                                           .executeScript()
                                                                                       │
                                                                                       ▼
                                                                           ┌──────────────────────┐
                                                                           │  Your Browser Tab     │
                                                                           │  (with auth cookies)  │
                                                                           └──────────────────────┘
```

---

## Monorepo Structure

```
mcp-monkey/
├── mcp-monkey-server/      # Node.js MCP server
│   ├── index.js            # Server entry point — MCP + WebSocket
│   └── package.json
└── mcp-monkey-extension/   # Chrome extension (Manifest V3)
    ├── manifest.json
    ├── background.js        # Service worker — WS client + script execution
    ├── popup.html           # Extension popup UI
    ├── popup.js             # Popup logic — script CRUD
    ├── popup.css            # Popup styles
    └── icons/               # Extension icons
```

---

## Setup

### Prerequisites

- **Node.js** ≥ 18
- **Chrome** ≥ 116

### 1. Install & start the MCP server

```bash
cd mcp-monkey-server
npm install
```

Then register the server in your AI agent's MCP config. For example, in **Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "mcp-monkey": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-monkey-server/index.js"]
    }
  }
}
```

> The server communicates with the AI agent over **stdio** and with the Chrome extension over **WebSocket** (`ws://localhost:8765`).

### 2. Load the Chrome extension

1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `mcp-monkey-extension/` folder.
4. The MCP-Monkey icon (🐒) should appear in your toolbar.

### 3. Verify the connection

Once both the server is running (started by your agent) and the extension is loaded, the extension popup badge should show **Connected** (green).

You can also ask your AI agent:
> "Check the MCP-Monkey status."

It will call the built-in `mcp_monkey_status` tool and report connection state + registered scripts.

---

## Usage

### Adding a script via the extension popup

1. Click the 🐒 extension icon in Chrome.
2. Fill in the form:
   - **Name** — unique identifier (letters, numbers, hyphens, underscores)
   - **Description** — what the script does (this becomes part of the tool description the AI sees)
   - **URL Pattern** — a Chrome match pattern like `*://github.com/*`
   - **JavaScript Code** — the code that will execute in the page. Use `args` to read agent-supplied arguments and `return` a value.
3. Click **Save Script**.

The script is immediately registered as an MCP tool prefixed with `monkey_` (e.g., `monkey_check-deployment`).

### Example script

**Name:** `github-pr-info`
**Description:** Get the title, status, and review state of the currently open GitHub PR.
**URL Pattern:** `*://github.com/*/pull/*`
**Code:**

```javascript
const title = document.querySelector('[data-target="issue-header.title"]')?.textContent?.trim();
const state = document.querySelector('.State')?.textContent?.trim();
return JSON.stringify({ title, state });
```

An AI agent can now call this tool to read PR details from whichever GitHub PR tab you have open.

### Calling tools from your AI agent

The AI agent automatically sees all registered MCP-Monkey tools. You can prompt it naturally:

> "Check my RunPod deployment status."

The agent will pick the right `monkey_*` tool, execute it against a matching browser tab, and show you the result.

---

## Configuration

| Variable            | Default | Description                                |
| ------------------- | ------- | ------------------------------------------ |
| `MCP_MONKEY_PORT`   | `8765`  | WebSocket port (set as env var on server)   |

---

## How It Works — Data Flow

1. **Agent calls a tool** → MCP server receives the request over stdio.
2. **Server sends `execute_script`** → WebSocket message to the Chrome extension.
3. **Extension finds a matching tab** → Uses the script's URL pattern to locate the right tab.
4. **Script runs in the page's MAIN world** → `chrome.scripting.executeScript()` with full DOM + cookie access.
5. **Result is sent back** → Extension → WebSocket → MCP server → Agent.

Scripts support `async/await` and have a **30-second execution timeout**.

---

## Default Scripts

On first install, the extension ships with a sample **RunPod Status** script that parses deployment status from the RunPod dashboard. You can delete it or use it as a reference for writing your own.

---

## License

MIT

