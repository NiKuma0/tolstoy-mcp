/**
 * Собирает SQLite-базу из дампа `tei-importer export` (репозиторий TEI, importer/).
 *
 *   npm run build:db -- ../../clones/TEI/importer/export            # → build/tolstoy-v1.db
 *   npm run build:db -- ../../clones/TEI/importer/export --gzip     # + .db.gz и запись в data/assets.json
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createGunzip, createGzip } from "node:zlib";
import { DB_FORMAT, MINE_VOICES, SCHEMA, type Voice } from "../src/schema.js";
import { clean, ftsText } from "../src/text.js";
import { quantize } from "../src/vectors.js";

/** Значения bge-m3 по модулю не больше 0,31 (p99,999 = 0,27): всё, что выше 0,3, обрезается. */
const CLIP = 0.3;

interface Manifest {
  format: number;
  created_at: string;
  embedding: { model: string; dim: number; dtype: string; normalized: boolean; file: string; rows: number };
  counts: Record<string, number>;
}

async function* jsonl<T>(path: string): AsyncGenerator<T> {
  const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line) as T;
}

let say = (msg: string) => console.error(msg);

function progress(name: string, n: number, total: number | undefined) {
  if (n % 50_000 === 0 || n === total) say(`  ${name}: ${n}${total ? ` / ${total}` : ""}`);
}

async function sha256(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const block of createReadStream(path)) h.update(block);
  return h.digest("hex");
}

