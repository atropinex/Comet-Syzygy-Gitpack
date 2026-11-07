"use strict";

/*
 * The window of the Package Updates extension. It shows one project's outdated packages, lets you
 * update them, and has a console that shows every command the extension runs (and lets you run your own).
 * It talks to main.js through window.extension (see scripts/preload/preloadextension.ts):
 *   invoke("state" | "check" | "update" | "updateAll" | "run" | "stop" | "restore" | "audit" | "openUrl", payload)
 *   on("state", ...)    a fresh snapshot of the project
 *   on("console", ...)  one more entry for the console
 */

const api = window.extension;

const state = {
    snapshot: null,
    ecosystemId: null,
    selected: new Set(),   // names of the ticked packages
    detail: null,          // name of the package shown on the right
    filter: "",
    severity: "all",
    dryRun: false,
    history: [],           // commands typed into the console
    historyIndex: 0
};

const KIND_NAMES = { dependencies: "dependency", devDependencies: "dev", peerDependencies: "peer", optionalDependencies: "optional" };
const MAX_LOG_NODES = 3000;

// === Small helpers === //

const $ = (id) => document.getElementById(id);

function h(tag, className, ...children) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    for (const child of children) {
        if (child !== null && child !== undefined && child !== false) element.append(child);
    }
    return element;
}

function button(label, className, onClick) {
    const element = h("button", className, label);
    element.type = "button";
    element.addEventListener("click", onClick);
    return element;
}

function ago(timestamp) {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
    return `${Math.floor(seconds / 86400)} d ago`;
}

function applyTheme(theme) {
    const root = document.documentElement.style;
    const { colors } = theme;
    root.setProperty("--background", colors.background);
    root.setProperty("--panel", colors.panel);
    root.setProperty("--panel-raised", colors.panelRaised);
    root.setProperty("--text", colors.text);
    root.setProperty("--muted", colors.muted);
    root.setProperty("--accent", colors.accent);
    root.setProperty("--on-accent", colors.onAccent);
    root.setProperty("--danger", colors.danger);
    root.colorScheme = theme.mode;
}

/** Calls the extension. A refusal ({ ok: false, error }) or a failure is written to the console. */
async function call(channel, payload) {
    try {
        const result = await api.invoke(channel, payload);
        if (result && result.ok === false) writeOutput("stderr", `${result.error}\n`);
        return result;
    } catch (error) {
        writeOutput("stderr", `${error.message}\n`);
        return null;
    }
}

// === What is selected === //

const snapshot = () => state.snapshot;
const ecosystem = () => snapshot().ecosystems.find((item) => item.id === state.ecosystemId) || null;
const result = () => (ecosystem() ? snapshot().results[ecosystem().id] || null : null);
const isRunning = () => Boolean(snapshot().running);
const isChecking = () => ecosystem() !== null && snapshot().checking.includes(ecosystem().id);

function visibleItems() {
    const items = result() ? result().items : [];
    const text = state.filter.trim().toLowerCase();

    return items.filter((item) =>
        (state.severity === "all" || item.severity === state.severity) &&
        (!text || item.name.toLowerCase().includes(text) || (item.framework || "").toLowerCase().includes(text)));
}

const findItem = (name) => (result() ? result().items.find((item) => item.name === name) : undefined);

// === Drawing === //

function render() {
    if (!state.snapshot) return;

    const known = snapshot().ecosystems.map((item) => item.id);
    if (!known.includes(state.ecosystemId)) state.ecosystemId = known[0] || null;

    renderTop();
    renderChips();
    renderTable();
    renderBulk();
    renderDetail();
    renderConsoleState();
}

function renderTop() {
    $("project-name").textContent = snapshot().project.name;
    $("project-path").textContent = snapshot().project.path;

    const tabs = $("tabs");
    tabs.replaceChildren(...snapshot().ecosystems.map((item) => {
        const total = snapshot().results[item.id] ? snapshot().results[item.id].summary.total : 0;
        const tab = h("button", `tab${item.id === state.ecosystemId ? " active" : ""}`, item.label, total > 0 ? h("span", "count", String(total)) : null);
        tab.type = "button";
        tab.addEventListener("click", () => {
            state.ecosystemId = item.id;
            state.selected.clear();
            state.detail = null;
            render();
        });
        return tab;
    }));

    const checked = $("checked");
    checked.textContent = isChecking() ? "Checking…" : result() ? `Checked ${ago(result().checkedAt)}` : "Not checked yet";
    $("refresh").disabled = isChecking() || !ecosystem();
}

