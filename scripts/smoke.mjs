/**
 * Проверка распакованного .mcpb на текущей ОС, без зависимостей и без скачивания данных:
 * 1) нативный onnxruntime из бандла грузится; 2) сервер отвечает на initialize и tools/list.
 *
 *   npx mcpb unpack build/tolstoy-0.1.0-linux.mcpb build/unpacked && node scripts/smoke.mjs build/unpacked
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const dir = resolve(process.argv[2] ?? ".");
const fail = (msg) => {
  console.error(`smoke: FAIL ${msg}`);
  process.exit(1);
};

// 1. нативный модуль: require грузит onnxruntime_binding.node под эту платформу
const ort = createRequire(join(dir, "package.json"))("onnxruntime-node");
const backends = ort.listSupportedBackends?.() ?? [];
if (!backends.some((b) => b.name === "cpu"))
  fail(`onnxruntime has no cpu backend: ${JSON.stringify(backends)}`);
console.error(`smoke: onnxruntime ${ort.env.versions?.node ?? ""} ok on ${process.platform}/${process.arch}`);

// 2. MCP по stdio. Каталог данных пустой, а URL данных недоступен: сервер должен подняться и без них.
const child = spawn(process.execPath, [join(dir, "dist/index.js")], {
  env: {
    ...process.env,
    TOLSTOY_DATA_DIR: mkdtempSync(join(tmpdir(), "tolstoy-smoke-")),
    TOLSTOY_DATA_URL: "http://127.0.0.1:9",
  },
  stdio: ["pipe", "pipe", "inherit"],
});
const timer = setTimeout(() => fail("timeout"), 30_000);
const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const lines = createInterface({ input: child.stdout });

send({
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});
for await (const line of lines) {
  const msg = JSON.parse(line);
  if (msg.error) fail(JSON.stringify(msg.error));
  if (msg.id === 1) {
    console.error(
      `smoke: initialize ok, server ${msg.result.serverInfo.name} ${msg.result.serverInfo.version}`,
    );
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
  } else if (msg.id === 2) {
    const names = msg.result.tools.map((t) => t.name).sort();
    if (names.join() !== "read_document,recall") fail(`unexpected tools ${names}`);
    console.error(`smoke: tools ${names.join(", ")}`);
    break;
  }
}
clearTimeout(timer);
child.kill();
console.error("smoke: OK");
