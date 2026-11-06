# Plain-English interface terminology

The spotlight flow and explicitly opened utility dialogs share this centralized inventory. Terms have short hover/focus explanations in a fixed-position portal outside clipped cards. Source text and raw JSON are not rewritten. Whole-word matching avoids marking fragments of ordinary words.

## Source Fact-Check (Citation Verification)

Terms: Citation Verification, Citation Checker, Source Fact-Check, citation pass rate

Checks every document the chatbot cites after an answer is written. It checks the link, whether the document backs up the claim, and whether quoted words appear exactly.

## Meaning Match Check (DeBERTa NLI)

Terms: DeBERTa NLI, nli-deberta, entailment, contradiction, Meaning Match Check

Compares a claim with its source to see if they agree or say the opposite. It catches missing “not” words that reverse the meaning.

## Exact Word Search (BM25)

Terms: BM25, Sparse Keyword Search, Exact Word Search

Finds sections containing the exact words, error codes, or IDs in the question. Rare terms count more than common words.

## Meaning Search (Vector Embeddings)

Terms: Dense Vector, Vector Search, embeddings, cosine similarity, Meaning Search

Converts text into lists of numbers so sections with similar meanings match even when they use different words.

## Combined Search Ranking (RRF)

Terms: Reciprocal Rank Fusion, RRF, Combined Search Ranking

Merges exact-word and meaning-search results into one balanced list. Sections strong in both rise to the top.

## Deep Relevance Re-Check (Cross-Encoder)

Terms: Cross-Encoder, Re-Rank, ms-marco-MiniLM, reranker

Reads the question and each candidate section together to check how directly it answers the question. Only the strongest sections reach the answer model.

## Instant Repeat-Answer Cache (HNSW)

Terms: Semantic Cache, HNSW, ANN

Saves prior responses and quickly finds new questions asking the same thing in different words. Reusing an answer avoids another model call.

## Cache Match Strictness (Threshold)

Terms: Similarity threshold, Cache Match Strictness, Threshold

Sets how closely a question must match a saved question before reusing its answer. Too low a setting can reuse an answer to a different question.

## Request Security Checks (Prompt Guard)

Terms: Prompt Guard

Checks for attempts to override the chatbot’s rules before documents or models are used. Four independent defenses make bypasses harder.

## Known Attack Phrase Check

Terms: Known Phrase, Naive Phrase, Naive Substring, literal blocklist

Looks for known rule-breaking phrases exactly as written. It is fast but does not catch every disguised attack.

## Disguised Character Check

Terms: Disguised Characters, NFKC, Regex + Normalize, regex, normalization

Cleans up disguised characters, hidden spaces, and punctuation tricks before checking for rule-breaking commands.

## Security Model Check

Terms: Security Model, Guard LLM Classifier, Llama-Prompt-Guard, Guard Classifier

A dedicated security model spots subtle attempts to trick the chatbot even when no banned phrase appears.

## Untrusted Text Isolation

Terms: Untrusted Text Boundary, Data Separation Fence, Data-Side Nonce, nonce, Data Separation, Indirect Injection

Wraps user text and retrieved documents in unique boundary tags. Hidden instructions inside those documents stay data rather than commands.

## Access Permissions (RBAC)

Terms: Role-Based Access Control, RBAC, Access Permissions

Filters documents before their results are used. Each caller sees only information allowed for their team role.

## Shared Instructions Cache (Prompt Cache)

Terms: Shared Instructions Cache, Prompt Cache, cache_control, ephemeral

Keeps fixed instructions and tool definitions warm on Claude’s servers for five minutes. Actual saved tokens are reported separately from local estimates.

## Chat History Trimming (Compaction)

Terms: Compaction, Context Compaction, Chat History Trimming

Replaces older conversation turns with a short summary while keeping recent details. This leaves room for the current question and source documents.

## Turn Size Growth Rate

Terms: Turn Size Growth Rate, Token-Per-Turn, growth_rate

Measures the average tokens added by recent turns. Fast-growing conversations are summarized early instead of waiting until the model runs out of room.

## Text Size Units (Tokens)

Terms: tokens, token count

Tokens are the small pieces of text a model reads or writes, roughly three quarters of a word each. Counts shown by this console are conservative estimates unless reported by the provider.

## Model Size Limit

