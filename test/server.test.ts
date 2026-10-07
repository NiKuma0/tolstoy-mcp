import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Memory, openDatabase } from "../src/memory.js";
import { createServer } from "../src/server.js";
import { buildFixtureDb, fakeEmbedder } from "./fixture.js";

async function connect(get: () => Promise<Memory | string>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ get }).connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

const text = (r: { content?: unknown }) => (r.content as { text: string }[])[0]!.text;

describe("MCP server", () => {
  let memory: Memory;
  let client: Client;

  beforeAll(async () => {
    const { db, vectors } = openDatabase(await buildFixtureDb());
    memory = new Memory(db, vectors, fakeEmbedder);
    client = await connect(async () => memory);
  });
  afterAll(async () => {
    await client.close();
    memory.close();
  });

  it("отдаёт инструкции, инструменты и промпт", async () => {
    expect(client.getInstructions()).toContain("voice");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["read_document", "recall"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    const prompt = await client.getPrompt({ name: "tolstoy" });
    expect((prompt.messages[0]!.content as { text: string }).text).toContain("Ты — Лев Николаевич Толстой");
  });

  it("recall возвращает структурированный результат", async () => {
    const res = await client.callTool({ name: "recall", arguments: { query: "Шопенгауэр", top: 2 } });
    expect(res.isError).toBeFalsy();
    const { hits } = res.structuredContent as { hits: { doc_id: string }[] };
    expect(hits[0]!.doc_id).toBe("v61_288_A_A_Fetu");
    expect(JSON.parse(text(res))).toEqual(res.structuredContent);
  });

  it("read_document и ошибка для неизвестного документа", async () => {
    const ok = await client.callTool({ name: "read_document", arguments: { doc_id: "goldenveizer_1" } });
    expect(ok.structuredContent).toMatchObject({ id: "goldenveizer_1", next_start: null });
    const bad = await client.callTool({ name: "read_document", arguments: { doc_id: "nope" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("нет документа");
  });

  it("неверные аргументы отклоняются схемой", async () => {
    const res = await client
      .callTool({ name: "recall", arguments: { query: "x", top: 100 } })
      .catch((e) => e);
    expect(res instanceof Error || res.isError).toBe(true);
  });
});

describe("MCP server while memory is loading", () => {
  it("инструмент отвечает, что память ещё грузится", async () => {
    const client = await connect(async () => "Память ещё загружается: 10 из 750 МБ (1%).");
    const res = await client.callTool({ name: "recall", arguments: { query: "Шопенгауэр" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("загружается");
    await client.close();
  });
});
