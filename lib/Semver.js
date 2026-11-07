"use strict";

const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/;

function parse(version) {
    const match = VERSION.exec(String(version || "").trim());
    if (!match) return null;
    return { parts: [1, 2, 3, 4].map((index) => Number(match[index] || 0)), prerelease: match[5] || "" };
}

/**
 * How big the step from `current` to `latest` is: "major", "minor", "patch" or "prerelease".
 * "missing" means nothing is installed, "unknown" that a version could not be read.
 * A step in the minor number of a 0.x version counts as "major": below 1.0 any change may break.
 */
function classify(current, latest) {
    if (!current) return "missing";

    const from = parse(current);
    const to = parse(latest);
    if (!from || !to) return "unknown";

    if (from.parts[0] !== to.parts[0]) return "major";
    if (from.parts[1] !== to.parts[1]) return from.parts[0] === 0 ? "major" : "minor";
    if (from.parts[2] !== to.parts[2] || from.parts[3] !== to.parts[3]) return "patch";
    return from.prerelease !== to.prerelease ? "prerelease" : "unknown";
}

/** How many packages are out of date, split by the size of the step. */
function summarize(items) {
    const summary = { total: items.length, major: 0, minor: 0, patch: 0, other: 0 };
    for (const item of items) {
        if (item.severity === "major" || item.severity === "minor" || item.severity === "patch") summary[item.severity]++;
        else summary.other++;
    }
    return summary;
}

const ORDER = { major: 0, minor: 1, patch: 2, prerelease: 3, missing: 4, unknown: 5 };

/** Biggest steps first, then well-known frameworks, then by name. */
function sortItems(items) {
    return [...items].sort((a, b) =>
        (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9) ||
        Number(Boolean(b.framework)) - Number(Boolean(a.framework)) ||
        a.name.localeCompare(b.name));
}

// Names and versions end up in a command line, so they are checked before they are used.
const isSafeVersion = (value) => /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(String(value));
const isNpmName = (value) => /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(String(value));
const isNugetId = (value) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(String(value));

module.exports = { classify, summarize, sortItems, isSafeVersion, isNpmName, isNugetId };
