import { Terminal } from "/lib/xterm.mjs";
import { FitAddon } from "/lib/addon-fit.mjs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { open } from "@tauri-apps/plugin-dialog";

// Keep in sync with tauri.conf.json app.windows[0].{width,height}.
const DEFAULT_WINDOW_WIDTH = 920;
const DEFAULT_WINDOW_HEIGHT = 1164;

let suppressTerminalDoneCount = 0;
let cancelled = false;
// Set by a caller that will write its own exit status (e.g. compare, which
// distinguishes "no diffs", "diffs found", and "error"). Consumed once by
// the terminal-done listener.
let suppressNextExitLine = false;

const STORE_KEY_REFERENCE = "files-reference";
const STORE_KEY_CURRENT = "files-current";
const STORE_KEY_WORKDIR = "workdir";
const STORE_KEY_VTESTS = "vtests-dir";
const STORE_KEY_TESTFILES = "testfiles-dir";
const STORE_KEY_OPEN_BROWSER = "open-browser-after-compare";
const STORE_KEY_THEME = "theme";

const SCRIPT_GENERATE = "vtest-generate-pngs.sh";
const SCRIPT_COMPARE = "vtest-compare-pngs.sh";

function basename(filePath) {
  return filePath.replace(/.*[\\/]/, "");
}

// Populated at init from the Rust `platform` command. Using navigator.userAgent
// is fragile across webview versions — the backend is the authoritative source.
let platform = "linux";
let PATH_SEP = "/";

function joinPath(...parts) {
  return parts.join(PATH_SEP);
}

function getPlatformFileFilter() {
  if (platform === "windows") return { name: "Executable", extensions: ["exe"] };
  if (platform === "macos")   return { name: "Application", extensions: ["app"] };
  return { name: "AppImage", extensions: ["AppImage"] };
}

function isAllowedExecutable(filePath) {
  const { extensions } = getPlatformFileFilter();
  return extensions.some((ext) => filePath.toLowerCase().endsWith("." + ext.toLowerCase()));
}

function hasAnyData() {
  return (
    !!localStorage.getItem(STORE_KEY_REFERENCE) ||
    !!localStorage.getItem(STORE_KEY_CURRENT) ||
    !!localStorage.getItem(STORE_KEY_WORKDIR) ||
    !!localStorage.getItem(STORE_KEY_VTESTS) ||
    !!localStorage.getItem(STORE_KEY_TESTFILES)
  );
}

function updateResetButton(btnReset) {
  btnReset.disabled = !hasAnyData();
}

let updateActionButtonsGen = 0;

async function updateActionButtons() {
  // Multiple callers may invoke this concurrently (handlers don't await it).
  // Bail if a newer invocation has started so stale path_exists results
  // cannot overwrite fresher disabled states.
  const myGen = ++updateActionButtonsGen;

  const workdir = localStorage.getItem(STORE_KEY_WORKDIR);
  const vtestsDirValid = !document.getElementById("vtests-path").classList.contains("path-invalid");
  const dirsSet =
    !!workdir &&
    !!localStorage.getItem(STORE_KEY_VTESTS) &&
    !!localStorage.getItem(STORE_KEY_TESTFILES) &&
    vtestsDirValid;
  const hasReference = !!localStorage.getItem(STORE_KEY_REFERENCE);
  const hasCurrent = !!localStorage.getItem(STORE_KEY_CURRENT);
  const hasBoth = hasReference && hasCurrent;

  let canCompare = false;
  if (dirsSet) {
    const [hasRef, hasCur] = await Promise.all([
      invoke("path_exists", { path: joinPath(workdir, "ref") }),
      invoke("path_exists", { path: joinPath(workdir, "current") }),
    ]);
    canCompare = hasRef && hasCur;
  }

  const hasDiffReport = !!workdir && await invoke("path_exists", { path: joinPath(workdir, "diff", "vtest_compare.html") });

  if (myGen !== updateActionButtonsGen) return;

  document.getElementById("btn-gen-reference").disabled = !(dirsSet && hasReference);
  document.getElementById("btn-gen-current").disabled = !(dirsSet && hasCurrent);
  document.getElementById("btn-gen-all").disabled = !(dirsSet && hasBoth);
  document.getElementById("btn-compare").disabled = !(canCompare && dirsSet);
  document.getElementById("btn-gen-all-compare").disabled = !(dirsSet && hasBoth);
  document.getElementById("btn-open-browser").disabled = !hasDiffReport;
}