Terms: Hard Window, hard_window_cap, ContextWindowExceededError

The model can read only a limited amount of text in one call. If required content still cannot fit after trimming, the call is stopped before sending.

## Model Selection (Router)

Terms: Model Router, Router, Model Selection

Chooses a smaller, cheaper model for simple questions and a larger one for difficult work. It shows the signals behind every choice.

## Difficulty Clues

Terms: Proxy Signals, decision signals

Uses observable clues such as question length, wording, tool needs, and past answer quality. These estimate difficulty without an extra model call.

## Complexity Wording

Terms: Linguistic Tells, linguistic tells

Words such as “compare,” “analyze,” and “why” suggest that a question needs deeper reasoning.

## Past Model Results

Terms: historical quality, historical_quality

Uses scores from similar earlier questions to help choose a model. Runtime scores are recorded alongside the initial reference results.

## Backup Model Sequence (Fallback Chain)

Terms: Fallback Chain, Backup Models

If the selected model fails, the system tries the next approved model in order. It stops at the first success and records which models failed.

## Service Temporarily Unavailable (503)

Terms: HTTP 503, http_503

The model service could not handle the call right now. The next backup model is tried.

## Too Many Requests (429)

Terms: 429, rate limit

The provider is limiting traffic for this account. The backup chain tries another permitted model.

## Response Timing

Terms: timeout, TTFT, Time to First Token

A timeout stops a call that takes too long. TTFT measures how long it takes for the first piece of answer text to arrive.

## Live Answer Stream (SSE)

Terms: SSE, Live Token Stream, Streaming

The server sends answer fragments as they arrive, instead of waiting for the entire response. The visible draft stays provisional until validation finishes.

## Required Response Format (JSON Schema)

Terms: Structured Output, JSON Schema, Required Response Format

Every answer must contain required fields such as answer, sources, and confidence. Missing or invalid fields are rejected before release.

## Bounded Tool Workflow (Agent Loop)

Terms: Agent Loop, Tool iteration, Max Iterations

The model can call a tool, read its result, and choose another step or a final answer. A five-call limit prevents endless loops.

## Follow-up Search (Search Agent)

Terms: Search Agent, Follow-up Search

Searches, reads snippets, and refines the query when important parts remain unanswered. It stops when evidence is sufficient or after four passes.

## Available Support Actions

Terms: Tools, Tool Definitions, toolsInvoked, Tool Steps

Defines the actions the model may request: document search, ticket lookup, and local escalation. Each action has required inputs and checked results.

## Document Context Header

Terms: Context Header, Chunk Context, Document Context

Adds a short description of the parent document and section before search indexing. A small section stays understandable on its own.

## Document Section (Chunk)

Terms: chunk, snippet

A small section of a larger support document. Search returns these sections rather than sending every document to the model.

## Changed-Document Refresh

Terms: Re-Indexer, Mixed-Source Re-Indexing, Re-Indexing, Changed-Document Refresh

Keeps search results in sync with file and database documents. Only sections whose text changed need new search representations.

## Database Change Hook (SQLite Trigger)

Terms: SQLite Write Trigger, SQLite, write-hook

A database rule records inserted, changed, or deleted documents automatically. The refresh worker processes those recorded changes.

## Text Fingerprint (SHA-256)

Terms: SHA-256, contentHash, Content Hash, Prefix Hash

A digital fingerprint identifies exact text. If it has not changed, the system can skip rebuilding that document’s search representation.

## Response Confidence Score

Terms: Confidence Score, Response Confidence

Combines source agreement, search strength, valid format, and numeric consistency. The model’s own confidence is only a small part of the score.

## Held Responses (Review Queue)

Terms: Review Queue, Held Responses

Responses below the release threshold wait here with their source evidence and catch reason. An operator can approve, edit and release, or reject them.

## Human Transfer Package

Terms: Warm Human Handoff, Human Handoff, Transfer to a Human

Preserves the conversation, summary, confidence, and linked review items for a human specialist. This local console records the transfer but does not dispatch an external agent.

## Repeated-Answer Detection

Terms: Stuck-Bot Detection, stuck_bot

Detects repeated answers, repeated tool calls, or several unresolved turns. It prepares the conversation for a human rather than continuing the same loop.

## Independent Answer Review (LLM Judge)

Terms: LLM Judge Rubric, LLM Judge, Independent Answer Review

