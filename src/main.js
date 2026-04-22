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
// Absolute path of the session-wide log file (in the OS app-data dir). Set
// once at app start by init_session_log; null if that initialization failed.
let sessionLogPath = null;
const LOG_ROTATION_KEEP = 5;

// Fire-and-forget: append a single timestamped line to the session log.
// No-op if the log wasn't initialized.
function logEvent(message) {
  invoke("log_event", { message }).catch(() => { /* best-effort */ });
}

// Human-readable labels for paths we log when the user changes them.
const LABEL_BY_STORE_KEY = {
  "files-reference": "reference build",
  "files-current": "current build",
  "workdir": "working directory",
  "vtests-dir": "vtest directory",
  "testfiles-dir": "test scores directory",
};

const STORE_KEY_REFERENCE = "files-reference";
const STORE_KEY_CURRENT = "files-current";
const STORE_KEY_WORKDIR = "workdir";
const STORE_KEY_VTESTS = "vtests-dir";
const STORE_KEY_TESTFILES = "testfiles-dir";
const STORE_KEY_OPEN_BROWSER = "open-browser-after-compare";
const STORE_KEY_COMPARE_AFTER = "compare-after-generate";
const STORE_KEY_ACTION = "generate-action";
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

  const canRun = {
    "gen-reference": dirsSet && hasReference,
    "gen-current": dirsSet && hasCurrent,
    "gen-all": dirsSet && hasBoth,
  };
  for (const item of document.querySelectorAll("#split-generate-menu .split-menu-item")) {
    item.disabled = !canRun[item.dataset.action];
  }
  const splitMain = document.getElementById("split-generate-main");
  splitMain.disabled = !canRun[splitMain.dataset.action];
  document.getElementById("btn-compare").disabled = !(canCompare && dirsSet);
  document.getElementById("btn-open-browser").disabled = !hasDiffReport;
  document.getElementById("btn-open-workdir").disabled = !workdir;
  document.getElementById("btn-validate-testfiles").disabled = !localStorage.getItem(STORE_KEY_TESTFILES);
}

function showProgress(label, total) {
  document.getElementById("progress-label").textContent = label;
  document.getElementById("progress-fill").style.width = "0%";
  document.getElementById("progress-count").textContent = `0 / ${total}`;
  document.getElementById("progress").hidden = false;
}

function setProgress(processed, total) {
  const shown = Math.min(processed, total);
  const pct = total > 0 ? (shown / total) * 100 : 0;
  document.getElementById("progress-fill").style.width = `${pct}%`;
  document.getElementById("progress-count").textContent = `${shown} / ${total}`;
}

function hideProgress() {
  document.getElementById("progress").hidden = true;
}

const ALWAYS_ENABLED_BUTTON_IDS = new Set([
  "btn-cancel",
  "btn-reset-window",
  // Opens the log directory in the OS file manager; safe to click at any
  // time, including mid-run, since it doesn't touch the running script.
  "btn-open-logs",
  // Modal buttons live inside a hidden overlay during runs, so disabling
  // them here just leaves them stuck disabled next time the modal opens —
  // reenableAllButtons only re-enables a specific allowlist. Keep them out.
  "btn-validate-cancel",
  "btn-validate-confirm",
]);

function disableAllButtons() {
  document.querySelectorAll("button").forEach((btn) => {
    if (ALWAYS_ENABLED_BUTTON_IDS.has(btn.id) || btn.classList.contains("btn-info")) return;
    btn.disabled = true;
  });
  document.getElementById("btn-cancel").disabled = false;
}

