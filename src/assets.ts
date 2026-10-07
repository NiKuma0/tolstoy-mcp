/**
 * Данные ищутся сначала рядом с кодом (data/ в .mcpb: туда pack-mcpb кладёт базу), потом в каталоге
 * данных (TOLSTOY_DATA_DIR или системный каталог данных приложения). Чего нет, то скачивается туда
 * и проверяется по sha256. Файл появляется под своим именем только после проверки, поэтому
 * наличие файла = он целый.
 *
 * Claude Desktop запускает сервер в нескольких процессах сразу, поэтому загрузка одного файла
 * защищена межпроцессной блокировкой: второй процесс ждёт и берёт готовый файл.
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import envPaths from "env-paths";
import lockfile from "proper-lockfile";
import manifest from "../data/assets.json" with { type: "json" };
import { log } from "./log.js";

export interface Asset {
  url: string;
  file: string;
  bytes: number;
  sha256: string;
  gzip?: boolean;
}

export type AssetName = keyof typeof manifest.files;
export const ASSETS: Record<AssetName, Asset> = manifest.files;

export function dataDir(): string {
  return process.env.TOLSTOY_DATA_DIR || envPaths("tolstoy-mcp", { suffix: "" }).data;
}

/** data/ рядом с dist/: в .mcpb там лежит база. */
export const BUNDLED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

/** Путь к уже имеющемуся файлу: из пакета или из каталога данных. */
export function locateAsset(asset: Asset, dir = dataDir()): string | null {
  for (const base of [BUNDLED_DIR, dir]) {
    const path = join(base, asset.file);
    if (existsSync(path)) return path;
  }
  return null;
}

export interface Progress {
  done: number;
  total: number;
}

/** Скачивает файл, если его ещё нет. onProgress получает скачанные байты (сжатые, если gzip). */
export async function ensureAsset(
  asset: Asset,
  dir: string,
  onProgress: (p: Progress) => void = () => {},
): Promise<string> {
  const found = locateAsset(asset, dir);
  if (found) {
    onProgress({ done: asset.bytes, total: asset.bytes });
    return found;
  }
  const target = join(dir, asset.file);
  await mkdir(dirname(target), { recursive: true });
  const release = await lockfile.lock(target, {
    realpath: false, // файла ещё нет
    lockfilePath: `${target}.lock`,
    stale: 30_000, // владелец обновляет блокировку каждые 15 с; если умер, через 30 с её можно забрать
    retries: { retries: 3600, factor: 1, minTimeout: 1000, maxTimeout: 1000 }, // ждать чужую загрузку до часа
    onCompromised: (e) => log.warn(`download lock for ${target} compromised: ${e.message}`),
  });
  try {
    if (existsSync(target)) {
      onProgress({ done: asset.bytes, total: asset.bytes });
      return target; // скачал другой процесс, пока мы ждали
    }
    return await download(asset, target, onProgress);
  } finally {
    await release().catch(() => {});
  }
}

async function download(asset: Asset, target: string, onProgress: (p: Progress) => void): Promise<string> {
  const url = process.env.TOLSTOY_DATA_URL
    ? asset.url.replace(manifest.dataBaseUrl, process.env.TOLSTOY_DATA_URL)
    : asset.url;
  if (!asset.sha256) throw new Error(`${asset.file}: sha256 is not set in data/assets.json`);
  const part = `${target}.${process.pid}.part`;

  for (let attempt = 1; ; attempt++) {
    try {
      log.info(`downloading ${url} → ${target}`);
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
      const hash = createHash("sha256");
      let done = 0;
      let lastReport = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          done += chunk.length;
          if (done - lastReport > 1 << 20) {
            lastReport = done;
            onProgress({ done, total: asset.bytes });
          }
          cb(null, chunk);
        },
      });
      const body = Readable.fromWeb(res.body);
      if (asset.gzip) await pipeline(body, meter, createGunzip(), createWriteStream(part));
      else await pipeline(body, meter, createWriteStream(part));
      const sha256 = hash.digest("hex");
      if (sha256 !== asset.sha256)
        throw new Error(`${asset.file}: sha256 ${sha256}, expected ${asset.sha256}`);
      await rename(part, target);
      onProgress({ done, total: done });
      log.info(`downloaded ${target}`);
      return target;
    } catch (e) {
      await rm(part, { force: true });
      if (attempt >= 3) throw e;
      log.warn(`download failed (attempt ${attempt}): ${e}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/** Загрузка всех файлов и её прогресс: что показать пользователю, пока память не готова. */
export class Downloads {
  private readonly progress = new Map<AssetName, Progress>();
  // одна загрузка на файл: повторный вызов после ошибки другого файла не должен качать его второй раз
  private readonly inflight = new Map<AssetName, Promise<string>>();

  constructor(private readonly dir = dataDir()) {}

  private ensure(name: AssetName): Promise<string> {
    let p = this.inflight.get(name);
    if (!p) {
      p = ensureAsset(ASSETS[name], this.dir, (pr) => this.progress.set(name, pr));
      p.catch(() => this.inflight.delete(name));
      this.inflight.set(name, p);
    }
    return p;
  }

  async ensureAll(): Promise<Record<AssetName, string>> {
    const names = Object.keys(ASSETS) as AssetName[];
    const paths = await Promise.all(names.map((name) => this.ensure(name)));
    return Object.fromEntries(names.map((n, i) => [n, paths[i]])) as Record<AssetName, string>;
  }

  /** «412 из 787 МБ (52%)» */
  describe(): string {
    let done = 0;
    let total = 0;
    for (const name of Object.keys(ASSETS) as AssetName[]) {
      total += ASSETS[name].bytes;
      done += Math.min(this.progress.get(name)?.done ?? 0, ASSETS[name].bytes);
    }
    const mb = (n: number) => Math.round(n / 1e6);
    return `${mb(done)} из ${mb(total)} МБ (${total ? Math.floor((100 * done) / total) : 0}%)`;
  }
}
