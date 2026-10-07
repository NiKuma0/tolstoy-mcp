import { describe, expect, it } from "vitest";
import { clean, ftsQuery, stems } from "../src/text.js";

describe("clean", () => {
  it("убирает ударения и схлопывает пробелы, как Python-импортёр", () => {
    expect(clean("  Си́ксне\n\tи  Шопенга́уэръ ")).toBe("Сиксне и Шопенгауэръ");
  });

  it("не трогает й и ё", () => {
    expect(clean("мой ёж")).toBe("мой ёж");
  });
});

describe("stems", () => {
  it("стеммит русские слова и убирает стоп-слова", () => {
    expect(stems("что Толстой писал Фету о Шопенгауэре")).toEqual(["толст", "писа", "фет", "шопенгауэр"]);
  });

  it("одинаково для разных форм и ё/е", () => {
    expect(stems("Толстого Толстому")).toEqual(["толст", "толст"]);
    expect(stems("ёлка")).toEqual(stems("елка"));
  });

  it("стеммит английские слова английским стеммером", () => {
    expect(stems("the reading")).toEqual(["read"]);
  });
});

describe("ftsQuery", () => {
  it("уникальные основы через OR в кавычках", () => {
    expect(ftsQuery("Фет и Фету о Шопенгауэре")).toBe('"фет" OR "шопенгауэр"');
  });

  it("null, если остались одни стоп-слова или знаки", () => {
    expect(ftsQuery("и что? — то")).toBeNull();
  });
});