A separate evaluator checks facts, source support, tone, and whether the question was answered. One failed dimension can fail the whole response.

## Fact Accuracy

Terms: factualAccuracy, Factual Accuracy

Checks that the answer agrees with the available facts. Unsupported numbers or reversed meanings reduce the score.

## Source Support

Terms: citationSupport, Citation Support

Checks whether the cited documents back up the claims. A working link alone is not enough.

## Question Coverage

Terms: questionAnswered, Question Answered

Checks whether the answer directly addresses the customer’s question. Correct but unrelated facts do not count as a complete answer.

## Professional Tone

Terms: tone

Checks whether the response is respectful, direct, and appropriate for customer support.

## Fixed Answer Regression Suite

Terms: Eval Suite, Golden Eval Suite, Golden Evaluation

Replays twenty representative questions through the response pipeline. New answers are compared with required facts and sources to spot regressions.

## Answer Quality Change (Drift)

Terms: Answer Drift, drifted, drift alert

Flags answers or rolling metrics that no longer meet the required standard. Healthy recent results clear metric alerts automatically.

## Recent Quality Trend

Terms: Rolling Window, rolling average, Sparkline

Shows averages over the most recent samples inside the selected time window. The small trend line makes changes over time visible.

## Search Match Strength

Terms: retrieval match, Search Match Strength

Measures how strongly the best retrieved section matches the question. Weak matches lower response confidence and may require review.

## Security Block Rate

Terms: guard block rate, Security Block Rate

The share of requests blocked by security checks. An unusual increase can signal a burst of attacks or an overly strict rule.

## Required Format Success Rate

Terms: schema validation, Required Format Success Rate

The share of responses that contain every required field with valid values. Failures are held rather than released.

## Optional Local Last Resort

Terms: Ollama, qwen2.5, local fallback

Runs a free local model when available, or an explicitly labeled document extractor. It is used only when enabled and all approved cloud links fail.

## Claude Model Tiers

Terms: Haiku, Sonnet, Opus

Haiku is the smaller fast option; Sonnet and Opus handle harder requests. All cloud links in this response chain use Claude.

## Permission-Filtered Vector Store

Terms: Pinecone

Stores document number representations for meaning search. Without a cloud key, this console uses a local store with the same permission filters.

## Deep Relevance Score

Terms: Rerank Score, rerankScore

Measures how directly a document section answers the current question. Higher scores move stronger sections toward the final answer.

## Ranking Balance Setting

Terms: RRF k, k=30

Controls how much a high list position contributes when search rankings are merged. The configured value is thirty.

## Elapsed Time

Terms: latency, ms

The time taken by a step or request. Milliseconds are thousandths of a second.

## Local Claude Connection

Terms: CLI, Command-Line Interface

Runs Claude through the installed command-line app on this computer. Prompt-cache savings here are estimates, not provider-reported billing data.

## Word Search Weight

Terms: BM25 Score, IDF, TF, term frequency

Measures how strongly exact question terms match a section. Uncommon words and repeated relevant terms contribute to the score.

## Source Link Check

Terms: URL Validation, URL Check, URL

Fetches each cited web address and checks that it returns readable content. Missing pages and connection errors fail this check.

## Exact Quoted Words

Terms: Exact Quote, verbatim

Checks that quoted text appears in the fetched source. Letter case and repeated whitespace are ignored, but the words must match.

## Arrow Alignment Total

Terms: Dot Product

Multiplies matching numbers in two text representations and adds them together. It is one part of measuring whether their meanings point in the same direction.

## Arrow Length

Terms: Magnitude, L2 Norm

Measures the size of a number list. Dividing by the arrow lengths lets meaning search compare direction rather than text size.

## Text Meaning Arrow

Terms: Query Vector, Chunk Vector, vector

A text representation shown as an arrow in this view. Arrows pointing in similar directions represent related meanings.

## Word Repetition Weight

Terms: Term Frequency, TF saturation

Counts how often a search word appears in a section. Extra repetitions help less and less so one repeated word cannot dominate.

## Word Rarity Weight

Terms: Inverse Document Frequency, IDF

Gives uncommon words more weight than words found almost everywhere. Specific error codes are especially useful search clues.

## Rank Balance Adjustment

Terms: smoothing