function renderChips() {
    const items = result() ? result().items : [];
    const count = (severity) => (severity === "all" ? items.length : items.filter((item) => item.severity === severity).length);

    $("chips").replaceChildren(...["all", "major", "minor", "patch"].map((severity) => {
        const chip = button(`${severity === "all" ? "All" : severity[0].toUpperCase() + severity.slice(1)} ${count(severity)}`, `chip${state.severity === severity ? " active" : ""}`, () => {
            state.severity = severity;
            render();
        });
        return chip;
    }));
}

function message(title, body, ...extra) {
    return h("div", "message", h("strong", "", title), body, ...extra);
}

function renderTable() {
    const wrap = $("table-wrap");
    wrap.replaceChildren();

    if (!ecosystem()) {
        wrap.append(message("No packages", "This project has no package.json or .NET project file."));
        return;
    }

    const current = result();
    if (!current) {
        wrap.append(message("Checking packages…", "This can take a moment: it asks the package registry."));
        return;
    }

    // A failed check: explain it, and offer the fix when there is one.
    if (current.error && current.items.length === 0) {
        const retry = button("Try again", "btn", () => void call("check", { ecosystem: ecosystem().id }));
        const fix = current.error.code === "needs-restore"
            ? button("Restore packages", "btn primary", () => void call("restore", { ecosystem: ecosystem().id }))
            : null;
        const box = message("Could not check the packages", current.error.message, h("div", "", fix, " ", retry));
        box.classList.add("error");
        wrap.append(box);
        return;
    }

    if (current.error) wrap.append(h("div", "banner", `The last check failed (${current.error.message}). Showing the previous result.`));

    if (current.items.length === 0) {
        wrap.append(message("Everything is up to date", `Last checked ${ago(current.checkedAt)}.`));
        return;
    }

    const items = visibleItems();
    for (const name of [...state.selected]) if (!findItem(name)) state.selected.delete(name);
    if (state.detail && !findItem(state.detail)) state.detail = null;

    if (items.length === 0) {
        wrap.append(message("No packages match", "Change the filter to see more."));
        return;
    }

    const showWanted = ecosystem().id === "npm";
    const all = h("input");
    all.type = "checkbox";
    all.checked = items.every((item) => state.selected.has(item.name));
    all.addEventListener("change", () => {
        for (const item of items) all.checked ? state.selected.add(item.name) : state.selected.delete(item.name);
        render();
    });

    const head = h("tr", "", h("th", "check", all), h("th", "", "Package"), h("th", "", "Current"), showWanted ? h("th", "", "Wanted") : null,
        h("th", "", "Latest"), h("th", "", "Update"), h("th", "", "Type"), h("th", "", ""));
    const body = h("tbody");

    for (const item of items) {
        const tick = h("input");
        tick.type = "checkbox";
        tick.checked = state.selected.has(item.name);
        tick.addEventListener("click", (event) => event.stopPropagation());
        tick.addEventListener("change", () => {
            tick.checked ? state.selected.add(item.name) : state.selected.delete(item.name);
            renderBulk();
        });

        const row = h("tr", `row${state.detail === item.name ? " selected" : ""}`,
            h("td", "check", tick),
            h("td", "name", item.name, item.framework ? h("span", "framework", item.framework) : null),
            h("td", "version", item.current || "not installed"),
            showWanted ? h("td", "version", item.wanted || "") : null,
            h("td", "version latest", item.latest),
            h("td", "", h("span", `pill ${item.severity}`, item.severity)),
            h("td", "muted", KIND_NAMES[item.kind] || item.kind),
            h("td", "actions", button("Update", "btn small", (event) => { event.stopPropagation(); updatePackages([{ item, version: item.latest }]); })));
        row.addEventListener("click", () => { state.detail = item.name; render(); });

        const updateButton = row.querySelector("button");
        updateButton.disabled = isRunning();
        body.append(row);
    }

    wrap.append(h("table", "", h("thead", "", head), body));
}

