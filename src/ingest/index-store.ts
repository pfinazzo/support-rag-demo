/**
 * Why this file exists: the index of embedded sections is built once and then
 * saved to a JSON file. This file saves and loads that file. Without it, the
 * server would have to embed every section again on each start.
 *
 * Real mode uses data/index.json. Mock mode uses data/index.mock.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isMockAi } from '../env.js';
import type { DocChunk, IndexFile } from '../types.js';

/**
 * Gives the index file path for real or mock mode.
 * Mock mode uses its own file, so fake vectors never overwrite the real index.
 * Mock mode is on when MOCK_AI is "true", unless the caller says otherwise.
 */
export function indexPathForMode({
  dataDir,
  mock = isMockAi(),
}: {
  dataDir: string;
  mock?: boolean;
}): string {
  return path.join(dataDir, mock ? 'index.mock.json' : 'index.json');
}

type SaveIndexParams = {
  filePath: string;
  records: DocChunk[];
  meta?: { mock?: boolean; model?: string | null };
};

/**
 * Writes the index to a JSON file and returns what it wrote.
 * Creates the folder if needed and overwrites any file already there.
 * The file records the time, the chunk count, the model name and whether it is mock.
 */
export function saveIndex({ filePath, records, meta = {} }: SaveIndexParams): IndexFile {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload: IndexFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    mock: Boolean(meta.mock),
    model: meta.model || null,
    chunkCount: records.length,
    chunks: records,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return payload;
}

/**
 * Reads the index file from disk.
 * Throws if the file is missing, and the message says which npm script builds it.
 * Throws if the file has no `chunks` list.
 */
export function loadIndex({ filePath }: { filePath: string }): IndexFile {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Index not found at ${filePath}. Run \`npm run index\` (or \`npm run index:mock\` for offline mode) first.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as IndexFile;
  if (!raw.chunks || !Array.isArray(raw.chunks)) {
    throw new Error(`Invalid index file: ${filePath}`);
  }
  return raw;
}
