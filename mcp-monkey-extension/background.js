// ─────────────────────────────────────────────────────────────
// MCP-Monkey Background Service Worker
// Maintains WebSocket connection to the local MCP-Monkey server
// ─────────────────────────────────────────────────────────────

const WS_URL = "ws://localhost:8765";
const HEARTBEAT_INTERVAL_MS = 20_000; // 20s keepalive
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let ws = null;
let heartbeatTimer = null;
let reconnectAttempt = 0;
let isConnected = false;

// ─────────────────────────────────────────────────────────────
// WebSocket Connection
// ─────────────────────────────────────────────────────────────

function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return;
    }

    console.log("[MCP-Monkey] Connecting to server:", WS_URL);

    try {
        ws = new WebSocket(WS_URL);
    } catch (err) {
        console.error("[MCP-Monkey] WebSocket constructor error:", err);
        scheduleReconnect();
        return;
    }

    ws.onopen = async () => {
        console.log("[MCP-Monkey] Connected to server");
        isConnected = true;
        reconnectAttempt = 0;
        startHeartbeat();

        // Sync all saved scripts on connect
        await syncAllScripts();
    };

    ws.onmessage = async (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            console.error("[MCP-Monkey] Invalid JSON from server");
            return;
        }

        switch (msg.type) {
            case "execute_script":
                await handleExecuteScript(msg);
                break;

            case "script_registered":
                console.log(`[MCP-Monkey] Server confirmed registration: ${msg.name}`);
                break;

            case "script_unregistered":
                console.log(`[MCP-Monkey] Server confirmed unregistration: ${msg.name}`);
                break;

            case "ping":
                ws.send(JSON.stringify({ type: "pong" }));
                break;

            default:
                console.log("[MCP-Monkey] Unknown message type:", msg.type);
        }
    };

    ws.onclose = () => {
        console.log("[MCP-Monkey] Disconnected from server");
        isConnected = false;
        stopHeartbeat();
        scheduleReconnect();
    };

    ws.onerror = (err) => {
        console.error("[MCP-Monkey] WebSocket error:", err);
    };
}

// ─────────────────────────────────────────────────────────────
// Heartbeat (keeps MV3 service worker alive)
// ─────────────────────────────────────────────────────────────

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "pong" }));
        }
    }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

// ─────────────────────────────────────────────────────────────
// Reconnection with exponential backoff
// ─────────────────────────────────────────────────────────────

function scheduleReconnect() {
    const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt),
        RECONNECT_MAX_MS
    );
    reconnectAttempt++;
    console.log(`[MCP-Monkey] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
    setTimeout(connect, delay);
}

// ─────────────────────────────────────────────────────────────
// Script Sync
// ─────────────────────────────────────────────────────────────

async function syncAllScripts() {
    const data = await chrome.storage.local.get("scripts");
    const scripts = data.scripts || [];

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
            JSON.stringify({
                type: "scripts_sync",
                scripts: scripts.map((s) => ({
                    name: s.name,
                    description: s.description,
                    urlPattern: s.urlPattern,
                    code: s.code,
                })),
            })
        );
        console.log(`[MCP-Monkey] Synced ${scripts.length} scripts to server`);
    }
}

// ─────────────────────────────────────────────────────────────
// Script Execution
// ─────────────────────────────────────────────────────────────

async function handleExecuteScript(msg) {
    const { requestId, scriptName, code, urlPattern, args } = msg;

    try {
        // Find a tab matching the URL pattern
        const tab = await findMatchingTab(urlPattern);

        if (!tab) {
            sendResult(requestId, null, `No open tab matches the URL pattern: ${urlPattern}. Please open the target page first.`);
            return;
        }

        // Execute the script in the matching tab's MAIN world
        // (avoids MV3 extension CSP that blocks new Function / eval)
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: executeInPage,
            args: [code, args],
        });

        const result = results?.[0]?.result;

        if (result && result.error) {
            sendResult(requestId, null, result.error);
        } else {
            sendResult(requestId, result?.value ?? "Script executed (no return value)");
        }
    } catch (err) {
        console.error("[MCP-Monkey] Execution error:", err);
        sendResult(requestId, null, `Execution failed: ${err.message}`);
    }
}

/**
 * This function runs IN the page's MAIN world via chrome.scripting.executeScript.
 * It tries direct eval first, then falls back to <script> element injection
 * for pages with strict CSP.
 */
function executeInPage(code, args) {
    // Parse args
    let parsedArgs;
    try {
        parsedArgs = args ? JSON.parse(args) : {};
    } catch {
        parsedArgs = args;
    }

    // Strategy 1: Direct eval via new Function (works if page allows unsafe-eval)
    try {
        const fn = new Function("args", `return (async function(args) { ${code} })(args)`);
        const resultPromise = fn(parsedArgs);

        if (resultPromise && typeof resultPromise.then === "function") {
            return resultPromise
                .then((value) => ({ value: typeof value === "undefined" ? "Script executed successfully" : value }))
                .catch((err) => ({ error: err.message || String(err) }));
        }

        return { value: resultPromise ?? "Script executed successfully" };
    } catch (directError) {
        // If not a CSP error, report it immediately
        if (!directError.message || !directError.message.includes("Content Security Policy")) {
            return { error: directError.message || String(directError) };
        }
    }

    // Strategy 2: <script> element injection (works if page allows inline scripts)
    return new Promise((resolve) => {
        const callbackId = "__mcpMonkey_" + Math.random().toString(36).substr(2, 9);

        // Set up a callback on window so the injected script can return results
        window[callbackId] = (result) => {
            delete window[callbackId];
            resolve(result);
        };

        const wrappedCode = `
            (async () => {
                try {
                    const args = ${JSON.stringify(parsedArgs)};
                    const result = await (async function(args) { ${code} })(args);
                    window['${callbackId}']({ value: result === undefined ? 'Script executed successfully' : result });
                } catch(e) {
                    window['${callbackId}']({ error: e.message || String(e) });
                }
            })();
        `;

        const script = document.createElement("script");
        script.textContent = wrappedCode;
        document.documentElement.appendChild(script);
        script.remove();

        // Safety timeout in case CSP blocked the inline script silently
        setTimeout(() => {
            if (window[callbackId]) {
                delete window[callbackId];
                resolve({ error: "Script execution blocked by Content Security Policy. This page does not allow dynamic script execution." });
            }
        }, 5000);
    });
}

/**
 * Find an open tab whose URL matches the given pattern.
 * Supports glob-style patterns (e.g. *://www.runpod.io/*)
 */
async function findMatchingTab(urlPattern) {
    // Build a list of match patterns to try, from most specific to broadest
    const patternsToTry = [urlPattern];

    // If the pattern looks like an exact URL (no wildcards), also try
    // a wildcard version so query params / subpaths still match.
    if (!urlPattern.includes("*") && !urlPattern.includes("?")) {
        try {
            const url = new URL(urlPattern);
            // e.g. https://www.google.com/  →  https://www.google.com/*
            const withWildcard = `${url.origin}${url.pathname.replace(/\/$/, "")}/*`;
            patternsToTry.push(withWildcard);
            // Also try origin-level wildcard: https://www.google.com/*
            if (withWildcard !== `${url.origin}/*`) {
                patternsToTry.push(`${url.origin}/*`);
            }
        } catch {
            // Not a valid URL — fall through to manual matching below
        }
    }

    // Try each Chrome match pattern
    for (const pattern of patternsToTry) {
        try {
            const tabs = await chrome.tabs.query({ url: pattern });
            if (tabs.length > 0) {
                const activeTab = tabs.find((t) => t.active);
                return activeTab || tabs[0];
            }
        } catch {
            // Pattern wasn't a valid Chrome match pattern, skip it
        }
    }

    // Final fallback: manual regex matching against all open tabs
    const allTabs = await chrome.tabs.query({});
    const regex = globToRegex(urlPattern);
    for (const tab of allTabs) {
        if (tab.url && regex.test(tab.url)) {
            return tab;
        }
    }

    return null;
}

/**
 * Convert a glob-like URL pattern to a regex.
 */
function globToRegex(pattern) {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i");
}

function sendResult(requestId, result, error) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
            JSON.stringify({
                type: "execution_result",
                requestId,
                result,
                error: error || undefined,
            })
        );
    }
}

