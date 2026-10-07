import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Asset, ensureAsset } from "../src/assets.js";

const content = Buffer.from("SQLite format 3\0 тестовая база ".repeat(1000));
const gz = gzipSync(content);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let server: Server;
let base: string;
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    if (req.url === "/db.gz") res.end(gz);
    else if (req.url === "/plain") res.end(content);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const tmp = () => mkdtempSync(join(tmpdir(), "tolstoy-assets-"));

describe("ensureAsset", () => {
  it("скачивает, распаковывает gzip и проверяет sha256 сжатого файла", async () => {
    const dir = tmp();
    const asset: Asset = {
      url: `${base}/db.gz`,
      file: "sub/t.db",
      gzip: true,
      bytes: gz.length,
      sha256: sha(gz),
    };
    const path = await ensureAsset(asset, dir);
    expect(readFileSync(path)).toEqual(content);
    expect(readdirSync(join(dir, "sub"))).toEqual(["t.db"]); // .part не остался
  });

  it("не качает повторно, если файл уже есть", async () => {
    const dir = tmp();
    const asset: Asset = { url: `${base}/plain`, file: "p.bin", bytes: content.length, sha256: sha(content) };
    await ensureAsset(asset, dir);
    const before = hits;
    await ensureAsset(asset, dir);
    expect(hits).toBe(before);
  });

  it("одновременные загрузки одного файла (как у нескольких процессов Desktop) качают его один раз", async () => {
    const dir = tmp();
    const asset: Asset = {
      url: `${base}/plain`,
      file: "shared.bin",
      bytes: content.length,
      sha256: sha(content),
    };
    const before = hits;
    const [a, b] = await Promise.all([ensureAsset(asset, dir), ensureAsset(asset, dir)]);
    expect(a).toBe(b);
    expect(hits - before).toBe(1);
    expect(readdirSync(dir)).toEqual(["shared.bin"]); // ни .part, ни .lock
  });

  it("не оставляет файл при несовпадении sha256", async () => {
    const dir = tmp();
    const asset: Asset = {
      url: `${base}/plain`,
      file: "bad.bin",
      bytes: content.length,
      sha256: "0".repeat(64),
    };
    await expect(ensureAsset(asset, dir)).rejects.toThrow(/sha256/);
    expect(existsSync(join(dir, "bad.bin"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  }, 20_000);
});