function renderBulk() {
    const bulk = $("bulk");
    const eco = ecosystem();
    const items = result() ? result().items : [];
    const selected = items.filter((item) => state.selected.has(item.name));
    const busy = isRunning() || isChecking();

    if (!eco || items.length === 0) {
        bulk.replaceChildren();
        return;
    }

    const dry = h("input");
    dry.type = "checkbox";
    dry.checked = state.dryRun && eco.capabilities.dryRun;
    dry.disabled = !eco.capabilities.dryRun;
    dry.addEventListener("change", () => { state.dryRun = dry.checked; });

    const updateSelected = button(`Update selected`, "btn primary", () =>
        updatePackages(selected.map((item) => ({ item, version: item.latest }))));
    updateSelected.disabled = busy || selected.length === 0;

    const range = button("Update all (within ranges)", "btn", () => void call("updateAll", { ecosystem: eco.id, mode: "range", dryRun: state.dryRun }));
    range.disabled = busy || !eco.capabilities.range;
    range.title = eco.capabilities.range ? "Moves everything to the newest version your version ranges allow." : "Not available for this tool.";

    const latest = button("Update all to latest", "btn", () => void call("updateAll", { ecosystem: eco.id, mode: "latest", dryRun: state.dryRun }));
    latest.disabled = busy;
    latest.title = "Moves everything to its newest version. Major versions can break your code.";

    bulk.replaceChildren(
        h("span", "selected-count", selected.length > 0 ? `${selected.length} selected` : `${items.length} outdated`),
        updateSelected, range, latest,
        h("label", "check", dry, " Dry run")
    );
}

function renderDetail() {
    const detail = $("detail");
    const item = state.detail ? findItem(state.detail) : null;

    if (!item) {
        detail.replaceChildren(h("p", "empty", "Select a package to see its versions, links and the command that will be run."));
        return;
    }

    const busy = isRunning();
    const versions = h("dl", "versions",
        h("dt", "", "Installed"), h("dd", "", item.current || "not installed"),
        item.wanted ? h("dt", "", "Wanted") : null, item.wanted ? h("dd", "", item.wanted) : null,
        h("dt", "", "Latest"), h("dd", "", item.latest),
        item.project ? h("dt", "", "Project") : null, item.project ? h("dd", "", item.project) : null);

    const toLatest = button(`Update to ${item.latest}`, "btn primary", () => updatePackages([{ item, version: item.latest }]));
    toLatest.disabled = busy;

    const toWanted = item.commandWanted ? button(`Update to ${item.wanted} (within range)`, "btn", () => updatePackages([{ item, version: item.wanted }])) : null;
    if (toWanted) toWanted.disabled = busy;

    const links = [button("Package page", "btn", () => void call("openUrl", { url: item.pageUrl }))];
    if (item.homepage && item.homepage.startsWith("https://")) links.push(button("Homepage and changelog", "btn", () => void call("openUrl", { url: item.homepage })));

    const copy = button("Copy command", "btn", () => {
        navigator.clipboard.writeText(item.commandLatest).then(
            () => writeOutput("stdout", "Copied the command.\n"),
            () => writeOutput("stderr", "Could not copy.\n"));
    });

    detail.replaceChildren(
        h("h2", "", item.name),
        h("div", "sub", h("span", `pill ${item.severity}`, item.severity), KIND_NAMES[item.kind] || item.kind, item.framework ? h("span", "framework", item.framework) : null),
        versions,
        h("div", "actions", toLatest, toWanted, ...links, copy),
        h("div", "command-preview", item.commandLatest)
    );
}

function updatePackages(entries) {
    if (entries.length === 0 || isRunning()) return;

    void call("update", {
        ecosystem: ecosystem().id,
        packages: entries.map(({ item, version }) => ({ name: item.name, version, project: item.project })),
        dryRun: state.dryRun && ecosystem().capabilities.dryRun
    });
}

// === The console === //