async function reenableAllButtons() {
  document.getElementById("btn-cancel").disabled = true;
  hideProgress();
  for (const id of ["btn-workdir", "btn-vtests", "btn-testfiles", "split-generate-toggle"])
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

function setupDropZone(zoneId, fileNameId, storeKey, initialPath, btnReset, term) {
  const zone = document.getElementById(zoneId);
  const fileNameEl = document.getElementById(fileNameId);
  let filePath = initialPath;

  function render() {
    fileNameEl.textContent = filePath ? basename(filePath) : "";
    zone.classList.toggle("has-file", !!filePath);
  }

  render();

  function clear() {
    filePath = null;
    localStorage.removeItem(storeKey);
    render();
    logEvent(`${LABEL_BY_STORE_KEY[storeKey] ?? storeKey}: cleared`);
  }

  async function setPath(path) {
    filePath = path;
    localStorage.setItem(storeKey, path);
    render();
    logEvent(`${LABEL_BY_STORE_KEY[storeKey] ?? storeKey}: ${path}`);
    try {
      await invoke("set_executable", { path });
    } catch (e) {
      const msg = e?.message ?? e;
      term.write(`\r\n\x1b[31mError setting executable bit: ${msg}\x1b[0m\r\n`);
      logEvent(`error: setting executable bit: ${msg}`);
    }
    updateResetButton(btnReset);
    updateActionButtons();
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
      logEvent(`warning: ignored file(s) not matching ${exts}: ${names}`);
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

function setupPersistedCheckbox(id, storeKey) {
  const el = document.getElementById(id);
  el.checked = localStorage.getItem(storeKey) !== "false";
  el.addEventListener("change", () => {
    localStorage.setItem(storeKey, el.checked);
  });
  return el;
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

  // Qt emits `qt.qml.typeregistration: ...` chatter on stderr that clutters
  // the terminal without adding signal. Buffer by line so we can drop those
  // lines wholesale before writing. Payloads arrive as arbitrary chunks that
  // may split or merge lines, so match on whole lines only.
  let outBuf = "";
  let hiddenWarnings = 0;
  const dropLine = (line) => /qt\.qml\.typeregistration/.test(line);
  listen("terminal-output", (event) => {
    outBuf += event.payload;
    let out = "";
    let idx;
    while ((idx = outBuf.indexOf("\n")) !== -1) {
      const line = outBuf.slice(0, idx);
      outBuf = outBuf.slice(idx + 1);
      if (dropLine(line)) hiddenWarnings++;
      else out += line + "\n";
    }
    if (out) term.write(out);
  });
  listen("terminal-done", (event) => {
    const code = event.payload;
    const ok = code === 0;
    logEvent(`run finished: ${cancelled ? "stopped" : (code === null ? "no exit code" : `exit ${code}`)}`);
    if (hiddenWarnings > 0) {
      const plural = hiddenWarnings === 1 ? "" : "s";
      const logNote = sessionLogPath ? ` See ${basename(sessionLogPath)} for unfiltered output.` : "";
      term.write(
        `\r\n\x1b[33mHid ${hiddenWarnings} qt.qml.typeregistration warning${plural}.${logNote}\x1b[0m\r\n`,
      );
      logEvent(`warning: hid ${hiddenWarnings} qt.qml.typeregistration warning${plural}`);
      hiddenWarnings = 0;
    }
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
  vtests:    "The directory containing the vtest scripts (typically the vtest folder inside a MuseScore repository clone, e.g. MuseScore/vtest).",
  testfiles: "The directory containing the MuseScore Studio test scores that vtests uses when generating and comparing results.",
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
    const msg = e?.message ?? e;
    term.write(`\r\n\x1b[31mError validating vtest directory: ${msg}\x1b[0m\r\n`);
    logEvent(`error: validating vtest directory: ${msg}`);
    return;
  }
  if (missing.length > 0) {
    const tooltipMsg = "The selected vtest directory does not appear to be valid.";
    const termMsg = `The selected vtest directory does not appear to be valid (could not find: ${missing.join(", ")}).`;
    pathEl.classList.add("path-invalid");
    pathEl.dataset.warning = tooltipMsg;
    term.write(`\r\n\x1b[33mWarning: ${termMsg}\x1b[0m\r\n`);
    logEvent(`warning: ${termMsg}`);
  } else {
    pathEl.classList.remove("path-invalid");
    delete pathEl.dataset.warning;
  }
  updateActionButtons();
}

async function checkTestfileNames(dir, term) {
  try {
    const renames = await invoke("scan_testfile_names", { dir });
    if (renames.length === 0) return;
    const n = renames.length;
    const warnMsg =
      `${n} file${n === 1 ? " has" : "s have"} invalid ` +
      `name${n === 1 ? "" : "s"} in the test scores directory — vtest scripts ` +
      `may fail on these. Click "Validate filenames..." to review and rename.`;
    term.write(`\r\n\x1b[33mWarning: ${warnMsg}\x1b[0m\r\n`);
    logEvent(`warning: ${warnMsg}`);
  } catch (e) {
    const msg = e?.message ?? e;
    term.write(`\r\n\x1b[31mError scanning test scores directory: ${msg}\x1b[0m\r\n`);
    logEvent(`error: scanning test scores directory: ${msg}`);
  }
}

async function preflightBash(term) {
  if (platform !== "windows") return;
  const hasBash = await invoke("command_exists", { name: "bash" });
  if (!hasBash) {
    const msg = "bash was not found on PATH. The vtest scripts " +
      "require bash plus standard Unix tools (imagemagick, coreutils). " +
      "Install Git Bash or enable WSL to proceed.";
    term.write(`\x1b[31mWarning: ${msg}\x1b[0m\r\n\n`);
    logEvent(`warning: ${msg}`);
  }
}

function setupValidateTestfiles(term) {
  const btnOpen = document.getElementById("btn-validate-testfiles");
  const modal = document.getElementById("validate-modal");
  const summary = document.getElementById("validate-summary");
  const list = document.getElementById("rename-list");
  const btnCancel = document.getElementById("btn-validate-cancel");
  const btnConfirm = document.getElementById("btn-validate-confirm");

  // basename() strips directory, but we want the *relative* path under the
  // test scores dir so the user can distinguish same-named files in different
  // subdirs. Falls back to basename if root isn't a prefix (shouldn't happen).
  function relativeTo(root, full) {
    if (full.startsWith(root)) {
      let rest = full.slice(root.length);
      while (rest.startsWith(PATH_SEP)) rest = rest.slice(1);
      return rest || basename(full);
    }
    return basename(full);
  }

  let currentRenames = [];

  function renderList(root, renames) {
    list.innerHTML = "";
    for (const r of renames) {
      const row = document.createElement("div");
      row.className = "rename-row";

      const oldSpan = document.createElement("span");
      oldSpan.className = "old";
      oldSpan.textContent = relativeTo(root, r.from);

      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = "→";

      const newSpan = document.createElement("span");
      newSpan.className = "new";
      newSpan.textContent = relativeTo(root, r.to);

      row.append(oldSpan, arrow, newSpan);
      list.appendChild(row);
    }
  }

  function openModal(root, renames) {
    currentRenames = renames;
    const n = renames.length;
    summary.textContent =
      `${n} file${n === 1 ? "" : "s"} will be renamed. ` +
      `Collisions are resolved by appending _1, _2, … before the extension.`;
    renderList(root, renames);
    modal.hidden = false;
    btnCancel.focus();
  }

  function closeModal() {
    modal.hidden = true;
    currentRenames = [];
    list.innerHTML = "";
    btnOpen.focus();
  }

  btnOpen.addEventListener("click", async () => {
    logEvent("clicked: Validate filenames");
    const root = localStorage.getItem(STORE_KEY_TESTFILES);
    if (!root) return;
    btnOpen.disabled = true;
    try {
      const renames = await invoke("scan_testfile_names", { dir: root });
      if (renames.length === 0) {
        term.write(`\r\n\x1b[32mAll filenames in the test scores directory are valid.\x1b[0m\r\n`);
        logEvent("info: all filenames in the test scores directory are valid");
        return;
      }
      logEvent(`validate filenames: ${renames.length} invalid`);
      openModal(root, renames);
    } catch (e) {
      const msg = e?.message ?? e;
      term.write(`\r\n\x1b[31mError scanning test scores directory: ${msg}\x1b[0m\r\n`);
      logEvent(`error: scanning test scores directory: ${msg}`);
    } finally {
      updateActionButtons();
    }
  });

  btnCancel.addEventListener("click", () => {
    logEvent("clicked: Cancel (rename modal)");
    closeModal();
  });

  btnConfirm.addEventListener("click", async () => {
    logEvent(`clicked: Rename (${currentRenames.length} file${currentRenames.length === 1 ? "" : "s"})`);
    btnConfirm.disabled = true;
    btnCancel.disabled = true;
    try {
      const results = await invoke("rename_testfiles", { renames: currentRenames });
      const failed = results.filter((r) => r.error);
      const ok = results.length - failed.length;
      term.write(`\r\n\x1b[32mRenamed ${ok} file${ok === 1 ? "" : "s"}.\x1b[0m\r\n`);
      logEvent(`info: renamed ${ok} file${ok === 1 ? "" : "s"}`);
      for (const f of failed) {
        term.write(`\x1b[31m  failed: ${basename(f.from)} → ${basename(f.to)}: ${f.error}\x1b[0m\r\n`);
        logEvent(`error: rename failed: ${basename(f.from)} -> ${basename(f.to)}: ${f.error}`);
      }
    } catch (e) {
      const msg = e?.message ?? e;
      term.write(`\r\n\x1b[31mError renaming: ${msg}\x1b[0m\r\n`);
      logEvent(`error: renaming: ${msg}`);
    } finally {
      btnConfirm.disabled = false;
      btnCancel.disabled = false;
      closeModal();
      updateActionButtons();
    }
  });

  // Click outside the dialog to dismiss — matches common modal conventions
  // and gives a second way out besides Cancel/Escape.
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) {
      e.preventDefault();
      closeModal();
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  const term = initTerminal();

  const themeSelect = document.getElementById("theme-select");
  const initialThemeChoice = localStorage.getItem(STORE_KEY_THEME) || "system";
  themeSelect.value = initialThemeChoice;
  setTheme(initialThemeChoice, term);
  themeSelect.addEventListener("change", () => {
    setTheme(themeSelect.value, term);
    logEvent(`theme: ${themeSelect.value}`);
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themeSelect.value === "system") setTheme("system", term);
  });

  // Safety net: any invoke() or other async rejection that escapes a
  // handler-local try/catch surfaces in the terminal instead of disappearing
  // into the devtools console.
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const msg = reason?.message ?? reason;
    term.write(`\r\n\x1b[31mUnhandled error: ${msg}\x1b[0m\r\n`);
    logEvent(`error: unhandled: ${msg}`);
  });

  // Resolve platform before anything that calls joinPath / getPlatformFileFilter.
  try {
    platform = await invoke("platform");
  } catch (e) {
    const msg = e?.message ?? e;
    term.write(`\r\n\x1b[31mError detecting platform: ${msg}\x1b[0m\r\n`);
    logEvent(`error: detecting platform: ${msg}`);
  }
  PATH_SEP = platform === "windows" ? "\\" : "/";

  // Open the session log before anything else so subsequent events land in it.
  // Silent failure is acceptable — the app still functions without logging.
  try {
    sessionLogPath = await invoke("init_session_log", { keep: LOG_ROTATION_KEEP });
    logEvent(`session started (platform: ${platform})`);
  } catch (_) { sessionLogPath = null; }

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

  function setupDirPicker({ btn, pathEl, storeKey, initialValue, onSet }) {
    setPathEl(pathEl, initialValue);
    syncDirButton(btn, !!initialValue);
    if (initialValue) onSet?.(initialValue);
    btn.addEventListener("click", async () => {
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;
      setPathEl(pathEl, selected);
      syncDirButton(btn, true);
      onSet?.(selected);
      localStorage.setItem(storeKey, selected);
      logEvent(`${LABEL_BY_STORE_KEY[storeKey] ?? storeKey}: ${selected}`);
      updateResetButton(btnReset);
      updateActionButtons();
    });
    return {
      clear() {
        setPathEl(pathEl, null);
        syncDirButton(btn, false);
        logEvent(`${LABEL_BY_STORE_KEY[storeKey] ?? storeKey}: cleared`);
      },
    };
  }

  const vtestsPathEl = document.getElementById("vtests-path");

  const workdirPicker = setupDirPicker({
    btn: document.getElementById("btn-workdir"),
    pathEl: document.getElementById("workdir-path"),
    storeKey: STORE_KEY_WORKDIR,
    initialValue: workdir,
  });
  const vtestsPicker = setupDirPicker({
    btn: document.getElementById("btn-vtests"),
    pathEl: vtestsPathEl,
    storeKey: STORE_KEY_VTESTS,
    initialValue: vtests,
    onSet: (selected) => validateVtestsDir(selected, vtestsPathEl, term),
  });
  const testfilesPicker = setupDirPicker({
    btn: document.getElementById("btn-testfiles"),
    pathEl: document.getElementById("testfiles-path"),
    storeKey: STORE_KEY_TESTFILES,
    initialValue: testfiles,
    onSet: (selected) => checkTestfileNames(selected, term),
  });

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

  btnReset.addEventListener("click", () => {
    logEvent("clicked: Reset all fields");
    term.clear();
    const savedTheme = localStorage.getItem(STORE_KEY_THEME);
    localStorage.clear();
    if (savedTheme) localStorage.setItem(STORE_KEY_THEME, savedTheme);
    refZone.clear();
    curZone.clear();
    workdirPicker.clear();
    vtestsPicker.clear();
    testfilesPicker.clear();
    vtestsPathEl.classList.remove("path-invalid");
    delete vtestsPathEl.dataset.warning;
    document.getElementById("chk-compare-after").checked = true;
    document.getElementById("chk-open-browser").checked = true;
    const splitMain = document.getElementById("split-generate-main");
    splitMain.textContent = "Generate all";
    splitMain.dataset.action = "gen-all";
    updateResetButton(btnReset);
    updateActionButtons();
  });

  document.getElementById("btn-reset-window").addEventListener("click", async () => {
    logEvent("clicked: Reset window geometry");
    const win = getCurrentWindow();
    try {
      await win.setSize(new LogicalSize(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT));
      await win.center();
    } catch (e) {
      const msg = e?.message ?? e;
      term.write(`\r\n\x1b[31mError resetting window geometry: ${msg}\x1b[0m\r\n`);
      logEvent(`error: resetting window geometry: ${msg}`);
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
      const msg = e?.message ?? e;
      term.write(`\r\n\x1b[31mError: ${msg}\x1b[0m\r\n`);
      logEvent(`error: run aborted: ${msg}`);
      await reenableAllButtons();
    } finally {
      suppressTerminalDoneCount = 0;
    }
  }

  // Poll the output dir every 100ms for new score stems, printing each
  // newly-processed file once. Each tick is one read_dir + a HashSet over
  // the PNGs, which stays cheap relative to what mscore is doing.
  function startGenerateProgress(outputDir, total, term) {
    const seen = new Set();
    let stopped = false;
    // Serialize ticks so a slow read_dir can't let two invocations overlap.
    let inFlight = null;

    const tick = async () => {
      try {
        const stems = await invoke("list_processed_scores", { dir: outputDir });
        // Re-check cancelled *after* the await: a tick already in flight when
        // the user clicks Stop must not print processed lines below the
        // [cancelled] marker the terminal-done handler writes.
        if (cancelled) return;
        const fresh = [];
        for (const stem of stems) {
          if (!seen.has(stem)) {
            seen.add(stem);
            fresh.push(stem);
          }
        }
        if (fresh.length > 0) {
          for (const stem of fresh) {
            term.write(`\x1b[90mprocessed: ${stem}\x1b[0m\r\n`);
            logEvent(`processed: ${stem}`);
          }
          setProgress(seen.size, total);
        }
      } catch (_) { /* transient FS errors are fine — next tick will retry */ }
    };

    const scheduled = () => {
      if (stopped || inFlight) return;
      inFlight = tick().finally(() => { inFlight = null; });
    };

    const id = setInterval(scheduled, 100);
    return async () => {
      stopped = true;
      clearInterval(id);
      // Drain: catch files that landed between the last tick and stop so the
      // final few don't go unreported when the script finishes fast.
      if (inFlight) await inFlight;
      await tick();
    };
  }

  async function runGenerate(outputSubdir, mscoreKey, label) {
    const vtestsDir = localStorage.getItem(STORE_KEY_VTESTS);
    const workdir = localStorage.getItem(STORE_KEY_WORKDIR);
    const outputDir = joinPath(workdir, outputSubdir);
    const mscore = localStorage.getItem(mscoreKey);
    const scores = localStorage.getItem(STORE_KEY_TESTFILES);
    const script = joinPath(vtestsDir, SCRIPT_GENERATE);
    term.write(`${script} --output-dir ${outputDir} --mscore ${mscore} --scores ${scores}\r\n\n`);
    await invoke("prepare_output_dir", { workdir, subdir: outputSubdir });
    // Total may be 0 if the dir is empty or unreadable — skip the bar in
    // that case rather than show a meaningless "0 / 0".
    let total = 0;
    try { total = await invoke("count_scores", { dir: scores }); } catch (_) {}
    let stopProgress = null;
    if (total > 0) {
      showProgress(label, total);
      stopProgress = startGenerateProgress(outputDir, total, term);
    }
    try {
      return await invoke("run_command", {
        program: script,
        args: ["--output-dir", outputDir, "--mscore", mscore, "--scores", scores],
      });
    } finally {
      if (stopProgress) await stopProgress();
    }
  }

  const generateReference = () => runGenerate("ref", STORE_KEY_REFERENCE, "Generating reference PNGs");
  const generateCurrent   = () => runGenerate("current", STORE_KEY_CURRENT, "Generating current PNGs");

  // vtest-compare-pngs.sh prints one `Equal:` or `Different:` line per file
  // it compares, so we can count those off stdout without hitting the
  // filesystem. Line-buffer because a single `terminal-output` chunk may
  // carry a partial line at either edge. The match isn't anchored at ^ because
  // ImageMagick `compare -metric AE` writes the pixel-diff count with no
  // trailing newline, so each line we receive looks like `0Equal: ref: ...`.
  async function startCompareProgress(total) {
    let processed = 0;
    let buf = "";
    const unlisten = await listen("terminal-output", (event) => {
      buf += event.payload;
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (/(Equal|Different): ref:/.test(line)) {
          processed++;
          setProgress(processed, total);
        }
      }
    });
    return async () => { await unlisten(); };
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
    let total = 0;
    try { total = await invoke("count_pngs", { dir: refDir }); } catch (_) {}
    let stopProgress = null;
    if (total > 0) {
      showProgress("Comparing PNGs", total);
      stopProgress = await startCompareProgress(total);
    }
    let code;
    try {
      code = await invoke("run_command", {
        program: script,
        args: ["--reference-dir", refDir, "--current-dir", currentDir, "--output-dir", outputDir],
      });
    } finally {
      if (stopProgress) await stopProgress();
    }
    if (cancelled) return code;
    const reportPath = joinPath(outputDir, "vtest_compare.html");
    const reportExists = await invoke("path_exists", { path: reportPath });
    if (reportExists) {
      term.write(`\r\n\x1b[33mDiffs found.\x1b[0m\r\n`);
      logEvent("warning: diffs found");
      if (document.getElementById("chk-open-browser").checked)
        await invoke("open_path", { path: reportPath });
    } else if (code === 0) {
      term.write(`\r\n\x1b[32mNo diffs found.\x1b[0m\r\n`);
      logEvent("info: no diffs found");
    } else {
      term.write(`\r\n\x1b[31mCompare failed (exit code ${code}).\x1b[0m\r\n`);
      logEvent(`error: compare failed (exit code ${code})`);
    }
    return code;
  }

  document.getElementById("btn-compare").addEventListener("click", () => {
    logEvent("clicked: Compare");
    runWithUi(0, compare);
  });

  const chkCompareAfter = setupPersistedCheckbox("chk-compare-after", STORE_KEY_COMPARE_AFTER);
  chkCompareAfter.addEventListener("change", () => {
    logEvent(`'compare after generating': ${chkCompareAfter.checked ? "on" : "off"}`);
  });
  const chkOpenBrowser = setupPersistedCheckbox("chk-open-browser", STORE_KEY_OPEN_BROWSER);
  chkOpenBrowser.addEventListener("change", () => {
    logEvent(`'open diff in browser': ${chkOpenBrowser.checked ? "on" : "off"}`);
  });

  document.getElementById("btn-open-browser").addEventListener("click", async () => {
    logEvent("clicked: Open diff in browser");
    const workdir = localStorage.getItem(STORE_KEY_WORKDIR);
    await invoke("open_path", { path: joinPath(workdir, "diff", "vtest_compare.html") });
  });

  document.getElementById("btn-open-workdir").addEventListener("click", async () => {
    logEvent("clicked: Open working directory");
    const workdir = localStorage.getItem(STORE_KEY_WORKDIR);
    if (workdir) await invoke("open_path", { path: workdir });
  });

  document.getElementById("btn-open-logs").addEventListener("click", async () => {
    logEvent("clicked: Open log directory");
    const dir = await invoke("get_log_dir");
    if (dir) await invoke("open_path", { path: dir });
  });

  setupValidateTestfiles(term);

  // ---- Generate split-button ----
  const splitRoot = document.getElementById("split-button-generate");
  const splitMain = document.getElementById("split-generate-main");
  const splitToggle = document.getElementById("split-generate-toggle");
  const splitMenu = document.getElementById("split-generate-menu");

  function closeSplitMenu() {
    splitMenu.classList.remove("open");
    splitToggle.setAttribute("aria-expanded", "false");
  }

  function openSplitMenu() {
    splitMenu.classList.add("open");
    splitToggle.setAttribute("aria-expanded", "true");
    splitMenu.querySelector(".split-menu-item:not(:disabled)")?.focus();
  }

  // Restore previously-selected action so the button's text and data-action
  // match what the user last picked.
  const storedAction = localStorage.getItem(STORE_KEY_ACTION);
  if (storedAction) {
    const storedItem = splitMenu.querySelector(
      `.split-menu-item[data-action="${storedAction}"]`,
    );
    if (storedItem) {
      splitMain.textContent = storedItem.textContent.trim();
      splitMain.dataset.action = storedAction;
    }
  }

  splitMain.addEventListener("click", () => {
    const action = splitMain.dataset.action;
    const withCompare = chkCompareAfter.checked;
    logEvent(`clicked: ${splitMain.textContent.trim()}${withCompare ? " (compare after)" : ""}`);
    // Count the commands that will run so terminal-done suppression only hides
    // the intermediate [process exited] lines; the final step shows its status
    // (compare handles its own line via suppressNextExitLine).
    const genSteps = action === "gen-all" ? 2 : 1;
    const suppressCount = genSteps + (withCompare ? 1 : 0) - 1;
    runWithUi(suppressCount, async () => {
      // Non-zero exits don't halt the chain — partial output is common (e.g.
      // some scores are saved in a newer format than the mscore binary can
      // read) and the user typically still wants the rest of the sequence to
      // run. The failed step's red [process exited] stays visible so the
      // failure doesn't go unnoticed. Cancel still halts, though.
      if (action === "gen-reference") {
        await generateReference();
        if (cancelled) return;
      } else if (action === "gen-current") {
        await generateCurrent();
        if (cancelled) return;
      } else if (action === "gen-all") {
        await generateReference();
        if (cancelled) return;
        await generateCurrent();
        if (cancelled) return;
      } else {
        return;
      }
      if (withCompare) await compare();
    });
  });

  splitToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (splitMenu.classList.contains("open")) closeSplitMenu();
    else openSplitMenu();
  });

  splitMenu.addEventListener("click", (e) => {
    const item = e.target.closest(".split-menu-item");
    if (!item || item.disabled) return;
    splitMain.textContent = item.textContent.trim();
    splitMain.dataset.action = item.dataset.action;
    localStorage.setItem(STORE_KEY_ACTION, item.dataset.action);
    closeSplitMenu();
    splitMain.focus();
    updateActionButtons();
  });

  splitMenu.addEventListener("keydown", (e) => {
    const items = [...splitMenu.querySelectorAll(".split-menu-item")];
    const idx = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    }
  });

  document.addEventListener("click", (e) => {
    if (splitMenu.classList.contains("open") && !splitRoot.contains(e.target)) closeSplitMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && splitMenu.classList.contains("open")) {
      closeSplitMenu();
      splitToggle.focus();
    }
  });

  // The initial updateActionButtons() above ran before we restored the split
  // button's selected action, so the main button's disabled state was keyed to
  // the HTML default. Recompute now that the real action is in place.
  updateActionButtons();
});
