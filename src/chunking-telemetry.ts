/**
 * Why this file exists: the page's "how the documents were split" view needs
 * the headings found in each document, the chunks cut from them, and the
 * search settings in force. This builds that report from plain data. It reads
 * nothing itself, so it can be tested without starting a server.
 */
import { chunkMarkdown } from './chunker.js';
import { ROLE_PRESETS } from './roles.js';
import type { DocChunk } from './types.js';

type SourceDocument = { readonly id: string; readonly content: string };

type SearchSettings = {
  readonly rrfK: number;
  readonly shortlistTopK: number;
  readonly finalTopK: number;
  readonly minVectorSimilarity: number;
  readonly minRerankScore: number;
};

type Heading = { level: number; title: string; line: number; marker: string };

const HEADING_PATTERN = /^(#{1,3})\s+(.+?)\s*$/;

/** Orders documents by id in plain character order, so the report is stable between runs. */
const byId = (first: SourceDocument, second: SourceDocument): number =>
  Number(first.id > second.id) - Number(first.id < second.id);

/** Reads one line as a heading, or returns null if it is not one. */
const toHeading = ({ line, lineNumber }: { line: string; lineNumber: number }): Heading | null => {
  const match = HEADING_PATTERN.exec(line);
  return match
    ? { level: match[1].length, title: match[2].trim(), line: lineNumber, marker: match[1] }
    : null;
};

const isHeading = (heading: Heading | null): heading is Heading => heading !== null;

/** Lists every heading in a document with its level and line number. */
const findHeadings = ({ markdown }: { markdown: string }): Heading[] =>
  markdown
    .split(/\r?\n/)
    .map((line, lineIndex) => toHeading({ line, lineNumber: lineIndex + 1 }))
    .filter(isHeading);

/** The key that matches a freshly cut chunk to its entry in the live index. */
const toChunkKey = ({
  sourceFile,
  headingPath,
}: {
  sourceFile: string;
  headingPath: string;
}): string => `${sourceFile}::${headingPath}`;

/** One cut chunk, with the id the live index gave it when there is one. */
const toChunkTelemetry = ({
  draft,
  localId,
  indexedChunkIdsByKey,
}: {
  draft: ReturnType<typeof chunkMarkdown>[number];
  localId: number;
  indexedChunkIdsByKey: Map<string, string>;
}) => ({
  localId,
  sourceFile: draft.sourceFile,
  headingPath: draft.headingPath,
  rawContent: draft.rawContent,
  prefixedText: draft.prefixedText,
  prefix: draft.headingPath ? `Topic: ${draft.headingPath}` : null,
  id: indexedChunkIdsByKey.get(toChunkKey(draft)),
});

/** One document with its headings and the chunks cut from it. */
const toDocumentTelemetry = ({
  document,
  indexedChunkIdsByKey,
}: {
  document: SourceDocument;
  indexedChunkIdsByKey: Map<string, string>;
}) => {
  const headings = findHeadings({ markdown: document.content });
  return {
    sourceFile: document.id,
    charCount: document.content.length,
    headingCount: headings.length,
    headings,
    chunks: chunkMarkdown({ markdown: document.content, sourceFile: document.id }).map(
      (draft, localId) => toChunkTelemetry({ draft, localId, indexedChunkIdsByKey }),
    ),
  };
};

/** One indexed chunk as the page lists it, with the size of its vector instead of the vector. */
const toFlatChunk = ({ chunk }: { chunk: DocChunk }) => ({
  id: chunk.id,
  sourceFile: chunk.sourceFile,
  headingPath: chunk.headingPath,
  rawContent: chunk.rawContent,
  prefixedText: chunk.prefixedText,
  embeddingDims: Array.isArray(chunk.embedding) ? chunk.embedding.length : 0,
  roles: chunk.roles || [],
});

/** Builds the chunking report. The inputs are not changed. */
export const buildChunkingTelemetry = ({
  documents,
  indexedChunks,
  searchSettings,
  rerankerBackend,
  llmProvider,
  isMockEmbeddings,
  pinecone,
}: {
  documents: readonly SourceDocument[];
  indexedChunks: readonly DocChunk[];
  searchSettings: SearchSettings;
  rerankerBackend: string;
  llmProvider: string;
  isMockEmbeddings: boolean;
  pinecone: Record<string, unknown>;
}) => {
  const indexedChunkIdsByKey = new Map(indexedChunks.map((chunk) => [toChunkKey(chunk), chunk.id]));
  return {
    ...searchSettings,
    rerankerBackend,
    llmProvider,
    mockEmbeddings: isMockEmbeddings,
    indexedChunkCount: indexedChunks.length,
    pinecone,
    rolePresets: ROLE_PRESETS,
    documents: [...documents]
      .sort(byId)
      .map((document) => toDocumentTelemetry({ document, indexedChunkIdsByKey })),
    flatChunks: indexedChunks.map((chunk) => toFlatChunk({ chunk })),
  };
};