export async function buildDatabase(exportDir: string, out: string, quiet = false) {
  const manifest: Manifest = JSON.parse(await readFile(join(exportDir, "manifest.json"), "utf8"));
  const { dim, rows, dtype, model } = manifest.embedding;
  if (dtype !== "float32-le") throw new Error(`unsupported vectors dtype ${dtype}`);
  const scale = 127 / CLIP;
  if (quiet) say = () => {};

  rmSync(out, { force: true });
  const db = new DatabaseSync(out);
  db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA page_size = 8192;");
  db.exec(SCHEMA);
  db.exec("BEGIN");

  const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries({
    format: DB_FORMAT,
    model,
    dim,
    scale,
    export_created_at: manifest.created_at,
    built_at: new Date().toISOString(),
  }))
    setMeta.run(k, String(v));

  say("persons");
  const insPerson = db.prepare(
    "INSERT INTO persons (id, name, life_period, wikidata, description) VALUES (?, ?, ?, ?, ?)",
  );
  for await (const p of jsonl<Record<string, string | number | null>>(join(exportDir, "persons.jsonl.gz")))
    insPerson.run(
      p.id ?? null,
      p.name ?? null,
      p.life_period ?? null,
      p.wikidata ?? null,
      p.description ?? null,
    );

  say("segments");
  const segCount = new Map<string, number>();
  const insSeg = db.prepare(
    "INSERT INTO segments (doc_id, ord, id, kind, voice, attribution, page_from, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  let n = 0;
  type Seg = Record<"doc_id" | "id" | "kind" | "voice" | "text_orig", string> & {
    ord: number;
    attribution: string | null;
    page_from: string | null;
  };
  for await (const s of jsonl<Seg>(join(exportDir, "segments.jsonl.gz"))) {
    insSeg.run(s.doc_id, s.ord, s.id, s.kind, s.voice, s.attribution, s.page_from, clean(s.text_orig));
    segCount.set(s.doc_id, (segCount.get(s.doc_id) ?? 0) + 1);
    progress("segments", ++n, manifest.counts.segments);
  }

  say("documents");
  const insDoc = db.prepare(`
    INSERT INTO documents (id, corpus, voice, title, bibl, author, volume, pages, date_from, date_to, date_text,
                           addressee_id, source_path, segment_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  type Doc = Record<"id" | "corpus" | "voice" | "title" | "source_path", string> &
    Record<"bibl" | "author" | "pages" | "date_from" | "date_to" | "date_text", string | null> & {
      volume: number | null;
      addressee_id: number | null;
    };
  for await (const d of jsonl<Doc>(join(exportDir, "documents.jsonl.gz")))
    insDoc.run(
      d.id,
      d.corpus,
      d.voice,
      d.title,
      d.bibl,
      d.author,
      d.volume,
      d.pages,
      d.date_from,
      d.date_to,
      d.date_text,
      d.addressee_id,
      d.source_path,
      segCount.get(d.id) ?? 0,
    );

  say("chunks + vectors");
  const insChunk = db.prepare(
    "INSERT INTO chunks (id, doc_id, voice, is_note, segment_ids, header) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insVec = db.prepare("INSERT INTO chunk_vectors (id, mine, embedding) VALUES (?, ?, ?)");
  const insFts = db.prepare("INSERT INTO chunks_fts (rowid, head, body) VALUES (?, ?, ?)");
  const fd = openSync(join(exportDir, manifest.embedding.file), "r");
  const raw = Buffer.alloc(dim * 4);
  const vec = new Float32Array(dim);
  n = 0;
  type Chunk = { doc_id: string; voice: Voice; is_note: boolean; segment_ids: string[]; embed_text: string };
  for await (const c of jsonl<Chunk>(join(exportDir, "chunks.jsonl.gz"))) {
    const id = ++n;
    if (readSync(fd, raw, 0, raw.length, (id - 1) * raw.length) !== raw.length)
      throw new Error(`vectors file is shorter than chunks.jsonl.gz (row ${id})`);
    for (let i = 0; i < dim; i++) vec[i] = raw.readFloatLE(i * 4);
    const cut = c.embed_text.indexOf("\n\n");
    const header = cut < 0 ? "" : c.embed_text.slice(0, cut);
    const body = cut < 0 ? c.embed_text : c.embed_text.slice(cut + 2);
    insChunk.run(id, c.doc_id, c.voice, c.is_note ? 1 : 0, JSON.stringify(c.segment_ids), header);
    insVec.run(id, MINE_VOICES.includes(c.voice) ? 1 : 0, quantize(vec, scale));
    insFts.run(id, ftsText(header), ftsText(body));
    progress("chunks", n, rows);
  }
  if (n !== rows) throw new Error(`chunks: ${n} rows, manifest says ${rows}`);

  db.exec("COMMIT");
  say("optimize");
  db.exec("INSERT INTO chunks_fts (chunks_fts) VALUES ('optimize'); ANALYZE; VACUUM;");
  db.close();
  say(`done: ${out}, ${((await stat(out)).size / 1e6).toFixed(0)} MB`);
}

/** Сжимает базу и записывает её в data/assets.json: оттуда сервер знает, что скачивать. */
async function gzipAndRegister(dbPath: string) {
  const gz = `${dbPath}.gz`;
  await pipeline(createReadStream(dbPath), createGzip({ level: 9 }), createWriteStream(gz));
  const assetsPath = resolve(import.meta.dirname, "../data/assets.json");
  const assets = JSON.parse(readFileSync(assetsPath, "utf8"));
  const file = gz.split(/[\\/]/).pop();
  assets.files.db = {
    url: `${assets.dataBaseUrl}/${file}`,
    file: file?.replace(/\.gz$/, ""),
    gzip: true,
    bytes: (await stat(gz)).size,
    sha256: await sha256(gz),
  };
  await writeFile(assetsPath, `${JSON.stringify(assets, null, 2)}\n`);
  console.error(`${gz}: ${(assets.files.db.bytes / 1e6).toFixed(0)} MB, sha256 ${assets.files.db.sha256}`);
  console.error(`upload it to ${assets.files.db.url}`);
}

// CLI; при импорте из тестов не запускается
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: "string", default: "build" }, gzip: { type: "boolean", default: false } },
  });
  const exportDir = positionals[0];
  if (!exportDir || !existsSync(join(exportDir, "manifest.json"))) {
    console.error(
      "usage: npm run build:db -- <export dir from `tei-importer export`> [--out build] [--gzip]",
    );
    process.exit(2);
  }
  await mkdir(values.out, { recursive: true });
  const dbPath = resolve(values.out, `tolstoy-v${DB_FORMAT}.db`);
  await buildDatabase(exportDir, dbPath);
  if (values.gzip) await gzipAndRegister(dbPath);
}