// ─────────────────────────────────────────────────────────────
// Message listener (from popup)
// ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "register_script") {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
                JSON.stringify({
                    type: "register_script",
                    name: message.name,
                    description: message.description,
                    urlPattern: message.urlPattern,
                    code: message.code,
                })
            );
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, error: "Not connected to server" });
        }
    } else if (message.type === "unregister_script") {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
                JSON.stringify({
                    type: "unregister_script",
                    name: message.name,
                })
            );
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, error: "Not connected to server" });
        }
    } else if (message.type === "get_status") {
        sendResponse({
            connected: isConnected,
            scriptCount: 0, // Will be populated from storage
        });
    }

    return true; // Keep the message channel open for async response
});

// ─────────────────────────────────────────────────────────────
// Install handler — seed default scripts
// ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === "install") {
        const defaultScripts = [
            {
                name: "runpod-status",
                description:
                    "Check RunPod serverless deployment status. Parses the DOM of the RunPod dashboard and returns the current build/deployment status.",
                urlPattern: "*://www.runpod.io/*",
                code: `
// Parse the RunPod dashboard DOM for deployment status
const statusElements = document.querySelectorAll('[class*="status"], [class*="progress"], [class*="deploy"], [class*="build"]');
const results = [];

// Look for progress bars
const progressBars = document.querySelectorAll('progress, [role="progressbar"], [class*="progress"]');
for (const bar of progressBars) {
  const value = bar.getAttribute('value') || bar.getAttribute('aria-valuenow') || bar.style?.width;
  if (value) {
    results.push('Progress: ' + value);
  }
}

// Look for status text
const allText = document.body.innerText;
const statusPatterns = [
  /build[ing]*\\s*[:\\-]?\\s*(\\d+%\\s*(?:complete)?)/gi,
  /(deploying|deployed|building|ready|running|error|failed|success|pending|queued)/gi,
  /status[:\\s]+(\\w[\\w\\s]*)/gi,
];

for (const pattern of statusPatterns) {
  const matches = [...allText.matchAll(pattern)];
  for (const match of matches) {
    results.push(match[0].trim());
  }
}

// Look for any visible status badges or chips
const badges = document.querySelectorAll('[class*="badge"], [class*="chip"], [class*="tag"], [class*="label"]');
for (const badge of badges) {
  const text = badge.textContent?.trim();
  if (text && text.length < 50 && /status|build|deploy|ready|running|error|success|pending/i.test(text)) {
    results.push('Badge: ' + text);
  }
}

if (results.length === 0) {
  return 'No deployment status indicators found on the current RunPod page. Make sure you are on a deployment/serverless page.';
}

return 'RunPod Status:\\n' + [...new Set(results)].join('\\n');
        `.trim(),
            },
        ];

        await chrome.storage.local.set({ scripts: defaultScripts });
        console.log("[MCP-Monkey] Default scripts installed");
    }
});

// ─────────────────────────────────────────────────────────────
// Start connection on service worker load
// ─────────────────────────────────────────────────────────────
connect();
