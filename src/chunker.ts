/**
 * Why this file exists: search needs small pieces of each support document,
 * each labeled with its topic and the roles that may read it. This file cuts
 * Markdown into those pieces. Without it, search would return whole files
 * with no topic and no role labels.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ChunkDraft } from './types.js';
import { rolesForChunk } from './roles.js';

/**
 * Cuts one Markdown file into sections, one per heading.
 * Only `#`, `##` and `###` headings start a new section.
 *
 * Each section carries its heading path, such as "Billing > Refunds".
 * It also carries a one-sentence context header, a "Topic:" prefix and its roles.
 * A section with no body text is dropped.
 * Text above the first heading is dropped too.
 * Without the context header, a short section would not say which document it came from.
 */
export function chunkMarkdown({
  markdown,
  sourceFile,
}: {
  markdown: string;
  sourceFile: string;
}): ChunkDraft[] {
  const lines = markdown.split(/\r?\n/);
  const hierarchy: string[] = [];
  let current: { level: number; title: string; lines: string[] } | null = null;
  const chunks: ChunkDraft[] = [];

  /**
   * Turns the section being read into a finished chunk and adds it to the list.
   * Does nothing if no section is open. Drops the section if its body is empty.
   */
  const flush = (): void => {
    if (!current) return;
    const rawContent = current.lines.join('\n').trim();
    if (!rawContent) {
      current = null;
      return;
    }
    const headingPath = hierarchy.filter(Boolean).join(' > ');
    const contextHeader = `From ${hierarchy[0] || sourceFile}, covering ${hierarchy.slice(1).join(' / ') || 'document overview'}.`;
    const contextualizedContent = contextHeader + '\n\n' + rawContent;
    const prefixedText = headingPath
      ? `Topic: ${headingPath}\n\n${contextualizedContent}`
      : contextualizedContent;
    const roles = rolesForChunk({ sourceFile, headingPath });
    chunks.push({
      sourceFile,
      headingPath,
      rawContent,
      prefixedText,
      contextHeader,
      contextualizedContent,
      roles,
    });
    current = null;
  };

  for (const line of lines) {
    /** Matches a heading of level one to three. Group 1 is the hashes, group 2 the title. */
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      const level = match[1].length;
      const title = match[2].trim();
      /** A new heading drops the earlier headings at its level and deeper. */
      hierarchy.length = level - 1;
      hierarchy[level - 1] = title;
      current = { level, title, lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return chunks;
}

/**
 * Reads the support documents from disk and cuts each into sections.
 * Reads files from `docsDir` and from the seed folder `../reference/db-documents` beside it.
 *
 * Only the four listed file names are read. Other files in those folders are skipped.
 * If a file exists in both folders: the copy in `docsDir` is used.
 * Files are read in name order, so the section order is the same on every run.
 */
export function loadAndChunkDocs({ docsDir }: { docsDir: string }): ChunkDraft[] {
  /** Seed copies of the documents that live in the database. */
  const seedDir = path.resolve(docsDir, '../reference/db-documents');
  const files = [
    ...fs.readdirSync(docsDir),
    ...(fs.existsSync(seedDir) ? fs.readdirSync(seedDir) : []),
  ]
    .filter((f) =>
      [
        'billing-and-refunds.md',
        'sso-and-authentication.md',
        'api-and-webhooks.md',
        'data-export-and-deletion.md',
      ].includes(f),
    )
    .sort();
  const all: ChunkDraft[] = [];
  for (const file of files) {
    const text = fs.readFileSync(
      path.join(fs.existsSync(path.join(docsDir, file)) ? docsDir : seedDir, file),
      'utf8',
    );
    all.push(...chunkMarkdown({ markdown: text, sourceFile: file }));
  }
  return all;
}
