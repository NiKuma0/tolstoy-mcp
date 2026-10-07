/**
 * MCP-сервер: память «Толстого» как инструменты. Агентом работает сам клиент (Claude Desktop,
 * Claude Code), мы отдаём только поиск и чтение.
 *
 * Сервер отвечает на initialize сразу. На старте недостающие файлы только докачиваются в фоне,
 * а в память (модель и векторы, ~700 МБ RAM) всё грузится при первом вызове инструмента: Claude Desktop
 * держит несколько процессов сервера, и не каждому нужна память. Пока её нет, инструменты отвечают,
 * сколько ещё осталось.
 */
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import pkg from "../package.json" with { type: "json" };
import { Downloads } from "./assets.js";
import { Embedder } from "./embedder.js";
import { log } from "./log.js";
import { type Hit, MAX_SEGMENTS, Memory, NotFoundError, openDatabase } from "./memory.js";
import { INSTRUCTIONS, MCP_CITATIONS, ORTHOGRAPHY, PERSONA } from "./prompts.js";

/** Сколько инструмент ждёт готовности памяти, прежде чем ответить «ещё загружается». */
const READY_WAIT_MS = 20_000;

/** Ленивая загрузка памяти с повтором после ошибки (например, пропала сеть во время загрузки). */
export class MemoryLoader {
  private loading: Promise<Memory> | null = null;
  private memory: Memory | null = null;
  readonly downloads = new Downloads();

  /** Докачать недостающие файлы, ничего не загружая в память. */
  prefetch(): void {
    this.downloads
      .ensureAll()
      .catch((e) => log.warn(`prefetch failed: ${e instanceof Error ? e.message : e}`));
  }

