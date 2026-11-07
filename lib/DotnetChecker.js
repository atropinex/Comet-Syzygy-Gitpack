"use strict";

const path = require("path");
const { classify, sortItems, isNugetId, isSafeVersion } = require("./Semver");

const firstLine = (text) => String(text || "").split("\n").map((line) => line.trim()).find(Boolean) || "";

/** Quotes a path for the shell. A path that contains a quote is refused rather than escaped. */
function quote(file) {
    if (/["\r\n]/.test(file)) throw new Error("That path contains a character that cannot be used in a command.");
    return `"${file}"`;
}

function failure(code, message) {
    return { items: [], error: { code, message } };
}

function toItem(id, current, latest, projectRelative) {
    return {
        ecosystem: "dotnet",
        name: id,
        current,
        wanted: null,
        latest,
        kind: "dependencies",
        homepage: null,
        pageUrl: `https://www.nuget.org/packages/${id}`,
        framework: null,
        severity: classify(current, latest),
        project: projectRelative,
        commandLatest: `dotnet add ${quote(projectRelative)} package ${id} --version ${latest}`,
        commandWanted: null
    };
}

/** `dotnet list package --outdated --format json` (the .NET 8 SDK and newer). */
function parseJson(data, state) {
    const seen = new Set();
    const items = [];

    for (const project of data.projects || []) {
        const relative = path.relative(state.path, project.path || "") || path.basename(project.path || "");
        for (const framework of project.frameworks || []) {
            for (const pkg of framework.topLevelPackages || []) {
                const key = `${relative}|${pkg.id}`;
                if (!pkg.latestVersion || pkg.resolvedVersion === pkg.latestVersion || seen.has(key)) continue;
                seen.add(key);
                items.push(toItem(pkg.id, pkg.resolvedVersion, pkg.latestVersion, relative));
            }
        }
    }

    const problems = (data.problems || []).map((problem) => problem.text).filter(Boolean).join(" ");
    return { items, problems };
}

/**
 * The plain text table older SDKs print: "   > Name   Requested   Resolved   Latest".
 * It does not say which project a row belongs to, so every row is attributed to the target.
 */
function parseText(text, target) {
    const items = [];
    const seen = new Set();

    for (const line of text.split("\n")) {
        const row = /^\s*>\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line);
        if (!row) continue;

        const [, id, , resolved, latest] = row;
        if (resolved === latest || seen.has(id)) continue;
        seen.add(id);
        items.push(toItem(id, resolved, latest, target));
    }
    return { items, problems: "" };
}

const needsRestore = (text) => /no assets file|run a nuget restore|nuget restore|run .dotnet restore/i.test(text);

/** Looks for outdated NuGet packages. Resolves with { items, error } and never throws. */
async function check(ecosystem, state, runner) {
    let target;
    try {
        target = quote(ecosystem.target);
    } catch (error) {
        return failure("failed", error.message);
    }

    const run = (command) => runner.start({ command, cwd: state.path, tag: state.id, quiet: true, timeoutMs: 240000 }).done;

    let result = await run(`dotnet list ${target} package --outdated --format json`);
    let combined = `${result.stdout}\n${result.stderr}`;
    let useText = false;

    // Older SDKs do not know --format. Ask again the old way and read the table.
    if (result.code !== 0 && /--format|unrecognized (command|option)|unknown option/i.test(combined)) {
        result = await run(`dotnet list ${target} package --outdated`);
        combined = `${result.stdout}\n${result.stderr}`;
        useText = true;
    }

    if (result.spawnError || result.code === 127 || /not recognized|command not found|dotnet: not found/i.test(result.stderr)) {
        return failure("not-found", "dotnet was not found. Is the .NET SDK installed and on your PATH?");
    }
    if (needsRestore(combined)) return failure("needs-restore", "The packages have not been restored yet.");

    let parsed;
    if (useText) {
        parsed = parseText(result.stdout, ecosystem.target);
    } else {
        try {
            parsed = parseJson(JSON.parse(result.stdout), state);
        } catch {
            if (result.code !== 0) return failure("failed", firstLine(combined) || `dotnet stopped with exit code ${result.code}.`);
            parsed = parseText(result.stdout, ecosystem.target); // some versions print the table anyway
        }
    }

    if (parsed.items.length === 0 && result.code !== 0) return failure("failed", firstLine(parsed.problems || combined) || `dotnet stopped with exit code ${result.code}.`);
    return { items: sortItems(parsed.items), error: null };
}

// === Updating === //

/** One `dotnet add package` per package, in the project file it belongs to. */
function updateCommands(ecosystem, state, packages, { dryRun }) {
    if (dryRun) throw new Error("dotnet cannot do a dry run.");
    if (packages.length === 0) throw new Error("No packages to update.");

    const root = path.resolve(state.path);
    return packages.map(({ name, version, project }) => {
        if (!isNugetId(name)) throw new Error(`"${name}" is not a valid package id.`);
        if (!isSafeVersion(version)) throw new Error(`"${version}" is not a valid version.`);

        const file = path.resolve(root, project || ecosystem.target);
        if (!file.startsWith(root + path.sep)) throw new Error("That project is outside the project folder.");
        if (/\.(sln|slnx)$/i.test(file)) throw new Error("Cannot tell which project of the solution holds this package.");

        return `dotnet add ${quote(file)} package ${name} --version ${version}`;
    });
}

function updateAllCommand() {
    throw new Error("NuGet has no \"within range\" update. Update to the latest instead.");
}

/** Downloads the packages, which `dotnet list package` needs before it can compare versions. */
function restoreCommand(ecosystem) {
    return `dotnet restore ${quote(ecosystem.target)}`;
}

module.exports = { check, updateCommands, updateAllCommand, restoreCommand, parseJson, parseText };
