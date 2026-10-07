/**
 * Память «Толстого»: гибридный поиск по чанкам (вектор + FTS5, объединение через RRF) и чтение документа.
 * Перенос tei_server/memory.py и tei_importer/embed.py на SQLite. Ищем по тексту в современной
 * орфографии, отдаём text_orig.
 */
import { DatabaseSync } from "node:sqlite";
import type { Embedder } from "./embedder.js";
import { DB_FORMAT } from "./schema.js";
import { ftsQuery } from "./text.js";
import { VectorIndex } from "./vectors.js";

export const MAX_SEGMENTS = 60; // столько сегментов read_document отдаёт за раз, дальше — постранично
const POOL = 50; // кандидатов из каждого поиска
const RRF_K = 60;

export interface Hit {
  doc_id: string;
  segment_ids: string[];
  /** кто, что, когда: «Толстой. Письмо А. А. Фету, 30 августа 1869» */
  header: string;
  /** text_orig сегментов (дореформенная орфография, где она есть в источнике) */
  text: string;
  voice: string;
  score: number;
  vec_rank: number | null;
  lex_rank: number | null;
}

export interface Segment {
  id: string;
  ord: number;
  kind: string;
  voice: string;
  attribution: string | null;
  page_from: string | null;
  text: string;
}

export type Document = {
  id: string;
  corpus: string;
  voice: string;
  title: string;
  bibl: string | null;
  author: string | null;
  addressee: string | null;
  date_text: string | null;
  volume: number | null;
  pages: string | null;
  total_segments: number;
  segments: Segment[];
  next_start: number | null;
};

export class NotFoundError extends Error {}

/** Открывает базу и загружает векторы в память (~110 МБ, около полсекунды). */
export function openDatabase(path: string): { db: DatabaseSync; vectors: VectorIndex } {
  const db = new DatabaseSync(path, { readOnly: true });
  const meta = Object.fromEntries(
    (db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((r) => [
      r.key,
      r.value,
    ]),
  );
  if (Number(meta.format) !== DB_FORMAT)
    throw new Error(`${path}: format ${meta.format}, expected ${DB_FORMAT}`);
  return { db, vectors: new VectorIndex(db, Number(meta.dim)) };
}

export class Memory {
  private readonly stmts;

  constructor(
    private readonly db: DatabaseSync,
    private readonly vectors: VectorIndex,
    private readonly embedder: Pick<Embedder, "embed">,
  ) {
    this.stmts = {
      lex: db.prepare(`
        SELECT f.rowid AS id FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
        WHERE chunks_fts MATCH :q AND (:all OR c.voice IN ('tolstoy', 'quoted'))
        ORDER BY bm25(chunks_fts, 2.0, 1.0) LIMIT :k`),
      chunk: db.prepare("SELECT doc_id, segment_ids, header FROM chunks WHERE id = ?"),
      segment: db.prepare("SELECT text, voice FROM segments WHERE doc_id = ? AND id = ?"),
      doc: db.prepare(`
        SELECT d.id, d.corpus, d.voice, d.title, d.bibl, d.author, d.date_text, d.volume, d.pages,
               a.name AS addressee, d.segment_count AS total_segments
        FROM documents d LEFT JOIN persons a ON a.id = d.addressee_id WHERE d.id = ?`),
      segmentOrd: db.prepare("SELECT ord FROM segments WHERE doc_id = ? AND id = ?"),
      segments: db.prepare(`
        SELECT id, ord, kind, voice, attribution, page_from, text
        FROM segments WHERE doc_id = ? AND ord >= ? ORDER BY ord LIMIT ?`),
    };
  }

  async recall(query: string, top: number, onlyMine = false): Promise<Hit[]> {
    const vec = this.vectors.nearest(await this.embedder.embed(query), POOL, onlyMine).map((n) => n.id);
    const match = ftsQuery(query);
    const lex = match
      ? (this.stmts.lex.all({ q: match, k: POOL, all: onlyMine ? 0 : 1 }) as { id: number }[]).map(
          (r) => r.id,
        )
      : [];

    const fused = new Map<number, { score: number; vec: number | null; lex: number | null }>();
    const add = (ids: number[], key: "vec" | "lex") =>
      ids.forEach((id, i) => {
        const f = fused.get(id) ?? { score: 0, vec: null, lex: null };
        f.score += 1 / (RRF_K + i + 1);
        f[key] = i + 1;
        fused.set(id, f);
      });
    add(vec, "vec");
    add(lex, "lex");

    return [...fused.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, top)
      .map(([id, f]) => this.toHit(id, f.score, f.vec, f.lex));
  }

  private toHit(id: number, score: number, vecRank: number | null, lexRank: number | null): Hit {
    const c = this.stmts.chunk.get(id) as { doc_id: string; segment_ids: string; header: string };
    const segmentIds: string[] = JSON.parse(c.segment_ids);
    const segs = segmentIds
      .map((s) => this.stmts.segment.get(c.doc_id, s) as { text: string; voice: string } | undefined)
      .filter((s) => s !== undefined);
    return {
      doc_id: c.doc_id,
      segment_ids: segmentIds,
      header: c.header,
      text: segs
        .map((s) => s.text)
        .filter(Boolean)
        .join("\n"),
      voice: segs[0]?.voice ?? "tolstoy",
      score: Number(score.toFixed(5)),
      vec_rank: vecRank,
      lex_rank: lexRank,
    };
  }

  /** Шапка документа и до limit сегментов с позиции start (или окно вокруг segment_id). */
  readDocument(docId: string, segmentId?: string, start = 0, limit = MAX_SEGMENTS): Document {
    limit = Math.max(1, Math.min(limit, MAX_SEGMENTS));
    const doc = this.stmts.doc.get(docId) as Omit<Document, "segments" | "next_start"> | undefined;
    if (!doc) throw new NotFoundError(`нет документа ${JSON.stringify(docId)}`);
    if (segmentId) {
      const row = this.stmts.segmentOrd.get(docId, segmentId) as { ord: number } | undefined;
      if (!row)
        throw new NotFoundError(`нет сегмента ${JSON.stringify(segmentId)} в ${JSON.stringify(docId)}`);
      start = Math.max(0, row.ord - Math.floor(limit / 2));
    }
    // лишний сегмент: есть ли продолжение и с какого ord
    const segments = this.stmts.segments.all(docId, start, limit + 1) as unknown as Segment[];
    const more = segments[limit];
    return { ...doc, segments: segments.slice(0, limit), next_start: more ? more.ord : null };
  }

  close() {
    this.db.close();
  }
}
