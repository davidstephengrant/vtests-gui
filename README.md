# vtests-gui

A desktop GUI for running [MuseScore](https://github.com/musescore/MuseScore) visual regression tests (`vtests`) and comparing reference vs. current renders.

Wraps the `vtest-generate-pngs.sh` and `vtest-compare-pngs.sh` scripts shipped with MuseScore, and streams their output into an embedded terminal. Built with [Tauri 2](https://tauri.app/) (Rust backend + vanilla HTML/CSS/JS frontend).

## Acknowledgments

Developed with the assistance of [Claude Code](https://claude.com/claude-code), Anthropic's agentic coding CLI.

## Features

- Pick two MuseScore Studio builds (reference and current) via drag-and-drop or file picker
- Generate PNG renders for either build, or both in sequence
- Compare the two render sets and open the resulting HTML diff report in the browser
- Cross-platform: Linux (AppImage), macOS (.app), Windows (.exe)
- Detects and displays the MuseScore version of each selected executable
- Remembers paths and preferences between runs
- Light / dark / system theme
- Cancel a running job at any time

## Prerequisites

### Runtime (to use the app)

- A clone of the [MuseScore repository](https://github.com/musescore/MuseScore) — the app runs the scripts from its `vtest/` directory.
- One or two MuseScore Studio builds to test (`.AppImage` on Linux, `.app` on macOS, `.exe` on Windows).
- A directory of MuseScore project files to render.
- **Windows only:** `bash` plus standard Unix tools (ImageMagick, coreutils) on `PATH`. Install [Git Bash](https://git-scm.com/download/win) or enable WSL.
- **Linux / macOS:** ImageMagick and coreutils (usually preinstalled on macOS; install via your package manager on Linux).

### Build (to compile from source)

- [Node.js](https://nodejs.org/) 18+ and npm
- [Rust](https://rustup.rs/) (stable toolchain)
- Tauri 2 platform dependencies — see the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/) for your OS (e.g. `webkit2gtk` on Linux, Xcode Command Line Tools on macOS, WebView2 on Windows).

## Build

```bash
git clone https://github.com/davidstephengrant/vtests-gui.git
cd vtests-gui
npm install
```

### Run in development mode

```bash
npm run tauri -- dev
```

This launches the app with hot-reload on the frontend.

### Build a release bundle

```bash
npm run tauri -- build
```

Installers and binaries are written to `src-tauri/target/release/bundle/`.

## Usage

1. **Set the two MuseScore executables** by dropping them onto the *Reference build* and *Current build* zones, or clicking to browse.
2. **Set the three directories:**
   - *Working directory* — where the app writes `ref/`, `current/`, and `diff/` subdirectories. **Existing contents may be deleted at the start of each run.**
   - *vtest directory* — the `vtest/` folder inside your MuseScore repository clone.
   - *Test scores directory* — the folder containing the `.mscz` / `.mscx` files to render.
3. **Generate and compare:**
   - *Generate reference* / *Generate current* — render one build's PNGs.
   - *Generate all* — render both in sequence.
   - *Compare* — diff the two render sets; opens `diff/vtest_compare.html` in your browser when diffs are found (toggleable).
   - *Generate all and compare* — the full pipeline in one click.

## Project layout

```
src/           Frontend (HTML, CSS, JS) — served by Tauri at runtime
src-tauri/     Rust backend — Tauri commands for running scripts,
               detecting executable versions, managing the workdir, etc.
```

## License

Released under the [GNU General Public License v3.0 or later](LICENSE).
