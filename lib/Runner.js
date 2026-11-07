"use strict";

const { spawn } = require("child_process");

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g; // colour codes and cursor moves
const MAX_CAPTURE = 8 * 1024 * 1024;

/** Stops a process and everything it started (npm starts several). */
function killTree(child) {
    if (!child || !child.pid) return;

    if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        return;
    }

    try {
        process.kill(-child.pid, "SIGTERM"); // the whole process group: see `detached` below
    } catch {
        try { child.kill("SIGTERM"); } catch { /* it is already gone */ }
    }
}

/**
 * Runs shell commands and reports what happens through `onEvent`:
 *   { type: "start",  id, tag, command, quiet }
 *   { type: "output", id, tag, stream, text }        (not sent for quiet commands)
 *   { type: "end",    id, tag, quiet, code, ms, stopped }
 * `tag` says what the command belongs to (here: a project id).
 * `quiet` commands (the checks) still show their command line and result, but not their long output.
 */
class Runner {
    constructor(onEvent) {
        this.onEvent = onEvent;
        this.jobs = new Map();
        this.nextId = 1;
    }

    /** Starts a command. `done` resolves with { code, stdout, stderr, ms, stopped, spawnError } and never rejects. */
    start({ command, cwd, tag, quiet = false, timeoutMs = 0 }) {
        const id = this.nextId++;
        const startedAt = Date.now();
        const job = { child: null, stopped: false };
        this.jobs.set(id, job);
        this.onEvent({ type: "start", id, tag, command, quiet });

        const done = new Promise((resolve) => {
            let stdout = "";
            let stderr = "";
            let finished = false;
            let timer = null;

            const finish = (code, spawnError) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                this.jobs.delete(id);

                const ms = Date.now() - startedAt;
                this.onEvent({ type: "end", id, tag, quiet, code, ms, stopped: job.stopped });
                resolve({ id, code, stdout, stderr, ms, stopped: job.stopped, spawnError: spawnError || null });
            };

            const collect = (stream) => (chunk) => {
                const text = chunk.toString().replace(ANSI, "").replace(/\r(?!\n)/g, "\n");
                if (stream === "stdout") stdout = (stdout + text).slice(-MAX_CAPTURE);
                else stderr = (stderr + text).slice(-MAX_CAPTURE);
                if (!quiet) this.onEvent({ type: "output", id, tag, stream, text });
            };

            try {
                job.child = spawn(command, {
                    cwd,
                    shell: true,
                    windowsHide: true,                         // no console window for the command
                    detached: process.platform !== "win32",    // its own process group, so it can be stopped as a whole
                    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", npm_config_color: "false", npm_config_progress: "false" }
                });
            } catch (error) {
                finish(-1, error.message);
                return;
            }

            job.child.stdout.on("data", collect("stdout"));
            job.child.stderr.on("data", collect("stderr"));
            job.child.on("error", (error) => finish(-1, error.message));
            job.child.on("close", (code) => finish(code === null ? -1 : code));

            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    job.stopped = true;
                    stderr += `\nStopped: it took longer than ${timeoutMs / 1000} seconds.\n`;
                    killTree(job.child);
                }, timeoutMs);
            }
        });

        return { id, done };
    }

    stop(id) {
        const job = this.jobs.get(id);
        if (!job) return;
        job.stopped = true;
        killTree(job.child);
    }

    stopAll() {
        for (const id of [...this.jobs.keys()]) this.stop(id);
    }
}

module.exports = { Runner };
