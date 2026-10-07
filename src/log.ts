/**
 * Логи: stderr (stdout занят протоколом stdio) и файл. Claude Desktop складывает stderr расширений
 * в общий main.log, поэтому свой файл удобнее: `tolstoy-mcp info` покажет путь, дальше
 * `tail -f` / `Get-Content -Wait`. Процессов сервера бывает несколько, поэтому в строке есть pid.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import envPaths from "env-paths";

const MAX_BYTES = 5_000_000;

export const logFile =
  process.env.TOLSTOY_LOG_FILE || join(envPaths("tolstoy-mcp", { suffix: "" }).log, "tolstoy-mcp.log");

let fileOk = true;
try {
  mkdirSync(dirname(logFile), { recursive: true });
  if ((statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES)
    renameSync(logFile, `${logFile}.1`);
} catch {
  fileOk = false;
}

function write(level: string, msg: string) {
  const line = `${new Date().toISOString()} [${process.pid}] ${level} ${msg}\n`;
  process.stderr.write(line);
  if (!fileOk) return;
  try {
    appendFileSync(logFile, line);
  } catch {
    fileOk = false; // нет прав или диск полон: остаётся stderr
  }
}

export const log = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
};
