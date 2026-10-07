/**
 * Мини-дамп в формате `tei-importer export` и база из него. Векторы 8-мерные, «эмбеддер» выдаёт
 * заранее известные векторы по ключевым словам запроса — так поиск проверяется без модели.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { buildDatabase } from "../scripts/build-db.js";

export const DIM = 8;

const unit = (i: number) => Float32Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));

const documents = [
  {
    id: "v61_288_A_A_Fetu",
    corpus: "letters",
    voice: "tolstoy",
    title: "Письмо А. А. Фету",
    bibl: "ПСС, т. 61, с. 219",
    author: "Толстой Л. Н.",
    author_id: 1,
    volume: 61,
    pages: "219–220",
    date_from: "1869-08-30",
    date_to: null,
    date_text: "30 августа 1869 г.",
    addressee_id: 2,
    source_path: "letters/v61_288.xml",
    meta: {},
  },
  {
    id: "goldenveizer_1",
    corpus: "contemporaries",
    voice: "contemporary",
    title: "Гольденвейзер. Вблизи Толстого",
    bibl: null,
    author: "Гольденвейзер А. Б.",
    author_id: 3,
    volume: null,
    pages: null,
    date_from: null,
    date_to: null,
    date_text: null,
    addressee_id: null,
    source_path: "contemporaries/g1.xml",
    meta: {},
  },
];

const seg = (doc_id: string, ord: number, id: string, text: string, extra: Record<string, unknown> = {}) => ({
  doc_id,
  id,
  ord,
  kind: "p",
  voice: "tolstoy",
  parent_id: null,
  attribution: null,
  page_from: "219",
  page_to: null,
  text_orig: text,
  text_reg: text,
  ...extra,
});

const segments = [
  seg("v61_288_A_A_Fetu", 0, "s0", "Знаете ли, что было для меня нынешнее лѣто?"),
  seg(
    "v61_288_A_A_Fetu",
    1,
    "s1",
    "Неперестающій восторгъ передъ Шопенгауэромъ и рядъ духовныхъ наслажденій.",
  ),
  seg(
    "v61_288_A_A_Fetu",
    2,
    "s2",
    "Не знаю, перемѣню ли я когда мнѣніе, но теперь я увѣренъ, что Шопенга́уэръ — геніальнѣйшій изъ людей.",
  ),
  seg("v61_288_A_A_Fetu", 3, "n0", "Письмо написано в Ясной Поляне.", { kind: "footnote", voice: "editor" }),
  seg("goldenveizer_1", 0, "g0", "Лев Николаевич говорил о музыке и о Шопене.", { voice: "contemporary" }),
];

const chunks = [
  {
    id: 1,
    doc_id: "v61_288_A_A_Fetu",
    n: 0,
    voice: "tolstoy",
    is_note: false,
    segment_ids: ["s0", "s1", "s2"],
    ord_from: 0,
    ord_to: 2,
    embed_text:
      "Толстой. Письмо А. А. Фету, 30 августа 1869\n\nЗнаете ли, что было для меня нынешнее лето? Неперестающий восторг перед Шопенгауэром",
  },
  {
    id: 2,
    doc_id: "v61_288_A_A_Fetu",
    n: 1,
    voice: "editor",
    is_note: true,
    segment_ids: ["n0"],
    ord_from: 3,
    ord_to: 3,
    embed_text:
      "Примечание редактора. Толстой. Письмо А. А. Фету, 30 августа 1869\n\nПисьмо написано в Ясной Поляне.",
  },
  {
    id: 3,
    doc_id: "goldenveizer_1",
    n: 0,
    voice: "contemporary",
    is_note: false,
    segment_ids: ["g0"],
    ord_from: 0,
    ord_to: 0,
    embed_text:
      "Толстой и его современники. Гольденвейзер. Вблизи Толстого\n\nЛев Николаевич говорил о музыке и о Шопене.",
  },
];
/** Вектор чанка i — единичный по оси i. */
const vectors = chunks.map((_, i) => unit(i));

/** Эмбеддер для тестов: «шопенгауэр» → чанк 1, «поляна» → чанк 2, «музыка» → чанк 3. */
export const fakeEmbedder = {
  async embed(text: string): Promise<Float32Array> {
    const t = text.toLowerCase();
    if (t.includes("поляна")) return unit(1);
    if (t.includes("музык")) return unit(2);
    if (t.includes("шопенгауэр")) return unit(0);
    return unit(7);
  },
};

const persons = [
  {
    id: 1,
    name: "Толстой Лев Николаевич",
    wikidata: "Q7243",
    life_period: "1828–1910",
    description: null,
    meta: {},
  },
  {
    id: 2,
    name: "Фет Афанасий Афанасьевич",
    wikidata: null,
    life_period: "1820–1892",
    description: null,
    meta: {},
  },
];

const jsonl = (rows: object[]) => gzipSync(rows.map((r) => `${JSON.stringify(r)}\n`).join(""));

export function writeExport(): string {
  const dir = mkdtempSync(join(tmpdir(), "tolstoy-export-"));
  const tables: Record<string, object[]> = {
    persons,
    categories: [],
    documents,
    document_categories: [],
    segments,
    segment_persons: [],
    chunks,
  };
  for (const [name, rows] of Object.entries(tables))
    writeFileSync(join(dir, `${name}.jsonl.gz`), jsonl(rows));
  const raw = Buffer.alloc(vectors.length * DIM * 4);
  for (const [i, v] of vectors.entries())
    for (const [k, x] of v.entries()) raw.writeFloatLE(x, (i * DIM + k) * 4);
  writeFileSync(join(dir, "chunks.f32"), raw);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      format: 1,
      created_at: "2026-10-07T00:00:00+00:00",
      embedding: {
        model: "test",
        dim: DIM,
        dtype: "float32-le",
        normalized: true,
        file: "chunks.f32",
        rows: chunks.length,
      },
      counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
    }),
  );
  return dir;
}

export async function buildFixtureDb(): Promise<string> {
  const out = join(mkdtempSync(join(tmpdir(), "tolstoy-db-")), "tolstoy.db");
  await buildDatabase(writeExport(), out, true);
  return out;
}