const ALWAYS_ENABLED_BUTTON_IDS = new Set(["btn-cancel", "btn-reset-window"]);

function disableAllButtons() {
  document.querySelectorAll("button").forEach((btn) => {
    if (ALWAYS_ENABLED_BUTTON_IDS.has(btn.id) || btn.classList.contains("btn-info")) return;
    btn.disabled = true;
  });
  document.getElementById("btn-cancel").disabled = false;
}

async function reenableAllButtons() {
  document.getElementById("btn-cancel").disabled = true;
  for (const id of ["btn-workdir", "btn-vtests", "btn-testfiles"])
    document.getElementById(id).disabled = false;
  updateResetButton(document.getElementById("btn-reset"));
  await updateActionButtons();
}

function syncDirButton(btn, hasValue) {
  btn.textContent = hasValue ? "Change..." : "Set...";
}

function setPathEl(el, value) {
  if (value) {
    el.textContent = value;
    el.classList.remove("path-unset");
  } else {
    el.textContent = "(not set)";
    el.classList.add("path-unset");
  }
}

async function validateStoredPath(key) {
  const value = localStorage.getItem(key);
  if (!value) return null;
  const exists = await invoke("path_exists", { path: value });
  if (!exists) {
    localStorage.removeItem(key);
    return null;
  }
  return value;
}

async function showVersion(versionEl, filePath) {
  let version = null;
  try {
    version = await invoke("get_executable_version", { path: filePath });
  } catch {
    // Version detection is best-effort; a probe failure must not bubble up
    // as an unhandled rejection.
  }
  if (version) {
    versionEl.textContent = "Detected version: " + version;
    versionEl.classList.add("visible");
  } else {
    versionEl.textContent = "";
    versionEl.classList.remove("visible");
  }
}

function setupDropZone(zoneId, fileNameId, storeKey, initialPath, btnReset, term) {
  const zone = document.getElementById(zoneId);
  const fileNameEl = document.getElementById(fileNameId);
  const versionEl = document.getElementById("version-" + zoneId.replace("drop-", ""));
  let filePath = initialPath;

  function render() {
    fileNameEl.textContent = filePath ? basename(filePath) : "";
    zone.classList.toggle("has-file", !!filePath);
    if (!filePath) {
      versionEl.textContent = "";
      versionEl.classList.remove("visible");
    }
  }

  render();
  if (filePath) showVersion(versionEl, filePath);

  function clear() {
    filePath = null;
    localStorage.removeItem(storeKey);
    render();
  }

  async function setPath(path) {
    filePath = path;
    localStorage.setItem(storeKey, path);
    render();
    try {
      await invoke("set_executable", { path });
    } catch (e) {
      term.write(`\r\n\x1b[31mError setting executable bit: ${e?.message ?? e}\x1b[0m\r\n`);
    }
    updateResetButton(btnReset);
    updateActionButtons();
    showVersion(versionEl, path);
  }

  zone.addEventListener("click", async () => {
    const selected = await open({ multiple: false, filters: [getPlatformFileFilter()] });
    if (selected) await setPath(selected);
  });

  zone.addEventListener("keydown", (e) => {
    // Drop zone is a div with role="button"; browsers don't synthesize click
    // from Enter/Space the way they do for real buttons, so we do it here.
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      zone.click();
    }
  });

  async function handlePaths(paths) {
    const accepted = paths.filter(isAllowedExecutable);
    const rejected = paths.filter((p) => !isAllowedExecutable(p));

    if (rejected.length > 0) {
      const exts = getPlatformFileFilter().extensions.map((e) => "." + e).join("/");
      const names = rejected.map(basename).join(", ");
      term.write(`\r\n\x1b[33mWarning: ignored file(s) not matching ${exts}: ${names}\x1b[0m\r\n`);
    }

    // UI holds a single executable — if several are dropped, last one wins.
    if (accepted.length > 0) await setPath(accepted[accepted.length - 1]);
  }

  return { element: zone, handlePaths, clear };
}

function zoneFromPosition(position, zones) {
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(position.x / dpr, position.y / dpr);
  if (!el) return null;
  return zones.find((z) => z.element.contains(el)) ?? null;
}

