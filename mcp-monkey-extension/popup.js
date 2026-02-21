// ─────────────────────────────────────────────────────────────
// MCP-Monkey Popup Script
// Manages script CRUD and communicates with the background worker
// ─────────────────────────────────────────────────────────────

const DOM = {
    form: document.getElementById("script-form"),
    nameInput: document.getElementById("script-name"),
    descInput: document.getElementById("script-description"),
    urlInput: document.getElementById("script-url"),
    codeInput: document.getElementById("script-code"),
    scriptsList: document.getElementById("scripts-list"),
    scriptCount: document.getElementById("script-count"),
    statusBadge: document.getElementById("status-badge"),
    toggleFormBtn: document.getElementById("toggle-form-btn"),
    formToggle: document.getElementById("form-toggle"),
};

let formCollapsed = false;

// ─────────────────────────────────────────────────────────────
// Initialize
// ─────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    loadScripts();
    checkStatus();

    DOM.form.addEventListener("submit", handleSaveScript);
    DOM.formToggle.addEventListener("click", toggleForm);

    // Poll status every 3 seconds
    setInterval(checkStatus, 3000);
});

// ─────────────────────────────────────────────────────────────
// Status Check
// ─────────────────────────────────────────────────────────────

async function checkStatus() {
    try {
        const response = await chrome.runtime.sendMessage({ type: "get_status" });
        const badge = DOM.statusBadge;
        const dot = badge.querySelector(".status-dot");
        const text = badge.querySelector(".status-text");

        if (response?.connected) {
            badge.className = "status-badge connected";
            text.textContent = "Connected";
        } else {
            badge.className = "status-badge disconnected";
            text.textContent = "Disconnected";
        }
    } catch {
        DOM.statusBadge.className = "status-badge disconnected";
        DOM.statusBadge.querySelector(".status-text").textContent = "Error";
    }
}

// ─────────────────────────────────────────────────────────────
// Load & Render Scripts
// ─────────────────────────────────────────────────────────────

async function loadScripts() {
    const data = await chrome.storage.local.get("scripts");
    const scripts = data.scripts || [];
    renderScripts(scripts);
}

function renderScripts(scripts) {
    DOM.scriptCount.textContent = scripts.length;

    if (scripts.length === 0) {
        DOM.scriptsList.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🤷</span>
        <p>No scripts saved yet</p>
      </div>
    `;
        return;
    }

    DOM.scriptsList.innerHTML = scripts
        .map(
            (script, index) => `
      <div class="script-item" data-index="${index}">
        <div class="script-info">
          <div class="script-name">${escapeHtml(script.name)}</div>
          <div class="script-desc" title="${escapeHtml(script.description)}">${escapeHtml(script.description)}</div>
          <div class="script-url">${escapeHtml(script.urlPattern)}</div>
        </div>
        <div class="script-actions">
          <button class="btn btn-danger" data-delete="${index}" title="Delete script">
            ✕
          </button>
        </div>
      </div>
    `
        )
        .join("");

    // Attach delete handlers
    DOM.scriptsList.querySelectorAll("[data-delete]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const index = parseInt(btn.dataset.delete, 10);
            deleteScript(index);
        });
    });
}

// ─────────────────────────────────────────────────────────────
// Save Script
// ─────────────────────────────────────────────────────────────

async function handleSaveScript(e) {
    e.preventDefault();

    const name = DOM.nameInput.value.trim();
    const description = DOM.descInput.value.trim();
    const urlPattern = DOM.urlInput.value.trim();
    const code = DOM.codeInput.value.trim();

    if (!name || !description || !urlPattern || !code) {
        showToast("⚠️ Please fill in all fields");
        return;
    }

    // Validate name format
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        showToast("⚠️ Name: letters, numbers, hyphens, underscores only");
        return;
    }

    // Get existing scripts
    const data = await chrome.storage.local.get("scripts");
    const scripts = data.scripts || [];

    // Check for duplicate name — update if exists
    const existingIndex = scripts.findIndex((s) => s.name === name);
    const scriptData = { name, description, urlPattern, code };

    if (existingIndex >= 0) {
        scripts[existingIndex] = scriptData;
    } else {
        scripts.push(scriptData);
    }

    // Save to storage
    await chrome.storage.local.set({ scripts });

    // Register with the server via background worker
    try {
        await chrome.runtime.sendMessage({
            type: "register_script",
            ...scriptData,
        });
    } catch (err) {
        console.error("Failed to register script:", err);
    }

    // Refresh UI
    renderScripts(scripts);
    DOM.form.reset();
    showToast(existingIndex >= 0 ? "✅ Script updated!" : "✅ Script saved!");
}

// ─────────────────────────────────────────────────────────────
// Delete Script
// ─────────────────────────────────────────────────────────────

async function deleteScript(index) {
    const data = await chrome.storage.local.get("scripts");
    const scripts = data.scripts || [];

    if (index < 0 || index >= scripts.length) return;

    const removed = scripts.splice(index, 1)[0];
    await chrome.storage.local.set({ scripts });

    // Unregister from server
    try {
        await chrome.runtime.sendMessage({
            type: "unregister_script",
            name: removed.name,
        });
    } catch (err) {
        console.error("Failed to unregister script:", err);
    }

    renderScripts(scripts);
    showToast(`🗑️ Deleted "${removed.name}"`);
}

// ─────────────────────────────────────────────────────────────
// Toggle Form
// ─────────────────────────────────────────────────────────────

function toggleForm() {
    formCollapsed = !formCollapsed;
    DOM.form.classList.toggle("collapsed", formCollapsed);
    DOM.toggleFormBtn
        .querySelector(".chevron")
        .classList.toggle("rotated", formCollapsed);
}

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

function showToast(message) {
    // Remove existing toast
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add("show");
    });

    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}
