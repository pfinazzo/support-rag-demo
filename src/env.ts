/**
 * Why this file exists: the app reads its settings from a `.env` file, and this
 * file loads that file without an extra package. Without it, settings written
 * in `.env` would never reach `process.env`.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Copies KEY=VALUE lines from a `.env` file into `process.env`.
 * Reads the file from disk and changes `process.env`.
 *
 * If the file does not exist: does nothing.
 * If a variable is already set in the real environment: the real value wins.
 * Lines that are blank, start with `#`, or have no key are skipped.
 * Quotes around a value are removed.
 */
export function loadEnv({ filePath = '.env' }: { filePath?: string } = {}): void {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return;
  const text = fs.readFileSync(resolved, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * True when MOCK_AI is "true", in any letter case.
 * Mock mode is an offline dry run with fake vectors, a fake LLM and a fake reranker.
 */
export function isMockAi(): boolean {
  return String(process.env.MOCK_AI || '').toLowerCase() === 'true';
}

/**
 * Reads a number from an environment variable.
 * If the variable is unset, empty or not a number: returns the fallback.
 */
export function envNumber({ name, fallback }: { name: string; fallback: number }): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
