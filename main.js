"use strict";

const dotnet = require("./lib/DotnetChecker");
const { detectEcosystems } = require("./lib/Ecosystems");
const npm = require("./lib/NpmChecker");
const { Runner } = require("./lib/Runner");
const { summarize } = require("./lib/Semver");

/** The check and update commands of each kind of package. */
const CHECKERS = { npm, dotnet };

const WINDOW_PAGE = "window/index.html";
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;     // a result older than this is checked again at start-up
const RECHECK_EVERY_MS = 30 * 60 * 1000;       // how often stale results are looked for while the app runs
const CONCURRENT_CHECKS = 2;                   // checks talk to the network, so only a few at a time
const LOG_LIMIT = 800;                         // console lines kept per project, for windows opened later

const fail = (error) => ({ ok: false, error });

class PackageUpdates {
    constructor(context) {
        this.ctx = context;
        this.projects = new Map();        // project id -> state
        this.windowProject = new Map();   // window id -> project id
        this.queue = [];                  // ids of projects waiting for a check
        this.activeChecks = 0;
        this.cache = {};                  // project id -> { checkedAt, results }, kept between runs
        this.timer = null;
        this.runner = new Runner((event) => this.onRunnerEvent(event));
    }

    async start() {
        const { ctx } = this;
        this.cache = (await ctx.storage.get("cache", {})) || {};

        ctx.commands.register("open", (args) => this.openWindow(args && args.projectId));
        ctx.commands.register("check", (args) => this.enqueue(args && args.projectId));
        this.registerWindowHandlers();
        ctx.windows.onDidClose((windowId) => this.windowProject.delete(windowId));
        ctx.projects.onDidChange(() => void this.refreshProjects());

        await this.refreshProjects();
        this.timer = setInterval(() => this.enqueueStale(), RECHECK_EVERY_MS);
    }

    stop() {
        clearInterval(this.timer);
        this.runner.stopAll(); // do not leave an npm install running behind a closed app
    }

    // === Projects === //

    /** Looks at every project: which kinds of package it has, and what is already known about them. */
    async refreshProjects() {
        const list = await this.ctx.projects.list();
        const known = new Set(list.map((project) => project.id));

        for (const id of [...this.projects.keys()]) {
            if (known.has(id)) continue;
            this.projects.delete(id);
            this.ctx.projects.clear(id);
            delete this.cache[id];
            for (const [windowId, projectId] of this.windowProject) if (projectId === id) this.ctx.windows.close(windowId);
        }

        for (const project of list) {
            let state = this.projects.get(project.id);
            const isNew = !state;
            if (!state) {
                state = { id: project.id, name: project.name, path: project.path, ecosystems: [], results: {}, checking: new Set(), running: null, cancelled: false, log: [] };
                this.projects.set(project.id, state);
            }

            state.name = project.name;
            state.path = project.path;
            state.ecosystems = await detectEcosystems(project.path);

            const cached = this.cache[project.id];
            if (isNew && cached) state.results = cached.results || {};
            this.publish(state);

            const stale = !cached || Date.now() - cached.checkedAt > STALE_AFTER_MS;
            if (isNew && state.ecosystems.length > 0 && stale) this.enqueue(state.id);
        }
    }

    enqueueStale() {
        for (const state of this.projects.values()) {
            const cached = this.cache[state.id];
            if (state.ecosystems.length > 0 && (!cached || Date.now() - cached.checkedAt > STALE_AFTER_MS)) this.enqueue(state.id);
        }
    }

    // === Checking === //

    enqueue(projectId) {
        const state = this.projects.get(projectId);
        if (!state || state.ecosystems.length === 0 || state.checking.size > 0 || this.queue.includes(projectId)) return;

        this.queue.push(projectId);
        this.pump();
    }

    pump() {
        while (this.activeChecks < CONCURRENT_CHECKS && this.queue.length > 0) {
            const state = this.projects.get(this.queue.shift());
            if (!state) continue;

            this.activeChecks++;
            this.checkEcosystems(state, null).finally(() => {
                this.activeChecks--;
                this.pump();
            });
        }
    }

    /** Checks the given kinds of package (all of them when `only` is null) and remembers the result. */
    async checkEcosystems(state, only) {
        for (const ecosystem of state.ecosystems) {
            if (only && !only.includes(ecosystem.id)) continue;

            state.checking.add(ecosystem.id);
            this.publish(state);
            this.broadcast(state);

            let fresh;
            try {
                fresh = await CHECKERS[ecosystem.id].check(ecosystem, state, this.runner);
            } catch (error) {
                fresh = { items: [], error: { code: "failed", message: error.message } };
            }

            // A failed check keeps the last good list on screen instead of wiping it.
            const previous = state.results[ecosystem.id];
            const items = fresh.error && previous ? previous.items : fresh.items;
            state.results[ecosystem.id] = {
                items,
                error: fresh.error,
                checkedAt: fresh.error && previous ? previous.checkedAt : Date.now(),
                summary: summarize(items)
            };

            state.checking.delete(ecosystem.id);
            this.publish(state);
            this.broadcast(state);
        }

        this.cache[state.id] = { checkedAt: Date.now(), results: state.results };
        await this.ctx.storage.set("cache", this.cache);
    }

