import { execSync } from "child_process";
import { readdirSync, renameSync, statSync, existsSync } from "fs";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function gitShortHash() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
  } catch {
    return "unknown";
  }
}

function gitIsDirty() {
  try {
    const out = execSync("git status --porcelain", { cwd: root }).toString();
    return out.split("\n").some((l) => l.length > 0 && !l.startsWith("??"));
  } catch {
    return false;
  }
}

const hash = gitShortHash();
const buildHash = gitIsDirty() ? `${hash}-dirty` : hash;

const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf-8"));
const { productName: name, version } = conf;
const prefix = `${name}_${version}_`;

const bundleDir = join(root, "src-tauri/target/release/bundle");
if (!existsSync(bundleDir)) {
  console.error(`Bundle directory not found: ${bundleDir}`);
  process.exit(1);
}

let renamed = 0;
for (const subdir of readdirSync(bundleDir)) {
  const subdirPath = join(bundleDir, subdir);
  if (!statSync(subdirPath).isDirectory()) continue;
  for (const file of readdirSync(subdirPath)) {
    if (!statSync(join(subdirPath, file)).isFile()) continue;
    if (!file.startsWith(prefix) || file.includes(buildHash)) continue;
    const suffix = file.slice(prefix.length);
    const newName = `${prefix}${buildHash}_${suffix}`;
    renameSync(join(subdirPath, file), join(subdirPath, newName));
    console.log(`  ${file}`);
    console.log(`→ ${newName}`);
    renamed++;
  }
}

if (renamed === 0) {
  console.log("No bundle files to rename.");
} else {
  console.log(`\nRenamed ${renamed} file(s) with build hash: ${buildHash}`);
}
