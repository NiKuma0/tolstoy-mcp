/**
 * Векторный поиск по int8-векторам bge-m3 из таблицы chunk_vectors: полный перебор в JS.
 *
 * sqlite-vec (и vec0, и vec_distance_cosine) на этих данных не быстрее: ~150 мс против ~125 мс здесь,
 * а ANN-индекса у него всё равно нет. Зато без него не нужна нативная сборка под каждую платформу
 * и загрузка расширений в SQLite, которой может не быть во встроенном Node Claude Desktop.
 *
 * Корпус хранится в int8 (113 МБ вместо 450), запрос остаётся float32: ранжирование почти не отличается
 * от точного (топ-10 совпадает на 9–10 из 10).
 */
import type { DatabaseSync } from "node:sqlite";

export function quantize(v: Float32Array, scale: number): Int8Array {
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i]! * scale)));
  return q;
}

export interface Neighbor {
  id: number;
  similarity: number; // косинус: 1 — совпадает
}

export class VectorIndex {
  private readonly ids: Int32Array;
  private readonly mine: Uint8Array;
  private readonly invNorms: Float32Array;
  private readonly data: Int8Array;

  constructor(
    db: DatabaseSync,
    private readonly dim: number,
  ) {
    const { n } = db.prepare("SELECT count(*) AS n FROM chunk_vectors").get() as { n: number };
    this.ids = new Int32Array(n);
    this.mine = new Uint8Array(n);
    this.invNorms = new Float32Array(n);
    this.data = new Int8Array(n * dim);
    let row = 0;
    for (const r of db.prepare("SELECT id, mine, embedding FROM chunk_vectors ORDER BY id").iterate()) {
      const { id, mine, embedding } = r as { id: number; mine: number; embedding: Uint8Array };
      if (embedding.byteLength !== dim)
        throw new Error(`chunk ${id}: vector of ${embedding.byteLength} bytes`);
      const v = new Int8Array(embedding.buffer, embedding.byteOffset, dim);
      this.data.set(v, row * dim);
      let s = 0;
      for (let i = 0; i < dim; i++) s += v[i]! * v[i]!;
      this.ids[row] = id;
      this.mine[row] = mine;
      this.invNorms[row] = s ? 1 / Math.sqrt(s) : 0;
      row++;
    }
  }

  get size(): number {
    return this.ids.length;
  }

  /** k ближайших по косинусу; query — нормированный float32-вектор. */
  nearest(query: Float32Array, k: number, onlyMine: boolean): Neighbor[] {
    const { dim, data } = this;
    if (query.length !== dim) throw new Error(`query has ${query.length} dims, index has ${dim}`);
    // top-k в отсортированном массиве: k мало (50), вставка дешевле кучи
    const top: Neighbor[] = [];
    let worst = -Infinity;
    for (let row = 0; row < this.ids.length; row++) {
      if (onlyMine && !this.mine[row]) continue;
      let dot = 0;
      const off = row * dim;
      for (let i = 0; i < dim; i++) dot += query[i]! * data[off + i]!;
      const similarity = dot * this.invNorms[row]!;
      if (top.length === k && similarity <= worst) continue;
      let pos = top.length;
      while (pos > 0 && top[pos - 1]!.similarity < similarity) pos--;
      top.splice(pos, 0, { id: this.ids[row]!, similarity });
      if (top.length > k) top.pop();
      worst = top[top.length - 1]!.similarity;
    }
    return top;
  }
}