    // === What the app shows for a project === //

    /** Adds up the results of every kind of package the project has. */
    totals(state) {
        const totals = { total: 0, major: 0, minor: 0, patch: 0, results: 0, errors: [] };
        for (const ecosystem of state.ecosystems) {
            const result = state.results[ecosystem.id];
            if (!result) continue;

            totals.results++;
            totals.total += result.summary.total;
            totals.major += result.summary.major;
            totals.minor += result.summary.minor;
            totals.patch += result.summary.patch;
            if (result.error) totals.errors.push(`${ecosystem.label}: ${result.error.message}`);
        }
        return totals;
    }

    badge(state) {
        const open = { command: "open", args: { projectId: state.id } };
        const totals = this.totals(state);
        const checking = state.checking.size > 0 ? " (checking again…)" : "";

        if (totals.results === 0) {
            return { id: "packages", text: "…", tone: "muted", tooltip: "Checking packages…", ...open };
        }
        if (totals.total > 0) {
            const parts = [["major", totals.major], ["minor", totals.minor], ["patch", totals.patch]].filter(([, count]) => count > 0).map(([name, count]) => `${count} ${name}`);
            return {
                id: "packages", text: `↑${totals.total}`, tone: totals.major > 0 ? "danger" : "warn",
                tooltip: `${totals.total} outdated package${totals.total === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}${checking}. Click to review.`,
                ...open
            };
        }
        if (totals.errors.length > 0) {
            return { id: "packages", text: "!", tone: "warn", tooltip: `${totals.errors.join(" ")} Click for details.`, ...open };
        }
        return { id: "packages", text: "✓", tone: "ok", tooltip: `All packages are up to date${checking}.`, ...open };
    }

    publish(state) {
        if (state.ecosystems.length === 0) {
            this.ctx.projects.clear(state.id);
            return;
        }

        const totals = this.totals(state);
        const args = { projectId: state.id };
        this.ctx.projects.contribute(state.id, {
            badges: [this.badge(state)],
            menu: [
                { id: "open", label: "Outdated packages…", hint: totals.total > 0 ? String(totals.total) : "", command: "open", args },
                { id: "check", label: "Check for package updates", command: "check", args }
            ]
        });
    }

    // === The window === //

    openWindow(projectId) {
        const state = this.projects.get(projectId);
        if (!state) return;

        const windowId = this.ctx.windows.open({
            id: `project-${projectId}`,
            title: `Packages: ${state.name}`,
            page: WINDOW_PAGE,
            width: 1200,
            height: 800,
            data: { projectId }
        });
        this.windowProject.set(windowId, projectId);

        // Looking at the window is a good moment to be sure its numbers are fresh.
        const cached = this.cache[projectId];
        if (!cached || Date.now() - cached.checkedAt > STALE_AFTER_MS) this.enqueue(projectId);
    }

    windowsOf(projectId) {
        return [...this.windowProject].filter(([, id]) => id === projectId).map(([windowId]) => windowId);
    }

    /** Everything the window needs to draw itself. The log is only sent when the window first opens. */
    snapshot(state, withLog) {
        return {
            project: { id: state.id, name: state.name, path: state.path },
            ecosystems: state.ecosystems,
            results: state.results,
            checking: [...state.checking],
            running: state.running ? { command: state.running.command } : null,
            log: withLog ? state.log : undefined
        };
    }

    broadcast(state) {
        const snapshot = this.snapshot(state, false);
        for (const windowId of this.windowsOf(state.id)) this.ctx.windows.send(windowId, "state", snapshot);
    }

    registerWindowHandlers() {
        // Every handler works on the project of the window that called it.
        const handle = (channel, work) => this.ctx.ipc.handle(channel, async (payload, from) => {
            const state = this.projects.get(this.windowProject.get(from.windowId));
            if (!state) throw new Error("This window is not showing a project.");
            return work(state, payload || {});
        });

        handle("state", (state) => this.snapshot(state, true));
        handle("check", (state, { ecosystem }) => {
            if (state.checking.size === 0) void this.checkEcosystems(state, ecosystem ? [ecosystem] : null);
            return { ok: true };
        });
        handle("update", (state, payload) => this.update(state, payload));
        handle("updateAll", (state, payload) => this.updateAll(state, payload));
        handle("run", (state, { command }) => this.runCommandLine(state, command));
        handle("stop", (state) => this.stopRunning(state));
        handle("restore", (state, { ecosystem }) => this.restore(state, ecosystem));
        handle("audit", (state, { ecosystem }) => this.audit(state, ecosystem));
        handle("openUrl", (state, { url }) => this.ctx.openExternal(url));
    }

