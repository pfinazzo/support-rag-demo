/**
 * Why this file exists: the demo shows an edit to a document flowing into the search
 * index. This file keeps two documents in a small SQLite database and the rest as
 * Markdown files. Database triggers queue every change for the re-indexer.
 * Without it, the index could not tell which documents changed, so it would have
 * to rebuild everything.
 */
import initSqlJs, { type Database } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';

/** The documents kept in the SQLite database. The other documents stay as Markdown files. */
export const DATABASE_DOCS = ['api-and-webhooks.md', 'data-export-and-deletion.md'];

/**
 * A small in-memory SQLite database of documents, plus a queue of changes.
 * The data is lost when the server stops. Starting again loads it from the files.
 */
export class DocumentStore {
  /** The sql.js database that holds the documents and the change queue. */
  public db: Database;

  /** The folder that holds the Markdown documents. */
  private docsDir: string;

  /** Private: callers use `open`, because loading SQLite is asynchronous. */
  private constructor({ db, docsDir }: { db: Database; docsDir: string }) {
    this.db = db;
    this.docsDir = docsDir;
  }

  /**
   * Creates the database, its tables and triggers, and loads the starting documents.
   * Reads the files in `reference/db-documents`, next to the docs folder.
   * Throws if one of those files is missing.
   */
  static async open({ docsDir }: { docsDir: string }) {
    const SQL = await initSqlJs();
    const store = new DocumentStore({ db: new SQL.Database(), docsDir });
    /**
     * Three triggers copy every insert, update and delete into `reindex_queue`.
     * Why: the re-indexer reads that queue. Without the triggers, an edit made straight
     * in the database would never reach the search index.
     */
    store.db.run(
      `CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT NOT NULL);CREATE TABLE reindex_queue(seq INTEGER PRIMARY KEY AUTOINCREMENT,document_id TEXT,operation TEXT);CREATE TRIGGER documents_insert AFTER INSERT ON documents BEGIN INSERT INTO reindex_queue(document_id,operation) VALUES(NEW.id,'insert');END;CREATE TRIGGER documents_update AFTER UPDATE ON documents BEGIN INSERT INTO reindex_queue(document_id,operation) VALUES(NEW.id,'update');END;CREATE TRIGGER documents_delete AFTER DELETE ON documents BEGIN INSERT INTO reindex_queue(document_id,operation) VALUES(OLD.id,'delete');END;`,
    );
    for (const id of DATABASE_DOCS)
      store.write({
        id,
        content: fs.readFileSync(path.join(docsDir, '../reference/db-documents', id), 'utf8'),
      });
    return store;
  }

  /** Saves a document. Adds it or replaces its text. The trigger queues the change. */
  write({ id, content }: { id: string; content: string }) {
    this.db.run(
      'INSERT INTO documents(id,content) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content',
      [id, content],
    );
  }

  /** Removes a document. The trigger queues the change. */
  delete({ id }: { id: string }) {
    this.db.run('DELETE FROM documents WHERE id=?', [id]);
  }

  /** Returns the text of a database document, or undefined if there is none. */
  read({ id }: { id: string }): string | undefined {
    const r = this.db.exec('SELECT content FROM documents WHERE id=?', [id]);
    return r[0]?.values[0]?.[0] as string | undefined;
  }

  /**
   * Lists every document with its text and where it came from.
   * The source is "markdown" for the two named files on disk and "sqlite" for database documents.
   * Other Markdown files in the folder are not listed here.
   */
  documents() {
    return [
      ...fs
        .readdirSync(this.docsDir)
        .filter((f) => ['billing-and-refunds.md', 'sso-and-authentication.md'].includes(f))
        .map((id) => ({
          id,
          content: fs.readFileSync(path.join(this.docsDir, id), 'utf8'),
          source: 'markdown',
        })),
      ...(this.db.exec('SELECT id,content FROM documents')[0]?.values || []).map((r) => ({
        id: String(r[0]),
        content: String(r[1]),
        source: 'sqlite',
      })),
    ];
  }

  /** Lists changes waiting for the re-indexer, oldest first. */
  queue() {
    return (
      this.db.exec('SELECT seq,document_id,operation FROM reindex_queue ORDER BY seq')[0]?.values ||
      []
    ).map((r) => ({ seq: Number(r[0]), documentId: String(r[1]), operation: String(r[2]) }));
  }

  /**
   * Removes every queued change up to and including `seq`.
   * The re-indexer calls this once it has handled them.
   */
  ack({ seq }: { seq: number }) {
    this.db.run('DELETE FROM reindex_queue WHERE seq<=?', [seq]);
  }

  /** Summarizes the documents, the waiting changes and the trigger definitions for the page. */
  status() {
    return {
      documents: this.documents().map((d) => ({
        id: d.id,
        source: d.source,
        characters: d.content.length,
      })),
      queue: this.queue(),
      triggers: this.db.exec("SELECT name,sql FROM sqlite_master WHERE type='trigger'")[0]?.values,
    };
  }
}
