import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Memory, NotFoundError, openDatabase } from "../src/memory.js";
import { buildFixtureDb, fakeEmbedder } from "./fixture.js";

let memory: Memory;

beforeAll(async () => {
  const { db, vectors } = openDatabase(await buildFixtureDb());
  memory = new Memory(db, vectors, fakeEmbedder);
});
afterAll(() => memory.close());

describe("recall", () => {
  it("находит письмо и по смыслу, и по словам; текст в исходной орфографии без ударений", async () => {
    const [hit] = await memory.recall("что Толстой писал Фету о Шопенгауэре", 3);
    expect(hit).toMatchObject({
      doc_id: "v61_288_A_A_Fetu",
      segment_ids: ["s0", "s1", "s2"],
      header: "Толстой. Письмо А. А. Фету, 30 августа 1869",
      voice: "tolstoy",
      vec_rank: 1,
      lex_rank: 1,
    });
    expect(hit!.text).toContain("Шопенгауэромъ");
    expect(hit!.text).toContain("Шопенгауэръ — геніальнѣйшій");
    expect(hit!.text.split("\n")).toHaveLength(3);
  });

  it("сноска — отдельный чанк с голосом editor", async () => {
    const [hit] = await memory.recall("Ясная Поляна", 1);
    expect(hit).toMatchObject({ doc_id: "v61_288_A_A_Fetu", segment_ids: ["n0"], voice: "editor" });
  });

  it("only_mine убирает современников и редакторов", async () => {
    const all = await memory.recall("музыка", 3);
    expect(all.map((h) => h.voice)).toContain("contemporary");
    const mine = await memory.recall("музыка", 3, true);
    expect(mine.map((h) => h.voice)).toEqual(["tolstoy"]);
  });

  it("ограничивает выдачу top", async () => {
    expect(await memory.recall("Шопенгауэр", 1)).toHaveLength(1);
  });

  it("запрос из одних стоп-слов ищется только по вектору", async () => {
    const hits = await memory.recall("и что", 3);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.lex_rank).toBeNull();
  });
});

describe("readDocument", () => {
  it("шапка с адресатом и сегменты по порядку", () => {
    const doc = memory.readDocument("v61_288_A_A_Fetu");
    expect(doc).toMatchObject({
      title: "Письмо А. А. Фету",
      addressee: "Фет Афанасий Афанасьевич",
      volume: 61,
      total_segments: 4,
      next_start: null,
    });
    expect(doc.segments.map((s) => s.ord)).toEqual([0, 1, 2, 3]);
    expect(doc.segments[3]).toMatchObject({ kind: "footnote", voice: "editor" });
  });

  it("постранично через next_start", () => {
    const first = memory.readDocument("v61_288_A_A_Fetu", undefined, 0, 2);
    expect(first.segments.map((s) => s.id)).toEqual(["s0", "s1"]);
    expect(first.next_start).toBe(2);
    const second = memory.readDocument("v61_288_A_A_Fetu", undefined, first.next_start!, 2);
    expect(second.segments.map((s) => s.id)).toEqual(["s2", "n0"]);
    expect(second.next_start).toBeNull();
  });

  it("окно вокруг сегмента", () => {
    const doc = memory.readDocument("v61_288_A_A_Fetu", "s2", 0, 2);
    expect(doc.segments.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("NotFoundError для неизвестного документа или сегмента", () => {
    expect(() => memory.readDocument("nope")).toThrow(NotFoundError);
    expect(() => memory.readDocument("v61_288_A_A_Fetu", "nope")).toThrow(NotFoundError);
  });
});
