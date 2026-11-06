# Support RAG Pipeline

A support-question pipeline in TypeScript. It filters by permission, searches two ways, checks its own citations, and holds low-confidence answers for a person.

## Run

```sh
npm install
npm run build:client
HOT_RELOAD=0 npm start
```

Open http://localhost:3000. Node 20.20.2 or newer.

## How one request flows

1. **Security.** Four gates check the question: known attack phrases, disguised-character rules, a prompt-injection classifier (Llama Prompt Guard 2), and untrusted-text tags around the question and retrieved documents. A blocked request stops here.
2. **Semantic cache.** The question is embedded and compared by cosine similarity with saved questions. If the match is above the threshold (0.85), the saved answer is returned and steps 3 to 8 are skipped. Each role has its own cache graph.
3. **Query rewrite.** A short or vague question ("402", "how long does that take?") is rewritten into a full search query. A clear question is left as it is.
4. **Search.**
   - Filter chunks by the caller's roles before any scoring.
   - Vector search (Pinecone, cosine) and BM25 keyword search run on the permitted chunks.
   - Reciprocal Rank Fusion (k = 30) merges the two lists into a shortlist of 8.
   - A cross-encoder reranker keeps the top 3.
   - Each chunk carries a context header, such as "From Billing, covering Refunds", that is embedded with it.
5. **Context.** The prompt is built from five blocks: system prompt, tool definitions, retrieved chunks, history and question. Token counts are estimated. Older turns are summarized if history grows too fast. A hard gate rejects a prompt that does not fit the model window.
6. **Model router.** Question length, reasoning words, multiple questions, tools and past answer quality pick Haiku, Sonnet or Opus. Backups are Claude models only. The stable start of the prompt uses Anthropic prompt caching.
7. **Generate.** Claude writes the answer and may call three tools, at most five rounds: search the documents, look up a ticket (`TCK-1042`), or record an escalation. Tool inputs follow strict schemas.
8. **Fact-check.** Each cited source gets three checks: the page loads, a DeBERTa entailment model confirms the source supports the claim, and every quoted phrase appears word for word.
9. **Result.** A confidence score combines evidence, retrieval strength, format validity, numeric consistency and a 10% model self-report. Below 0.72 the answer is held for human review.

## Indexing

Markdown is split at `#`, `##` and `###` headings. Each chunk gets a context header and a list of roles allowed to read it. Chunks are embedded (OpenAI `text-embedding-3-small`) and upserted to a Pinecone serverless cosine index in batches of 50. Without a Pinecone key, a local simulator applies the same role filter. Without an OpenAI key, mock embeddings are used.

When a source document changes, its SHA-256 fingerprint changes. Only that document is re-chunked, unchanged sections keep their vectors, and saved answers are cleared.
