/**
 * Собирает .mcpb под одну ОС (или под все): база (build/tolstoy-v*.db из `npm run build:db`) в data/,
 * production node_modules без бинарников onnxruntime для чужих платформ и без CUDA/TensorRT.
 * Модель (590 МБ) в пакет не кладём: она скачивается с Hugging Face при первом запуске. Сам код и данные от платформы не зависят, поэтому
 * все пакеты можно собрать на одной машине; в CI каждый потом проверяется на своей ОС.
 *
 *   npm run build && npm run pack:mcpb                 # все ОС → build/tolstoy-<version>-<os>.mcpb
 *   npm run pack:mcpb -- --os win32
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ASSETS, ensureAsset } from "../src/assets.js";
import { DB_FORMAT } from "../src/schema.js";

/** Платформы, под которые onnxruntime-node публикует бинарники (darwin/x64 он больше не собирает). */
const TARGETS = { darwin: ["arm64"], win32: ["x64", "arm64"], linux: ["x64", "arm64"] } as const;
type Os = keyof typeof TARGETS;

const root = resolve(import.meta.dirname, "..");
const DB_FILE = `tolstoy-v${DB_FORMAT}.db`;
const dbPath = join(root, "build", DB_FILE);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed with ${r.status}`);
}

function dirSize(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

function pruneOnnxruntime(stage: string, os: Os) {
  const bin = join(stage, "node_modules/onnxruntime-node/bin");
  for (const napi of readdirSync(bin)) {
    for (const platform of readdirSync(join(bin, napi))) {
      const platformDir = join(bin, napi, platform);
      if (platform !== os) {
        rmSync(platformDir, { recursive: true });
        continue;
      }
      for (const arch of readdirSync(platformDir)) {
        const archDir = join(platformDir, arch);
        if (!(TARGETS[os] as readonly string[]).includes(arch)) {
          rmSync(archDir, { recursive: true });
          continue;
        }
        // нам нужен только CPU: CUDA и TensorRT занимают ~280 МБ в linux/x64
        for (const f of readdirSync(archDir))
          if (/providers_(cuda|tensorrt)/.test(f)) rmSync(join(archDir, f));
      }
    }
  }
}

function pack(os: Os): string {
  const stage = join(root, "build/mcpb", os);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
  for (const f of ["package.json", "package-lock.json", "README.md", "LICENSE"])
    if (existsSync(join(root, f))) cpSync(join(root, f), join(stage, f));
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  delete manifest.$schema;
  manifest.version = pkg.version;
  manifest.compatibility.platforms = [os];
  writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(join(stage, "data"));
  cpSync(dbPath, join(stage, "data", DB_FILE));

  // --ignore-scripts: postinstall onnxruntime-node докачивает CUDA, а бинарники CPU уже в пакете
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
  pruneOnnxruntime(stage, os);
  console.error(`${os}: ${(dirSize(stage) / 1e6).toFixed(0)} MB unpacked`);

  const out = join(root, "build", `tolstoy-${pkg.version}-${os}.mcpb`);
  run("npx", ["mcpb", "pack", stage, out], root);
  return out;
}

const { values } = parseArgs({ options: { os: { type: "string", multiple: true } } });
if (!existsSync(join(root, "dist/index.js"))) throw new Error("run `npm run build` first");
// локально база обычно уже собрана build:db; в CI её берём из релиза данных (с проверкой sha256)
if (!existsSync(dbPath)) await ensureAsset(ASSETS.db, join(root, "build"));
const targets = (values.os ?? Object.keys(TARGETS)) as Os[];
for (const os of targets) {
  if (!(os in TARGETS))
    throw new Error(`unknown os ${os}, expected one of ${Object.keys(TARGETS).join(", ")}`);
  console.error(`→ ${pack(os)}`);
}
