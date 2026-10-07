/**
 * Векторизация запроса той же моделью, что и корпус: BAAI/bge-m3 (ONNX int8 из Xenova/bge-m3).
 * Плотный вектор bge-m3 — это скрытое состояние токена [CLS], нормированное по L2,
 * как у sentence-transformers при normalize_embeddings=True.
 */
import { readFile } from "node:fs/promises";
import { Tokenizer } from "@huggingface/tokenizers";
import ort from "onnxruntime-node";

/** Запросы короткие; ограничение как у импортёра (max_seq_length) — на случай вставки длинного текста. */
const MAX_TOKENS = 1024;

export class Embedder {
  private constructor(
    private readonly session: ort.InferenceSession,
    private readonly tokenizer: Tokenizer,
  ) {}

  static async load(paths: { model: string; tokenizer: string; tokenizerConfig: string }): Promise<Embedder> {
    const [session, tokenizerJson, tokenizerConfig] = await Promise.all([
      ort.InferenceSession.create(paths.model, { graphOptimizationLevel: "all" }),
      readFile(paths.tokenizer, "utf8").then(JSON.parse),
      readFile(paths.tokenizerConfig, "utf8").then(JSON.parse),
    ]);
    return new Embedder(session, new Tokenizer(tokenizerJson, tokenizerConfig));
  }

  async embed(text: string): Promise<Float32Array> {
    let ids = this.tokenizer.encode(text).ids;
    if (ids.length > MAX_TOKENS) ids = [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]!]; // </s> в конце
    const shape = [1, ids.length];
    const out = await this.session.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), shape),
      attention_mask: new ort.Tensor("int64", new BigInt64Array(ids.length).fill(1n), shape),
    });
    const hidden = out.last_hidden_state;
    if (!hidden) throw new Error("model has no last_hidden_state output");
    const dim = hidden.dims[2]!;
    const cls = (hidden.data as Float32Array).slice(0, dim);
    let norm = 0;
    for (const x of cls) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) cls[i]! /= norm;
    return cls;
  }

  async close(): Promise<void> {
    await this.session.release();
  }
}