function renderConsoleState() {
    const running = snapshot().running;
    $("running").textContent = running ? `Running: ${running.command}` : "";
    $("stop").disabled = !running;
    $("audit").disabled = Boolean(running) || !snapshot().ecosystems.some((item) => item.id === "npm");
}

function trimLog() {
    const log = $("log");
    while (log.childNodes.length > MAX_LOG_NODES) log.removeChild(log.firstChild);
}

function keepScrolled() {
    if ($("autoscroll").checked) $("log").scrollTop = $("log").scrollHeight;
}

/** Plain text, as the command printed it. */
function writeOutput(stream, text) {
    const span = h("span", stream === "stderr" ? "stderr" : "stdout");
    span.textContent = text;
    $("log").append(span);
    trimLog();
    keepScrolled();
}

function appendEntry(entry) {
    const log = $("log");

    if (entry.kind === "command") {
        const line = h("div", "cmd");
        line.textContent = `$ ${entry.text}`;
        log.append(line);
    } else if (entry.kind === "output") {
        const span = h("span", entry.stream === "stderr" ? "stderr" : "stdout");
        span.textContent = entry.text;
        log.append(span);
    } else {
        const seconds = (entry.ms / 1000).toFixed(1);
        const outcome = entry.stopped ? "stopped" : entry.code === 0 ? `finished in ${seconds}s` : `failed with exit code ${entry.code} after ${seconds}s`;
        const line = h("div", `end ${entry.stopped ? "" : entry.code === 0 ? "ok" : "fail"}`);
        line.textContent = outcome;
        log.append(line);
    }

    trimLog();
    keepScrolled();
}

function setUpConsole() {
    $("clear").addEventListener("click", () => $("log").replaceChildren());
    $("stop").addEventListener("click", () => void call("stop"));
    $("audit").addEventListener("click", () => void call("audit", { ecosystem: "npm" }));

    const input = $("command");
    $("prompt").addEventListener("submit", (event) => {
        event.preventDefault();
        const command = input.value.trim();
        input.value = "";
        if (!command) return;

        state.history.push(command);
        state.historyIndex = state.history.length;
        if (command === "clear" || command === "cls") $("log").replaceChildren();
        else void call("run", { command });
    });

    input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowUp" && state.historyIndex > 0) {
            event.preventDefault();
            input.value = state.history[--state.historyIndex];
        } else if (event.key === "ArrowDown") {
            event.preventDefault();
            state.historyIndex = Math.min(state.history.length, state.historyIndex + 1);
            input.value = state.history[state.historyIndex] || "";
        } else if (event.ctrlKey && event.key.toLowerCase() === "c" && input.selectionStart === input.selectionEnd) {
            void call("stop"); // Ctrl+C stops what is running, like a terminal
        }
    });
}

/** Dragging the thin bar above the console changes its height. */
function setUpSplitter() {
    const splitter = $("splitter");

    splitter.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        splitter.setPointerCapture(event.pointerId);
        splitter.classList.add("dragging");

        const move = (moveEvent) => {
            const height = Math.min(window.innerHeight - 280, Math.max(120, window.innerHeight - moveEvent.clientY));
            document.documentElement.style.setProperty("--console-height", `${height}px`);
        };
        const stop = () => {
            splitter.classList.remove("dragging");
            splitter.removeEventListener("pointermove", move);
            splitter.removeEventListener("pointerup", stop);
        };
        splitter.addEventListener("pointermove", move);
        splitter.addEventListener("pointerup", stop);
    });
}

// === Start === //

async function start() {
    const info = await api.getInfo();
    if (info) applyTheme(info.theme);

    $("filter").addEventListener("input", (event) => { state.filter = event.target.value; render(); });
    $("refresh").addEventListener("click", () => void call("check", { ecosystem: state.ecosystemId }));
    setUpConsole();
    setUpSplitter();

    api.on("state", (next) => { state.snapshot = next; render(); });
    api.on("console", appendEntry);

    const first = await call("state");
    if (!first) return;

    state.snapshot = first;
    for (const entry of first.log || []) appendEntry(entry);
    render();

    setInterval(() => { if (state.snapshot) renderTop(); }, 30000); // keeps "checked 2 min ago" honest
}

void start();
