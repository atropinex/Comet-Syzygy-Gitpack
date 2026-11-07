# ☄️ Comet-Syzygy-Gitpack

`Comet-Syzygy-Gitpack` is an official extension for **Flux Syzygy**. It inspects your project directories, surfaces outdated dependencies across multiple package managers, and updates them through an interactive UI with an integrated terminal.

## ✨ Features

- 🗂️ **Universal Package Detection:** Automatically parses `package.json`, `pnpm-lock.yaml`, `yarn.lock`, and .NET project/solution files (`.sln`, `.*proj`) up to two directory levels deep.
- 🛰️ **Visual Status Badges:** Displays real-time indicators on your project card:
  - `↑3` – Outdated dependencies found (Red: major version release available; Amber: minor or patch updates available).
  - `✓` – All dependencies up to date.
  - `!` – Inspection check failed.
  - `…` – Inspection check currently in progress.
  - *Hover for exact breakdowns (e.g., "1 major, 2 minor"). Click to launch the updates manager.*
- 🎯 **Framework & Tooling Awareness:** Automatically tags well-known frameworks (Next.js, React, discord.js, TypeScript, Electron) for rapid identification.
- ⚡ **Background Caching Engine:** Remembers inspection states for immediate dashboard load times. Automatically background-refreshes stale data (older than 6 hours) every 30 minutes.
- 💻 **Integrated Console:** Features an embedded shell for live command tracking, custom executions, command history recall, execution cancellation (<kbd>Ctrl</kbd>+<kbd>C</kbd> / **Stop**), and quick security checks (`npm audit`).

---

## 🚀 Supported Ecosystems

| Kind | Detection File | Check Command | Update Command |
|---|---|---|---|
| **Node (npm)** *(Next.js, React, etc.)* | `package.json` | `npm outdated --json --long` | `npm install name@version` |
| **Node (pnpm)** | `pnpm-lock.yaml` | `pnpm outdated --format json` | `pnpm update name@version` |
| **Node (Yarn)** | `yarn.lock` | `npm outdated` | `yarn upgrade` (Classic) / `yarn up` (Berry) |
| **.NET (NuGet)** | `.sln` or `.*proj` | `dotnet list package --outdated` | `dotnet add <project> package <id> --version <v>` |

---

## 🔌 Installation

1. Extract the `Comet-Syzygy-Gitpack` directory into Flux Syzygy's extension directory (**Settings** $\rightarrow$ **Extensions** $\rightarrow$ **Open extensions folder**).
2. Click **Reload extensions** inside the dashboard.

> **Note:** Requires a version of Flux Syzygy with extension API support. CLI tools (`npm`, `pnpm`, `yarn`, `dotnet`) must be installed and exposed on your system `PATH`.
