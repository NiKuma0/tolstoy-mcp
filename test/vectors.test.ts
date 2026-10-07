import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { quantize, VectorIndex } from "../src/vectors.js";

const DIM = 16;

function randomUnit(rand: () => number): Float32Array {
  const v = Float32Array.from({ length: DIM }, () => rand() - 0.5);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/** Детерминированный ГПСЧ (mulberry32), чтобы тест не мигал. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeIndex(vectors: Float32Array[]) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE chunk_vectors (id INTEGER PRIMARY KEY, mine INTEGER NOT NULL, embedding BLOB NOT NULL)",
  );
  const ins = db.prepare("INSERT INTO chunk_vectors VALUES (?, ?, ?)");
  vectors.forEach((v, i) => {
    ins.run(i + 1, i % 2, quantize(v, 127 / 0.6));
  });
  return new VectorIndex(db, DIM);
}

describe("quantize", () => {
  it("округляет и обрезает до ±127", () => {
    expect([...quantize(Float32Array.from([0.5, -0.5, 2, -2, 0.004]), 100)]).toEqual([50, -50, 127, -127, 0]);
  });
});

describe("VectorIndex", () => {
  const rand = rng(42);
  const vectors = Array.from({ length: 500 }, () => randomUnit(rand));
  const index = makeIndex(vectors);

  it("находит те же k ближайших, что и точный перебор по float32", () => {
    const q = randomUnit(rand);
    const exact = vectors
      .map((v, i) => ({ id: i + 1, s: v.reduce((acc, x, k) => acc + x * q[k]!, 0) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 10)
      .map((x) => x.id);
    const got = index.nearest(q, 10, false).map((n) => n.id);
    expect(got.filter((id) => exact.includes(id)).length).toBeGreaterThanOrEqual(9);
  });

  it("сам вектор — ближайший к себе, результаты по убыванию сходства", () => {
    const res = index.nearest(vectors[123]!, 5, false);
    expect(res[0]!.id).toBe(124);
    expect(res[0]!.similarity).toBeGreaterThan(0.99);
    for (let i = 1; i < res.length; i++)
      expect(res[i - 1]!.similarity).toBeGreaterThanOrEqual(res[i]!.similarity);
  });

  it("onlyMine оставляет только отмеченные векторы", () => {
    const res = index.nearest(randomUnit(rand), 20, true);
    expect(res).toHaveLength(20);
    // mine = i % 2 при id = i + 1, то есть отмечены чётные id
    for (const n of res) expect(n.id % 2).toBe(0);
  });

  it("отдаёт меньше k, если векторов меньше", () => {
    expect(makeIndex(vectors.slice(0, 3)).nearest(vectors[0]!, 10, false)).toHaveLength(3);
  });
});