Adds a fixed amount to each list position before calculating its contribution. This prevents the first result in one list from overwhelming the combined ranking.

## Raw Relevance Score

Terms: logit

A model’s raw score before converting it into a probability. It is useful for ordering document sections, not as a percentage confidence.

## Answers Grounded in Documents (RAG)

Terms: RAG, Retrieval-Augmented Generation

Searches approved support documents before writing the answer. The selected passages provide the facts and sources.

## Answer Writing Model

Terms: Large Language Model, LLM

A language model writes a response from the selected evidence and instructions. Other checks verify its output before release.

## Local Deterministic Mode

Terms: mock, simulator, offline

Runs repeatable local behavior without a paid model request. This is clearly labeled and does not represent live provider inference or billing.

## Search Result Position

Terms: RRF Rank, rankDelta, rank

Shows where a section appears in a search result list. A smaller position number means it was placed closer to the top.

## Instruction Override Attempt

Terms: injection probability, prompt injection

An attempt to make the chatbot ignore its rules or follow hidden document commands. The security checks estimate and block this behavior.

## Isolated Input Package

Terms: Data Envelope, fenced payload

Keeps the question, documents, and earlier turns inside boundaries that mark them as untrusted data. Only the system’s instructions are authoritative.

## Product Interface (API)

Terms: API

A defined way for software to request product data or actions. The support documents specify its request limits and errors.

## Automatic Event Notice (Webhook)

Terms: webhook

An automatic message sent to another application when a product event happens. Signature checks verify who sent it.

## Shared-Secret Signature (HMAC)

Terms: HMAC

Uses a shared secret to calculate a signature for a message. Matching signatures help confirm that a webhook was not altered.

## Company Sign-In (SSO)

Terms: SSO, Single Sign-On

Lets people use their company identity to sign in rather than a separate product password.

## Company Sign-In Protocol (SAML)

Terms: SAML

A standard format used to pass sign-in information between a company identity service and an application.

## Company Identity Service (IdP)

Terms: IdP

The service that verifies company users at sign-in. Its signing certificate helps the application trust those results.

## European Privacy Rules (GDPR)

Terms: GDPR

Privacy rules that govern handling personal data. Support policies define the export and deletion steps used here.

## Personal Data Request (DSAR)

Terms: DSAR

A person’s request to access or delete their personal data. The privacy policy specifies the timing and access checks.

## Service Timing Commitment (SLA)

Terms: SLA

A promised response or completion timeframe for a service. The relevant support policy gives the applicable deadline.

## Search Scoring Controls

Terms: BM25 k1, b =, k₁

Settings that limit the effect of repeated words and adjust for section length. They keep keyword rankings balanced.

## Local Model Runtime

Terms: ONNX, Transformers

Runs downloaded model weights on this computer. Security and meaning checks can run locally without sending source text to an outside service.

## Combined Word and Meaning Search

Terms: BM25 + vector, hybrid retriever, hybrid retrieval

Runs exact-word search and meaning search together. Their combined results cover both precise codes and differently worded questions.

## Review Criterion

Terms: rubric, dimension

One independent aspect of answer quality, such as facts, tone, or source support. Each criterion has its own passing score.

## Saved Result Check

Terms: Cache, HIT, MISS

A cache keeps a previous result so the system can reuse it. A hit finds a close-enough saved answer; a miss continues with a fresh search.

## Question Clarity Check

Terms: Query Rewrite, Query Rewriting, Relevance Change

Expands abbreviations and references to earlier turns into a clear search question. Complete questions stay unchanged and use no extra model call.

## Text Prepared for the Model

Terms: Context, Context Assembly

The instructions, evidence, history and question assembled for one model call. It must fit within the model’s text-size limit.

## Fixed Response Rules

Terms: System Instructions

The fixed rules the chatbot follows for safety, source use and answer format. User questions do not override these rules.

## Recent Answer Quality

Terms: Quality Meter

Tracks six recent quality measures, including source support and security blocks. Alerts appear when recent results leave their safe range and clear after recovery.

## Required Match Closeness

Terms: Strictness

How close a question must be to a saved question before its answer is reused. A stricter setting reduces unrelated matches.

## Shared Beginning of a Model Call

Terms: Prefix

The fixed instructions and tool descriptions shared across requests. Keeping this text identical lets the provider reuse eligible cached text.