async function setupDragDrop(zones) {
  await getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "leave") {
      for (const z of zones) z.element.classList.remove("drag-over");
      return;
    }
    if (p.type === "enter" || p.type === "over") {
      const hit = zoneFromPosition(p.position, zones);
      for (const z of zones) z.element.classList.toggle("drag-over", z === hit);
      return;
    }
    if (p.type === "drop") {
      for (const z of zones) z.element.classList.remove("drag-over");
      const hit = zoneFromPosition(p.position, zones);
      if (hit) hit.handlePaths(p.paths);
    }
  });
}

const THEMES = {
  dark: {
    background: "#1a1a1a",
    foreground: "#f0f0f0",
    cursor: "#f0f0f0",
    selectionBackground: "#4a4a6a",
  },
  light: {
    background: "#f0f0f0",
    foreground: "#1a1a1a",
    cursor: "#1a1a1a",
    selectionBackground: "#b0c4de",
  },
};

function currentEffectiveTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function setTheme(choice, term) {
  const effective = choice === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : choice;
  document.documentElement.setAttribute("data-theme", effective);
  if (term) term.options.theme = THEMES[effective];
  localStorage.setItem(STORE_KEY_THEME, choice);
}

function initTerminal() {
  const term = new Terminal({
    theme: THEMES[currentEffectiveTheme()],
    fontFamily: "monospace",
    fontSize: 13,
    convertEol: true,
    scrollback: 5000,
    // This terminal is output-only — the app streams stdout/stderr into it
    // but never reads user input. Turn off the blinking cursor and input
    // handling so it doesn't invite typing that goes nowhere.
    cursorBlink: false,
    disableStdin: true,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById("terminal"));
  fitAddon.fit();

  window.addEventListener("resize", () => fitAddon.fit());

  listen("terminal-output", (event) => term.write(event.payload));
  listen("terminal-done", (event) => {
    const code = event.payload;
    const ok = code === 0;
    // Only suppress successful intermediate steps in a sequence; a failure
    // must always surface so the user can see something went wrong.
    if (ok && suppressTerminalDoneCount > 0) {
      suppressTerminalDoneCount--;
      return;
    }
    suppressTerminalDoneCount = 0;
    // A cancelled run always shows [cancelled], even if a caller pre-armed
    // a replacement status — the user's stop trumps any planned message.
    const writeGeneric = cancelled || !suppressNextExitLine;
    suppressNextExitLine = false;
    if (writeGeneric) {
      if (cancelled) {
        // User-initiated stop: show gray [cancelled] instead of red
        // [process exited], which would wrongly imply a script failure.
        term.write(`\r\n\x1b[90m[cancelled]\x1b[0m\r\n`);
      } else {
        const color = ok ? "\x1b[90m" : "\x1b[31m";
        term.write(`\r\n${color}[process exited]\x1b[0m\r\n`);
      }
    }
    reenableAllButtons();
  });

  return term;
}

const INFO_TEXT = {
  workdir:   "The working directory is where vtests writes its output files during a test run.\n\nExisting contents may be permanently deleted at the start of each run.",
  vtests:    "The directory containing the vtests scripts (typically the vtests folder inside a MuseScore repository clone, e.g. MuseScore/vtests).",
  testfiles: "The directory containing the MuseScore Studio project files that vtests uses when generating and comparing results.",
};

async function validateVtestsDir(dirPath, pathEl, term) {
  const scripts = [SCRIPT_COMPARE, SCRIPT_GENERATE];
  let missing;
  try {
    const results = await Promise.all(
      scripts.map((s) => invoke("path_exists", { path: joinPath(dirPath, s) }))
    );
    missing = scripts.filter((_, i) => !results[i]);
  } catch (e) {
    term.write(`\r\n\x1b[31mError validating vtests directory: ${e?.message ?? e}\x1b[0m\r\n`);
    return;
  }
  if (missing.length > 0) {
    const tooltipMsg = "The selected vtests directory does not appear to be valid.";
    const termMsg = `The selected vtests directory does not appear to be valid (could not find: ${missing.join(", ")}).`;
    pathEl.classList.add("path-invalid");
    pathEl.dataset.warning = tooltipMsg;
    term.write(`\r\n\x1b[33mWarning: ${termMsg}\x1b[0m\r\n`);
  } else {
    pathEl.classList.remove("path-invalid");
    delete pathEl.dataset.warning;
  }
  updateActionButtons();
}

async function preflightBash(term) {
  if (platform !== "windows") return;
  const hasBash = await invoke("command_exists", { name: "bash" });
  if (!hasBash) {
    term.write(
      "\x1b[31mWarning: bash was not found on PATH. The vtests scripts " +
      "require bash plus standard Unix tools (imagemagick, coreutils). " +
      "Install Git Bash or enable WSL to proceed.\x1b[0m\r\n\n"
    );
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  const term = initTerminal();

  const themeSelect = document.getElementById("theme-select");
  const initialThemeChoice = localStorage.getItem(STORE_KEY_THEME) || "system";
  themeSelect.value = initialThemeChoice;
  setTheme(initialThemeChoice, term);
  themeSelect.addEventListener("change", () => setTheme(themeSelect.value, term));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themeSelect.value === "system") setTheme("system", term);
  });

  // Safety net: any invoke() or other async rejection that escapes a
  // handler-local try/catch surfaces in the terminal instead of disappearing
  // into the devtools console.
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    term.write(`\r\n\x1b[31mUnhandled error: ${reason?.message ?? reason}\x1b[0m\r\n`);
  });

  // Resolve platform before anything that calls joinPath / getPlatformFileFilter.
  try {
    platform = await invoke("platform");
  } catch (e) {
    term.write(`\r\n\x1b[31mError detecting platform: ${e?.message ?? e}\x1b[0m\r\n`);
  }
  PATH_SEP = platform === "windows" ? "\\" : "/";

  await preflightBash(term);

  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  document.body.appendChild(tooltip);

  const showInfoTooltip = (btn) => {
    tooltip.textContent = INFO_TEXT[btn.dataset.info];
    tooltip.style.display = "block";
    const r = btn.getBoundingClientRect();
    tooltip.style.left = (r.right + 10) + "px";
    tooltip.style.top = r.top + "px";
  };
  const hideInfoTooltip = () => {
    tooltip.style.display = "none";
  };
  document.querySelectorAll(".btn-info").forEach((btn) => {
    btn.addEventListener("mouseenter", () => showInfoTooltip(btn));
    btn.addEventListener("mouseleave", hideInfoTooltip);
    // Keyboard parity: Tab-focusing the ? button should show the same help
    // text that hovering does.
    btn.addEventListener("focus", () => showInfoTooltip(btn));
    btn.addEventListener("blur", hideInfoTooltip);
  });
  const btnReset = document.getElementById("btn-reset");

  const [refPath, curPath, workdir, vtests, testfiles] = await Promise.all([
    validateStoredPath(STORE_KEY_REFERENCE),
    validateStoredPath(STORE_KEY_CURRENT),
    validateStoredPath(STORE_KEY_WORKDIR),
    validateStoredPath(STORE_KEY_VTESTS),
    validateStoredPath(STORE_KEY_TESTFILES),
  ]);

  const refZone = setupDropZone("drop-reference", "file-reference", STORE_KEY_REFERENCE, refPath, btnReset, term);
  const curZone = setupDropZone("drop-current", "file-current", STORE_KEY_CURRENT, curPath, btnReset, term);
  setupDragDrop([refZone, curZone]);

  updateResetButton(btnReset);
  updateActionButtons();

  btnReset.addEventListener("click", () => {
    term.clear();
    const savedTheme = localStorage.getItem(STORE_KEY_THEME);
    localStorage.clear();
    if (savedTheme) localStorage.setItem(STORE_KEY_THEME, savedTheme);
    refZone.clear();
    curZone.clear();
    setPathEl(document.getElementById("workdir-path"), null);
    setPathEl(document.getElementById("vtests-path"), null);
    setPathEl(document.getElementById("testfiles-path"), null);
    syncDirButton(document.getElementById("btn-workdir"), false);
    syncDirButton(document.getElementById("btn-vtests"), false);
    syncDirButton(document.getElementById("btn-testfiles"), false);
    const vp = document.getElementById("vtests-path");
    vp.classList.remove("path-invalid");
    delete vp.dataset.warning;
    document.getElementById("chk-open-browser").checked = true;
    updateResetButton(btnReset);
    updateActionButtons();
  });

  const btnWorkdir = document.getElementById("btn-workdir");
  const pathEl = document.getElementById("workdir-path");

  setPathEl(pathEl, workdir);
  syncDirButton(btnWorkdir, !!workdir);

  btnWorkdir.addEventListener("click", async () => {
    term.clear();
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      setPathEl(pathEl, selected);
      syncDirButton(btnWorkdir, true);
      localStorage.setItem(STORE_KEY_WORKDIR, selected);
      updateResetButton(btnReset);
      updateActionButtons();
    }
  });

  const btnVtests = document.getElementById("btn-vtests");
  const vtestsPathEl = document.getElementById("vtests-path");

  setPathEl(vtestsPathEl, vtests);
  syncDirButton(btnVtests, !!vtests);
  if (vtests) validateVtestsDir(vtests, vtestsPathEl, term);

  vtestsPathEl.addEventListener("mouseenter", () => {
    if (!vtestsPathEl.dataset.warning) return;
    tooltip.textContent = vtestsPathEl.dataset.warning;
    tooltip.style.display = "block";
    const r = vtestsPathEl.getBoundingClientRect();
    tooltip.style.left = r.left + "px";
    tooltip.style.top = (r.bottom + 6) + "px";
  });
  vtestsPathEl.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
  });

  btnVtests.addEventListener("click", async () => {
    term.clear();
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      setPathEl(vtestsPathEl, selected);
      syncDirButton(btnVtests, true);
      validateVtestsDir(selected, vtestsPathEl, term);
      localStorage.setItem(STORE_KEY_VTESTS, selected);
      updateResetButton(btnReset);
      updateActionButtons();
    }
  });

  const btnTestfiles = document.getElementById("btn-testfiles");
  const testfilesPathEl = document.getElementById("testfiles-path");

  setPathEl(testfilesPathEl, testfiles);
  syncDirButton(btnTestfiles, !!testfiles);

  btnTestfiles.addEventListener("click", async () => {
    term.clear();
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      setPathEl(testfilesPathEl, selected);
      syncDirButton(btnTestfiles, true);
      localStorage.setItem(STORE_KEY_TESTFILES, selected);
      updateResetButton(btnReset);
      updateActionButtons();
    }
  });

  document.getElementById("btn-reset-window").addEventListener("click", async () => {
    const win = getCurrentWindow();
    try {
      await win.setSize(new LogicalSize(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT));
      await win.center();
    } catch (e) {
      term.write(`\r\n\x1b[31mError resetting window geometry: ${e?.message ?? e}\x1b[0m\r\n`);
    }
  });

  document.getElementById("btn-cancel").addEventListener("click", () => {
    cancelled = true;
    // The cancelled run's terminal-done must re-enable the UI, not be swallowed
    // by a pending sequence-suppression count.
    suppressTerminalDoneCount = 0;
    invoke("cancel_command");
  });

  // If `work` throws before any run_command spawned (e.g. prepare_output_dir
  // rejects the workdir), no terminal-done event will ever arrive to
  // re-enable the UI — so we re-enable here. If a command did spawn, its
  // Cleanup drop guard emits terminal-done and re-enables the UI; this catch
  // then re-enables again, which is idempotent.
  async function runWithUi(sequenceSuppressCount, work) {
    term.clear();
    disableAllButtons();
    cancelled = false;
    suppressTerminalDoneCount = sequenceSuppressCount;
    try {
      await work();
    } catch (e) {
      term.write(`\r\n\x1b[31mError: ${e?.message ?? e}\x1b[0m\r\n`);
      await reenableAllButtons();
    } finally {
      suppressTerminalDoneCount = 0;
    }
  }

  async function generateReference() {
    const vtestsDir = localStorage.getItem(STORE_KEY_VTESTS);
    const workdir = localStorage.getItem(STORE_KEY_WORKDIR);
    const outputDir = joinPath(workdir, "ref");
    const mscore = localStorage.getItem(STORE_KEY_REFERENCE);
    const scores = localStorage.getItem(STORE_KEY_TESTFILES);
    const script = joinPath(vtestsDir, SCRIPT_GENERATE);
    term.write(`${script} --output-dir ${outputDir} --mscore ${mscore} --scores ${scores}\r\n\n`);
    await invoke("prepare_output_dir", { workdir, subdir: "ref" });
    return await invoke("run_command", {
      program: script,
      args: ["--output-dir", outputDir, "--mscore", mscore, "--scores", scores],
    });
  }

  async function generateCurrent() {
    const vtestsDir = localStorage.getItem(STORE_KEY_VTESTS);
    const workdir = localStorage.getItem(STORE_KEY_WORKDIR);
    const outputDir = joinPath(workdir, "current");
    const mscore = localStorage.getItem(STORE_KEY_CURRENT);
    const scores = localStorage.getItem(STORE_KEY_TESTFILES);
    const script = joinPath(vtestsDir, SCRIPT_GENERATE);
    term.write(`${script} --output-dir ${outputDir} --mscore ${mscore} --scores ${scores}\r\n\n`);
    await invoke("prepare_output_dir", { workdir, subdir: "current" });
    return await invoke("run_command", {
      program: script,
      args: ["--output-dir", outputDir, "--mscore", mscore, "--scores", scores],
    });
  }

  async function compare() {
    const vtestsDir = localStorage.getItem(STORE_KEY_VTESTS);
    const workdir = localStorage.getItem(STORE_KEY_WORKDIR);
    const refDir = joinPath(workdir, "ref");
    const currentDir = joinPath(workdir, "current");
    const outputDir = joinPath(workdir, "diff");
    const script = joinPath(vtestsDir, SCRIPT_COMPARE);
    term.write(`${script} --reference-dir ${refDir} --current-dir ${currentDir} --output-dir ${outputDir}\r\n\n`);
    await invoke("prepare_output_dir", { workdir, subdir: "diff" });
    // vtest-compare-pngs.sh exits 1 when diffs are found — that isn't a
    // failure, so replace the generic [process exited] with our own status
    // interpreted from (exit code, report presence).
    suppressNextExitLine = true;
    const code = await invoke("run_command", {
      program: script,
      args: ["--reference-dir", refDir, "--current-dir", currentDir, "--output-dir", outputDir],
    });
    if (cancelled) return code;
    const reportPath = joinPath(outputDir, "vtest_compare.html");
    const reportExists = await invoke("path_exists", { path: reportPath });
    if (reportExists) {
      term.write(`\r\n\x1b[33mDiffs found.\x1b[0m\r\n`);
      if (document.getElementById("chk-open-browser").checked)
        await invoke("open_path", { path: reportPath });
    } else if (code === 0) {
      term.write(`\r\n\x1b[32mNo diffs found.\x1b[0m\r\n`);
    } else {
      term.write(`\r\n\x1b[31mCompare failed (exit code ${code}).\x1b[0m\r\n`);
    }
    return code;
  }

  document.getElementById("btn-gen-reference").addEventListener("click", () =>
    runWithUi(0, generateReference),
  );

  document.getElementById("btn-gen-current").addEventListener("click", () =>
    runWithUi(0, generateCurrent),
  );

  document.getElementById("btn-gen-all").addEventListener("click", () =>
    runWithUi(1, async () => {
      const code = await generateReference();
      if (cancelled || code !== 0) return;
      await generateCurrent();
    }),
  );

  document.getElementById("btn-compare").addEventListener("click", () =>
    runWithUi(0, compare),
  );

  document.getElementById("btn-gen-all-compare").addEventListener("click", () =>
    runWithUi(2, async () => {
      const refCode = await generateReference();
      if (cancelled || refCode !== 0) return;
      const curCode = await generateCurrent();
      if (cancelled || curCode !== 0) return;
      await compare();
    }),
  );

  const chkOpenBrowser = document.getElementById("chk-open-browser");
  chkOpenBrowser.checked = localStorage.getItem(STORE_KEY_OPEN_BROWSER) !== "false";
  chkOpenBrowser.addEventListener("change", () => {
    localStorage.setItem(STORE_KEY_OPEN_BROWSER, chkOpenBrowser.checked);
  });

  document.getElementById("btn-open-browser").addEventListener("click", async () => {
    const workdir = localStorage.getItem(STORE_KEY_WORKDIR);
    await invoke("open_path", { path: joinPath(workdir, "diff", "vtest_compare.html") });
  });
});
