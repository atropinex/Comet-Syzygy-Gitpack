"use strict";

const fs = require("fs").promises;
const path = require("path");

const SKIPPED_FOLDERS = new Set(["node_modules", "bin", "obj", "dist", "out", "Library", "Temp", "packages"]);
const exists = (file) => fs.access(file).then(() => true, () => false);

/** Which command line tool manages a Node project's packages, judged by its lock file. */
async function detectNodeManager(folder) {
    if (await exists(path.join(folder, "pnpm-lock.yaml"))) return "pnpm";
    if (await exists(path.join(folder, "yarn.lock"))) return (await exists(path.join(folder, ".yarnrc.yml"))) ? "yarn-berry" : "yarn";
    return "npm";
}

const NODE_LABELS = { npm: "npm", pnpm: "pnpm", yarn: "Yarn", "yarn-berry": "Yarn" };

/** What each tool can do, so the window only offers what works. */
const NODE_CAPABILITIES = {
    npm: { dryRun: true, range: true },
    pnpm: { dryRun: false, range: true },
    yarn: { dryRun: false, range: true },
    "yarn-berry": { dryRun: false, range: false }
};

/**
 * The solution or project file `dotnet list package` should be pointed at.
 * Looks two folders deep. A solution wins over a project, and a shallower file over a deeper one.
 */
async function findDotnetTarget(folder) {
    let best = null;

    async function walk(directory, depth) {
        let entries;
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (entry.isFile()) {
                const isSolution = /\.(sln|slnx)$/i.test(entry.name);
                if (!isSolution && !/\.(csproj|fsproj|vbproj)$/i.test(entry.name)) continue;

                const rank = depth * 2 + (isSolution ? 0 : 1);
                if (!best || rank < best.rank) best = { rank, file: path.join(directory, entry.name) };
            } else if (entry.isDirectory() && depth < 2 && !SKIPPED_FOLDERS.has(entry.name) && !entry.name.startsWith(".")) {
                await walk(path.join(directory, entry.name), depth + 1);
            }
        }
    }

    await walk(folder, 0);
    return best ? path.relative(folder, best.file) : null;
}

/** The kinds of package a project uses: { id, label, ... } for each one found. */
async function detectEcosystems(folder) {
    const found = [];

    if (await exists(path.join(folder, "package.json"))) {
        const manager = await detectNodeManager(folder);
        found.push({ id: "npm", label: NODE_LABELS[manager], manager, capabilities: NODE_CAPABILITIES[manager] });
    }

    const target = await findDotnetTarget(folder);
    if (target) found.push({ id: "dotnet", label: "NuGet (.NET)", target, capabilities: { dryRun: false, range: false } });

    return found;
}

module.exports = { detectEcosystems };