    // === Updating === //

    ecosystemOf(state, id) {
        return state.ecosystems.find((ecosystem) => ecosystem.id === id) || null;
    }

    update(state, { ecosystem: id, packages, dryRun }) {
        const ecosystem = this.ecosystemOf(state, id);
        if (!ecosystem) return fail("Unknown kind of package.");
        if (!Array.isArray(packages) || packages.length === 0) return fail("Nothing selected.");

        let commands;
        try {
            const list = packages.slice(0, 200).map((item) => ({ name: String(item.name), version: String(item.version), project: item.project ? String(item.project) : null }));
            commands = CHECKERS[ecosystem.id].updateCommands(ecosystem, state, list, { dryRun: Boolean(dryRun) });
        } catch (error) {
            return fail(error.message);
        }

        const count = packages.length;
        return this.runSequence(state, commands, {
            recheck: dryRun ? null : ecosystem.id,
            notify: dryRun ? null : `Updated ${count} package${count === 1 ? "" : "s"} in ${state.name}`
        });
    }

    updateAll(state, { ecosystem: id, mode, dryRun }) {
        const ecosystem = this.ecosystemOf(state, id);
        if (!ecosystem) return fail("Unknown kind of package.");

        const checker = CHECKERS[ecosystem.id];
        let commands;
        try {
            if (mode === "range") {
                commands = [checker.updateAllCommand(ecosystem, state, { dryRun: Boolean(dryRun) })];
            } else {
                const items = (state.results[ecosystem.id] || { items: [] }).items.filter((item) => item.latest);
                commands = checker.updateCommands(ecosystem, state, items.map((item) => ({ name: item.name, version: item.latest, project: item.project })), { dryRun: Boolean(dryRun) });
            }
        } catch (error) {
            return fail(error.message);
        }

        return this.runSequence(state, commands, {
            recheck: dryRun ? null : ecosystem.id,
            notify: dryRun ? null : `Updated the packages of ${state.name}`
        });
    }

    /** A line typed into the console: runs in the project's folder. */
    runCommandLine(state, command) {
        const text = String(command || "").trim();
        if (!text) return fail("Type a command.");
        if (text.length > 500) return fail("That command is too long.");
        return this.runSequence(state, [text], { recheck: null, notify: null });
    }

    audit(state, id) {
        const ecosystem = this.ecosystemOf(state, id) || this.ecosystemOf(state, "npm");
        if (!ecosystem || ecosystem.id !== "npm") return fail("Audit is only available for Node projects.");
        return this.runSequence(state, [npm.auditCommand(ecosystem)], { recheck: null, notify: null });
    }

    restore(state, id) {
        const ecosystem = this.ecosystemOf(state, id);
        if (!ecosystem || ecosystem.id !== "dotnet") return fail("Restore is only available for .NET projects.");
        return this.runSequence(state, [dotnet.restoreCommand(ecosystem)], { recheck: ecosystem.id, notify: null });
    }

    stopRunning(state) {
        state.cancelled = true;
        if (state.running && state.running.jobId) this.runner.stop(state.running.jobId);
        return { ok: true };
    }

    /**
     * Runs commands one after another. It returns at once; progress reaches the window as console
     * events, and the package list is checked again afterwards (`recheck`) when everything worked.
     * Only one thing runs per project at a time.
     */
    runSequence(state, commands, { recheck, notify }) {
        if (state.running) return fail("Another command is still running. Wait for it, or press Stop.");

        state.running = { command: commands[0], jobId: null };
        state.cancelled = false;
        this.broadcast(state);

        void (async () => {
            let succeeded = true;
            for (const command of commands) {
                if (state.cancelled) { succeeded = false; break; }

                const job = this.runner.start({ command, cwd: state.path, tag: state.id });
                state.running = { command, jobId: job.id };
                this.broadcast(state);

                const result = await job.done;
                if (result.code !== 0) { succeeded = false; break; }
            }

            state.running = null;
            this.broadcast(state);

            if (succeeded && notify) this.ctx.notify(notify);
            if (succeeded && recheck) await this.checkEcosystems(state, [recheck]);
        })();

        return { ok: true };
    }

    // === The console === //

    onRunnerEvent(event) {
        const state = this.projects.get(event.tag);
        if (!state) return;

        let entry;
        if (event.type === "start") entry = { kind: "command", text: event.command };
        else if (event.type === "output") entry = { kind: "output", stream: event.stream, text: event.text };
        else entry = { kind: "end", code: event.code, ms: event.ms, stopped: event.stopped };
        entry.at = Date.now();

        state.log.push(entry);
        if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);

        for (const windowId of this.windowsOf(state.id)) this.ctx.windows.send(windowId, "console", entry);
    }
}

let instance = null;

exports.activate = async function activate(context) {
    instance = new PackageUpdates(context);
    await instance.start();
};

exports.deactivate = function deactivate() {
    if (instance) instance.stop();
    instance = null;
};
