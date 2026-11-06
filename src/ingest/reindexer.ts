/**
 * Why this file exists: when a document is added, edited or deleted, search
 * must follow. This file reads the queue of document changes and re-indexes only
 * the documents that changed. A section whose text did not change keeps its old
 * embedding, so it is not sent to OpenAI again.
 * Without it, search would show old text, or every edit would pay to embed
 * every document again.
 */
import { createHash } from 'node:crypto';
import { chunkMarkdown } from './chunker.js';
import { embedText } from '../retrieval/embeddings.js';
import { createSearcher } from '../retrieval/search.js';
import type { DocChunk } from '../types.js';
import type { DocumentStore } from './doc-store.js';

/** Returns the SHA-256 hash of a text, as hex. Equal text always gives an equal hash. */
export const contentHash = ({ text }: { text: string }) =>
  createHash('sha256').update(text).digest('hex');

/** `content` is undefined when the document was deleted. `operation` is `initial`, `insert`, `update` or `delete`. */
type IndexDocumentParams = { id: string; content: string | undefined; operation: string };

/** The search index, kept in step with the document store. One shared instance lives in `runtime.ts`. */
export class IncrementalIndexer {
  /** Every chunk of every document. */
  chunks: DocChunk[] = [];

  /** The hash of each document's text when it was last indexed. */
  private hashes = new Map<string, string>();

  /** What each indexing step did. Shows on the page. Keeps the latest 100. */
  events: Array<Record<string, unknown>> = [];

  /** The end of the indexing work so far. New work waits on it, so two drains never run at once. */
  private worker: Promise<unknown> = Promise.resolve();

  /** Searches the current chunks. It is replaced after each document is indexed. */
  searcher = createSearcher({ rawChunks: [] });

  public store: DocumentStore;

  /** Makes embeddings. A test can pass a fake. */
  private embed: typeof embedText;

  constructor({ store, embed = embedText }: { store: DocumentStore; embed?: typeof embedText }) {
    this.store = store;
    this.embed = embed;
  }

  /**
   * Indexes every document in the store and returns the indexer.
   * Then clears the change queue and the event list.
   * Opening the store queued one insert for each starting document. This step
   * has already indexed them, so replaying them would repeat the work.
   */
  async initialize() {
    for (const doc of this.store.documents())
      await this.indexDocument({ id: doc.id, content: doc.content, operation: 'initial' });
    const q = this.store.queue();
    if (q.length) this.store.ack({ seq: q.at(-1)!.seq });
    this.events = [];
    return this;
  }

  /**
   * Brings one document's chunks up to date and returns an event describing what happened.
   * Normally: splits the text into chunks, reuses the embedding of any chunk whose text did not change, and embeds the rest.
   * If the document's hash did not change: does nothing and reports `skipped`.
   * If `content` is undefined: removes the document's chunks and reports `deleted`.
   * Embeds through OpenAI unless MOCK_AI is on. Replaces `searcher`.
   * Without the reuse, one edited sentence would re-embed the whole document.
   */
  private async indexDocument({ id, content, operation }: IndexDocumentParams) {
    const before = this.chunks.filter((c) => c.sourceFile === id),
      hash = content === undefined ? null : contentHash({ text: content }),
      oldHash = this.hashes.get(id) || null;
    let embedded = 0,
      reused = 0;
    if (hash === oldHash) {
      const e = {
        documentId: id,
        operation,
        triggerFired: true,
        status: 'skipped',
        beforeHash: oldHash,
        afterHash: hash,
        embeddings: 0,
        reused: before.length,
        beforeChunks: before.length,
        afterChunks: before.length,
      };
      this.events.push(e);
      return e;
    }
    let next: DocChunk[] = [];
    if (content !== undefined) {
      /** The document's current chunks, found by the hash of their text. A new chunk with the same hash takes the old one. */
      const old = new Map(
        before.map((c) => [contentHash({ text: c.contextualizedContent || c.prefixedText }), c]),
      );
      for (const [i, draft] of chunkMarkdown({ markdown: content, sourceFile: id }).entries()) {
        const text = draft.contextualizedContent || draft.prefixedText,
          h = contentHash({ text }),
          existing = old.get(h);
        if (existing) {
          next.push(existing);
          reused++;
        } else {
          next.push({
            ...draft,
            contentHash: h,
            id: id + '::' + contentHash({ text: draft.headingPath }).slice(0, 10) + '::' + i,
            embedding: await this.embed({ text }),
          });
          embedded++;
        }
      }
      this.hashes.set(id, hash!);
    } else this.hashes.delete(id);
    this.chunks = [...this.chunks.filter((c) => c.sourceFile !== id), ...next];
    this.searcher = createSearcher({ rawChunks: this.chunks });
    const e = {
      documentId: id,
      operation,
      triggerFired: operation !== 'initial',
      status: content === undefined ? 'deleted' : 'indexed',
      beforeHash: oldHash,
      afterHash: hash,
      embeddings: embedded,
      reused,
      beforeChunks: before.length,
      afterChunks: next.length,
      at: new Date().toISOString(),
    };
    this.events.push(e);
    this.events = this.events.slice(-100);
    return e;
  }

  /**
   * Applies every queued document change, in order, and returns each one's event.
   * Waits for any earlier drain to finish first, so two drains never overlap.
   * Removes a change from the queue only after it is indexed.
   * If indexing fails: the change stays queued and the next drain retries it.
   * A failed drain does not block later drains. The failure reaches only the caller.
   */
  drain() {
    const task = this.worker.then(async () => {
      const results = [];
      for (const item of this.store.queue()) {
        results.push(
          await this.indexDocument({
            id: item.documentId,
            content: this.store.read({ id: item.documentId }),
            operation: item.operation,
          }),
        );
        this.store.ack({ seq: item.seq });
      }
      return results;
    });
    this.worker = task.catch(() => {});
    return task;
  }

  /** Describes the index for the page: store status, chunk count, recent events and document hashes. */
  status() {
    return {
      ...this.store.status(),
      chunkCount: this.chunks.length,
      events: this.events,
      hashes: Object.fromEntries(this.hashes),
    };
  }
}
