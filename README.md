# Package Updates

An extension for Flux Syzygy.

## Install

Unzip this folder (`package-updates`) into Flux Syzygy's extensions folder (**Settings > Extensions > Open extensions
folder**), then press **Reload extensions**. Needs a Flux Syzygy version that supports extensions.

Shows which packages of a project are out of date, and updates them from a window with a built-in console.

## What you see

* **A badge on the project card**: `↑3` (3 outdated packages; red when one is a major version, amber otherwise), `✓`
  (everything is up to date), `!` (the check failed) or `…` (checking). Click it to open the window. Hover it for the
  breakdown (for example "1 major, 2 minor").
* **Right-click menu items**: *Outdated packages…* and *Check for package updates*.

Projects with neither a `package.json` nor a .NET solution/project file get nothing.

## What it supports

| Kind | Found by | Checked with | Updated with |
|---|---|---|---|
| Node (npm, and so Next.js, discord.js, React, ...) | `package.json` | `npm outdated --json --long` | `npm install name@version` |
| Node with pnpm | `pnpm-lock.yaml` | `pnpm outdated --format json` | `pnpm update name@version` |
| Node with Yarn | `yarn.lock` | `npm outdated` | `yarn upgrade` (classic) / `yarn up` (Berry) |
| .NET (NuGet) | a `.sln` or `.csproj`/`.fsproj`/`.vbproj` up to two folders deep | `dotnet list package --outdated` | `dotnet add <project> package <id> --version <v>` |

Well-known frameworks (Next.js, discord.js, React, TypeScript, Electron, ...) are tagged, so they stand out. The tools
(`npm`, `dotnet`, ...) must be installed and on your PATH. For .NET the packages must be restored first; if they are
not, the window offers a **Restore packages** button.

## The window

* **List**: every outdated package with its current, wanted (npm) and latest version, how big the step is (major,
  minor, patch) and whether it is a dependency or dev dependency. Filter by text or by size. Tick several to update
  them together.
* **Details** (click a package): its versions, links to its package page and homepage/changelog, the exact command that
  will run, *Update to latest*, *Update to wanted (within range)* and *Copy command*.
* **Bulk actions**: *Update selected*, *Update all (within ranges)* (`npm update`; npm, pnpm and Yarn classic) and
  *Update all to latest*. *Dry run* previews npm changes without touching anything.
* **Console**: every command the extension runs is shown, with its output and exit code. The prompt at the bottom runs
  your own commands in the project's folder (Up/Down recall history, `clear` clears, Ctrl+C or *Stop* stops the running
  command). *Audit* runs `npm audit`. Drag the thin bar above the console to resize it.
* After a successful update the list is checked again, and the badge follows.

## Good to know

* Results are remembered, so badges appear immediately at start-up; a result older than 6 hours is checked again in
  the background (two projects at a time) and every 30 minutes the app looks for stale ones. Press *Refresh* for a
  fresh check.
* One command runs per project at a time. *Stop* ends it together with everything it started.
* Package names and versions are validated before they reach a command line, and only https links are opened.
* Updating to a new major version can break your code. The list is sorted with major updates first for that reason.
