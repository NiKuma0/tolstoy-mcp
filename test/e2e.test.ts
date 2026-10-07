/**
 * Сквозной тест на настоящих данных: собранный dist/index.js по stdio, как его запускает Claude.
 * Нужны `npm run build` и скачанные база и модель:
 *
 *   TOLSTOY_E2E_DATA_DIR=.data npm test
 */
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = process.env.TOLSTOY_E2E_DATA_DIR;

describe.skipIf(!dataDir)("e2e: stdio server on real data", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: "e2e", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("dist/index.js")],
        env: { ...(process.env as Record<string, string>), TOLSTOY_DATA_DIR: resolve(dataDir!) },
        stderr: "ignore",
      }),
    );
  });
  afterAll(() => client?.close());

  it("находит письмо Фету о Шопенгауэре", async () => {
    const res = await client.callTool({
      name: "recall",
      arguments: { query: "что Толстой писал Фету о Шопенгауэре", top: 5 },
    });
    expect(res.isError).toBeFalsy();
    const { hits } = res.structuredContent as { hits: { doc_id: string }[] };
    expect(hits.map((h) => h.doc_id)).toContain("v61_288_A_A_Fetu");
  });

  it("only_mine оставляет только голос Толстого", async () => {
    const res = await client.callTool({
      name: "recall",
      arguments: { query: "непротивление злу насилием", only_mine: true },
    });
    const { hits } = res.structuredContent as { hits: { voice: string }[] };
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(["tolstoy", "quoted"]).toContain(h.voice);
  });

  it("дочитывает письмо целиком", async () => {
    const res = await client.callTool({ name: "read_document", arguments: { doc_id: "v61_288_A_A_Fetu" } });
    expect(res.structuredContent).toMatchObject({
      id: "v61_288_A_A_Fetu",
      addressee: expect.stringContaining("Фет"),
    });
  });
});
