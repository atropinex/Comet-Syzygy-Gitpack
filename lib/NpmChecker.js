"use strict";

const { classify, sortItems, isNpmName, isSafeVersion } = require("./Semver");

/** Well-known packages, so a framework update stands out among the many small ones. */
const FRAMEWORKS = {
    "next": "Next.js", "discord.js": "discord.js", "react": "React", "react-dom": "React", "vue": "Vue", "nuxt": "Nuxt",
    "express": "Express", "electron": "Electron", "typescript": "TypeScript", "vite": "Vite", "svelte": "Svelte",
    "@angular/core": "Angular", "@nestjs/core": "NestJS", "prisma": "Prisma", "@prisma/client": "Prisma",
    "tailwindcss": "Tailwind CSS", "webpack": "webpack", "eslint": "ESLint", "three": "three.js"
};

const firstLine = (text) => String(text || "").split("\n").map((line) => line.trim()).find(Boolean) || "";

/** The command that lists outdated packages. */
function checkCommand(ecosystem) {
    return ecosystem.manager === "pnpm" ? "pnpm outdated --format json" : "npm outdated --json --long";
}

function failure(code, message) {
    return { items: [], error: { code, message } };
}

/** Turns one entry of `npm outdated --json --long` (or pnpm's) into the shape the window shows. */
function toItem(name, info, ecosystem) {
    const entry = Array.isArray(info) ? info[0] : info; // npm lists a package once per place it is installed
    if (!entry || typeof entry !== "object") return null;

    const current = entry.current || null;
    const latest = entry.latest || null;
    const wanted = entry.wanted || null;
    if (!latest || current === latest) return null;

    return {
        ecosystem: "npm",
        name,
        current,
        wanted,
        latest,
        kind: entry.type || entry.dependencyType || "dependencies",
        homepage: typeof entry.homepage === "string" ? entry.homepage : null,
        pageUrl: `https://www.npmjs.com/package/${name}`,
        framework: FRAMEWORKS[name] || null,
        severity: classify(current || wanted, latest),
        project: null,
        commandLatest: previewCommand(ecosystem, name, latest),
        commandWanted: wanted && wanted !== current && wanted !== latest ? previewCommand(ecosystem, name, wanted) : null
    };
}

function parseResult(result, ecosystem) {
    const tool = ecosystem.manager === "pnpm" ? "pnpm" : "npm";
    const text = result.stdout.trim();

    if (!text) {
        if (result.spawnError || result.code === 127 || /not recognized|not found|ENOENT/i.test(result.stderr)) {
            return failure("not-found", `${tool} was not found. Is it installed and on your PATH?`);
        }
        if (result.code === 0) return { items: [], error: null };
        return failure("failed", firstLine(result.stderr) || `${tool} stopped with exit code ${result.code}.`);
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return failure("bad-output", `Could not read what ${tool} printed.`);
    }

    // When it cannot do its job (no network, a broken package.json) npm prints { "error": ... }.
    if (data && data.error) {
        const detail = data.error.summary || data.error.detail || data.error.code || "The check failed.";
        return failure(String(data.error.code || "failed"), String(detail).split("\n")[0]);
    }

    const items = Object.entries(data || {}).map(([name, info]) => toItem(name, info, ecosystem)).filter(Boolean);
    return { items: sortItems(items), error: null };
}

/** Looks for outdated packages. Resolves with { items, error } and never throws. */
async function check(ecosystem, state, runner) {
    const job = runner.start({ command: checkCommand(ecosystem), cwd: state.path, tag: state.id, quiet: true, timeoutMs: 180000 });
    return parseResult(await job.done, ecosystem);
}

// === Updating === //

function specs(packages) {
    if (packages.length === 0) throw new Error("No packages to update.");

    return packages.map(({ name, version }) => {
        if (!isNpmName(name)) throw new Error(`"${name}" is not a valid package name.`);
        if (!isSafeVersion(version)) throw new Error(`"${version}" is not a valid version.`);
        return `${name}@${version}`;
    }).join(" ");
}

function previewCommand(ecosystem, name, version) {
    switch (ecosystem.manager) {
        case "pnpm": return `pnpm update ${name}@${version}`;
        case "yarn": return `yarn upgrade ${name}@${version}`;
        case "yarn-berry": return `yarn up ${name}@${version}`;
        default: return `npm install ${name}@${version}`;
    }
}

/** The commands that move these packages to these versions, each one keeping the package where it already is in package.json. */
function updateCommands(ecosystem, state, packages, { dryRun }) {
    if (dryRun && !ecosystem.capabilities.dryRun) throw new Error(`${ecosystem.label} cannot do a dry run.`);

    const list = specs(packages);
    switch (ecosystem.manager) {
        case "pnpm": return [`pnpm update ${list}`];
        case "yarn": return [`yarn upgrade ${list}`];
        case "yarn-berry": return [`yarn up ${list}`];
        default: return [`npm install ${list}${dryRun ? " --dry-run" : ""}`];
    }
}

/** Moves everything to the newest version the version ranges in package.json allow. */
function updateAllCommand(ecosystem, state, { dryRun }) {
    if (!ecosystem.capabilities.range) throw new Error(`${ecosystem.label} cannot update within the version ranges. Update to the latest instead.`);
    if (dryRun && !ecosystem.capabilities.dryRun) throw new Error(`${ecosystem.label} cannot do a dry run.`);

    switch (ecosystem.manager) {
        case "pnpm": return "pnpm update";
        case "yarn": return "yarn upgrade";
        default: return `npm update${dryRun ? " --dry-run" : ""}`;
    }
}

function auditCommand(ecosystem) {
    return ecosystem.manager === "pnpm" ? "pnpm audit" : "npm audit";
}

module.exports = { check, updateCommands, updateAllCommand, auditCommand, parseResult };
