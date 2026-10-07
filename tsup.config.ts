import { defineConfig } from "tsup";

// Зависимости не бандлим: нативные (onnxruntime-node, sqlite-vec) всё равно едут в node_modules,
// а mcpb кладёт production node_modules в пакет целиком.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  // node:sqlite существует только с префиксом node:, а tsup по умолчанию его срезает
  removeNodeProtocol: false,
});