  start(): Promise<Memory> {
    this.loading ??= this.load().then(
      (m) => {
        this.memory = m;
        return m;
      },
      (e) => {
        this.loading = null;
        log.error(`memory failed to load: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
        throw e;
      },
    );
    return this.loading;
  }

  private async load(): Promise<Memory> {
    const started = Date.now();
    const paths = await this.downloads.ensureAll();
    const [{ db, vectors }, embedder] = await Promise.all([
      Promise.resolve().then(() => openDatabase(paths.db)),
      Embedder.load(paths),
    ]);
    log.info(`memory ready in ${Date.now() - started} ms: ${vectors.size} vectors`);
    return new Memory(db, vectors, embedder);
  }

  /** Готовая память или текст для пользователя, почему её пока нет. */
  async get(): Promise<Memory | string> {
    if (this.memory) return this.memory;
    const timeout = new Promise<null>((r) => setTimeout(r, READY_WAIT_MS, null).unref());
    try {
      const m = await Promise.race([this.start(), timeout]);
      if (m) return m;
      return `Память ещё загружается: ${this.downloads.describe()}. При первом запуске скачиваются база и модель; повтори запрос через минуту.`;
    } catch (e) {
      return `Не удалось загрузить память: ${e instanceof Error ? e.message : String(e)}. Повтори запрос, загрузка начнётся заново.`;
    }
  }
}

const HitSchema = z.object({
  doc_id: z.string(),
  segment_ids: z.array(z.string()),
  header: z.string().describe("кто, что, когда: «Толстой. Письмо А. А. Фету от 30 августа 1869 г.»"),
  text: z.string().describe("текст фрагмента как в источнике, часто в дореформенной орфографии"),
  voice: z.string().describe("tolstoy | quoted | contemporary | editor"),
  score: z.number(),
  vec_rank: z.number().nullable().describe("место в поиске по смыслу"),
  lex_rank: z.number().nullable().describe("место в поиске по словам"),
});

const SegmentSchema = z.object({
  id: z.string(),
  ord: z.number(),
  kind: z.string().describe("p, l (строка стиха), head, opener, closer, footnote, comment…"),
  voice: z.string(),
  attribution: z.string().nullable().describe("у voice=quoted: чья цитата"),
  page_from: z.string().nullable().describe("страница тома ПСС"),
  text: z.string(),
});

const DocumentSchema = z.object({
  id: z.string(),
  corpus: z.string(),
  voice: z.string(),
  title: z.string(),
  bibl: z.string().nullable().describe("библиографическая ссылка"),
  author: z.string().nullable(),
  addressee: z.string().nullable().describe("адресат письма"),
  date_text: z.string().nullable(),
  volume: z.number().nullable().describe("том ПСС"),
  pages: z.string().nullable(),
  total_segments: z.number(),
  segments: z.array(SegmentSchema),
  next_start: z.number().nullable().describe("start для следующей порции; null — документ дочитан"),
});

const errorResult = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

type ToolResult = ReturnType<typeof errorResult> | ReturnType<typeof jsonResult>;

/** Лог вызова инструмента: аргументы, время и краткий итог (или ошибка). */
async function traced(
  tool: string,
  args: object,
  run: () => Promise<ToolResult>,
  summary: (data: Record<string, unknown>) => string,
): Promise<ToolResult> {
  const started = performance.now();
  const ms = () => `${Math.round(performance.now() - started)} ms`;
  try {
    const res = await run();
    if ("isError" in res)
      log.warn(`${tool} ${JSON.stringify(args)} → error in ${ms()}: ${res.content[0]?.text}`);
    else log.info(`${tool} ${JSON.stringify(args)} → ${summary(res.structuredContent)} in ${ms()}`);
    return res;
  } catch (e) {
    log.error(`${tool} ${JSON.stringify(args)} → exception in ${ms()}: ${e instanceof Error ? e.stack : e}`);
    throw e;
  }
}
const jsonResult = <T extends Record<string, unknown>>(data: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  structuredContent: data,
});

export function createServer(loader: Pick<MemoryLoader, "get">): McpServer {
  const server = new McpServer({ name: "tolstoy", version: pkg.version }, { instructions: INSTRUCTIONS });
  const annotations = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "recall",
    {
      title: "Вспомнить",
      description: "Найти фрагменты корпуса Толстого по теме (гибридный поиск: смысл + слова).",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("Что вспомнить: имена, названия, тема, время. Современной орфографией."),
        only_mine: z
          .boolean()
          .default(false)
          .describe("Только тексты самого Толстого, без современников и примечаний редакторов."),
        top: z.number().int().min(1).max(10).default(5),
      }),
      outputSchema: z.object({ hits: z.array(HitSchema) }),
      annotations,
    },
    (args) =>
      traced(
        "recall",
        args,
        async () => {
          const memory = await loader.get();
          if (typeof memory === "string") return errorResult(memory);
          return jsonResult({ hits: await memory.recall(args.query, args.top, args.only_mine) });
        },
        (r) =>
          (r.hits as Hit[])
            .map((h) => `${h.doc_id}(${h.voice} v${h.vec_rank ?? "-"}/l${h.lex_rank ?? "-"})`)
            .join(", ") || "nothing",
      ),
  );

  server.registerTool(
    "read_document",
    {
      title: "Прочитать документ",
      description: "Прочитать документ (письмо, дневниковую запись, главу) по порядку сегментов, с шапкой.",
      inputSchema: z.object({
        doc_id: z.string().describe("doc_id из recall"),
        segment_id: z
          .string()
          .optional()
          .describe("показать окно вокруг этого сегмента (segment_ids из recall)"),
        start: z.number().int().min(0).default(0).describe("ord, с которого читать (next_start)"),
        limit: z.number().int().min(1).max(MAX_SEGMENTS).default(30),
      }),
      outputSchema: DocumentSchema,
      annotations,
    },
    (args) =>
      traced(
        "read_document",
        args,
        async () => {
          const memory = await loader.get();
          if (typeof memory === "string") return errorResult(memory);
          try {
            return jsonResult(memory.readDocument(args.doc_id, args.segment_id, args.start, args.limit));
          } catch (e) {
            if (e instanceof NotFoundError) return errorResult(e.message);
            throw e;
          }
        },
        (d) => `${(d.segments as unknown[]).length} segments, next_start ${d.next_start}`,
      ),
  );

  server.registerPrompt(
    "tolstoy",
    {
      title: "Говорить с Толстым",
      description: "Говорить с пользователем от лица Льва Толстого, опираясь на его память.",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: [PERSONA, ORTHOGRAPHY, MCP_CITATIONS].join("\n\n") },
        },
      ],
    }),
  );

  return server;
}
