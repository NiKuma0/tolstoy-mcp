/**
 * tolstoy-mcp                         MCP-сервер по stdio (так его запускают Claude Desktop и Claude Code)
 * tolstoy-mcp download                заранее скачать базу и модель
 * tolstoy-mcp search "запрос" [--mine] [--top 5]
 * tolstoy-mcp info                    где лежат данные и что уже скачано
 *
 * Каталог данных: $TOLSTOY_DATA_DIR или системный каталог данных приложения.
 */
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import pkg from "../package.json" with { type: "json" };
import { ASSETS, type AssetName, BUNDLED_DIR, dataDir, locateAsset } from "./assets.js";
import { log, logFile } from "./log.js";
import { createServer, MemoryLoader } from "./server.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mine: { type: "boolean", default: false },
    top: { type: "string", default: "5" },
    version: { type: "boolean", short: "v" },
  },
});

async function serve() {
  const loader = new MemoryLoader();
  log.info(`tolstoy-mcp ${pkg.version}, node ${process.version}, data in ${dataDir()}`);
  await serveStdio(() => createServer(loader), { onerror: (e) => log.error(`transport: ${e.message}`) });
  // только докачка файлов; в память всё грузится при первом вызове инструмента
  loader.prefetch();
}

async function download() {
  const loader = new MemoryLoader();
  const timer = setInterval(() => log.info(loader.downloads.describe()), 5000);
  try {
    await loader.downloads.ensureAll();
    log.info(`all files are in ${dataDir()}`);
  } finally {
    clearInterval(timer);
  }
}

async function search(query: string) {
  const memory = await new MemoryLoader().start();
  const hits = await memory.recall(query, Number(values.top), values.mine);
  for (const h of hits) {
    console.log(
      `${h.score.toFixed(4)}  vec #${h.vec_rank ?? "-"}  lex #${h.lex_rank ?? "-"}  ${h.voice}  ${h.doc_id}`,
    );
    console.log(`    ${h.header}`);
    console.log(`    ${h.text.slice(0, 300).replaceAll("\n", "\n    ")}\n`);
  }
  memory.close();
}

function info() {
  console.log(`tolstoy-mcp ${pkg.version}\nbundled: ${BUNDLED_DIR}\ndata: ${dataDir()}\nlog: ${logFile}`);
  for (const name of Object.keys(ASSETS) as AssetName[]) {
    const path = locateAsset(ASSETS[name]);
    console.log(`  ${path ? "✓" : "✗"} ${name.padEnd(16)} ${path ?? "не скачан"}`);
  }
}

const [command = "serve", ...rest] = positionals;
if (values.version) console.log(pkg.version);
else if (command === "serve") await serve();
else if (command === "download") await download();
else if (command === "info") info();
else if (command === "search" && rest.length) await search(rest.join(" "));
else {
  console.error('usage: tolstoy-mcp [serve | download | info | search "запрос" [--mine] [--top 5]]');
  process.exit(2);
}
