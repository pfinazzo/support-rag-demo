/**
 * Why this file exists: it turns jargon on the page into hover and focus tooltips.
 * The glossary below holds each term's plain-language explanation. The page scans its text for those terms and wraps each match.
 * Without it, a reader meeting words like BM25 or HNSW would have nothing to explain them.
 */
/**
 * The glossary. Each row is one idea.
 * terms: every spelling that should show this tooltip.
 * label: the plain name read aloud by screen readers.
 * explanation: the text shown in the tooltip.
 * A term is matched whole-word, ignoring case, anywhere in the page text.
 * If two rows share a term, the row listed first wins.
 */
export const GLOSSARY = [
  {
    terms: ['Citation Verification', 'Citation Checker', 'Source Fact-Check', 'citation pass rate'],
    label: 'Source Fact-Check (Citation Verification)',
    explanation:
      'Checks every document the chatbot cites after an answer is written. It checks the link, whether the document backs up the claim, and whether quoted words appear exactly.',
  },
  {
    terms: ['DeBERTa NLI', 'nli-deberta', 'entailment', 'contradiction', 'Meaning Match Check'],
    label: 'Meaning Match Check (DeBERTa NLI)',
    explanation:
      'Compares a claim with its source to see if they agree or say the opposite. It catches missing “not” words that reverse the meaning.',
  },
  {
    terms: ['BM25', 'Sparse Keyword Search', 'Exact Word Search'],
    label: 'Exact Word Search (BM25)',
    explanation:
      'Finds sections containing the exact words, error codes, or IDs in the question. Rare terms count more than common words.',
  },
  {
    terms: ['Dense Vector', 'Vector Search', 'embeddings', 'cosine similarity', 'Meaning Search'],
    label: 'Meaning Search (Vector Embeddings)',
    explanation:
      'Converts text into lists of numbers so sections with similar meanings match even when they use different words.',
  },
  {
    terms: ['Reciprocal Rank Fusion', 'RRF', 'Combined Search Ranking'],
    label: 'Combined Search Ranking (RRF)',
    explanation:
      'Merges exact-word and meaning-search results into one balanced list. Sections strong in both rise to the top.',
  },
  {
    terms: ['Cross-Encoder', 'Re-Rank', 'ms-marco-MiniLM', 'reranker'],
    label: 'Deep Relevance Re-Check (Cross-Encoder)',
    explanation:
      'Reads the question and each candidate section together to check how directly it answers the question. Only the strongest sections reach the answer model.',
  },
  {
    terms: ['Semantic Cache', 'HNSW', 'ANN'],
    label: 'Instant Repeat-Answer Cache (HNSW)',
    explanation:
      'Saves prior responses and quickly finds new questions asking the same thing in different words. Reusing an answer avoids another model call.',
  },
  {
    terms: ['Similarity threshold', 'Cache Match Strictness', 'Threshold'],
    label: 'Cache Match Strictness (Threshold)',
    explanation:
      'Sets how closely a question must match a saved question before reusing its answer. Too low a setting can reuse an answer to a different question.',
  },
  {
    terms: ['Prompt Guard'],
    label: 'Request Security Checks (Prompt Guard)',
    explanation:
      'Checks for attempts to override the chatbot’s rules before documents or models are used. Four independent defenses make bypasses harder.',
  },
  {
    terms: ['Known Phrase', 'Naive Phrase', 'Naive Substring', 'literal blocklist'],
    label: 'Known Attack Phrase Check',
    explanation:
      'Looks for known rule-breaking phrases exactly as written. It is fast but does not catch every disguised attack.',
  },
  {
    terms: ['Disguised Characters', 'NFKC', 'Regex + Normalize', 'regex', 'normalization'],
    label: 'Disguised Character Check',
    explanation:
      'Cleans up disguised characters, hidden spaces, and punctuation tricks before checking for rule-breaking commands.',
  },
  {
    terms: ['Security Model', 'Guard LLM Classifier', 'Llama-Prompt-Guard', 'Guard Classifier'],
    label: 'Security Model Check',
    explanation:
      'A dedicated security model spots subtle attempts to trick the chatbot even when no banned phrase appears.',
  },
  {
    terms: [
      'Untrusted Text Boundary',
      'Data Separation Fence',
      'Data-Side Nonce',
      'nonce',
      'Data Separation',
      'Indirect Injection',
    ],
    label: 'Untrusted Text Isolation',
    explanation:
      'Wraps user text and retrieved documents in unique boundary tags. Hidden instructions inside those documents stay data rather than commands.',
  },
  {
    terms: ['Role-Based Access Control', 'RBAC', 'Access Permissions'],
    label: 'Access Permissions (RBAC)',
    explanation:
      'Filters documents before their results are used. Each caller sees only information allowed for their team role.',
  },
  {
    terms: ['Shared Instructions Cache', 'Prompt Cache', 'cache_control', 'ephemeral'],
    label: 'Shared Instructions Cache (Prompt Cache)',
    explanation:
      'Keeps fixed instructions and tool definitions warm on Claude’s servers for five minutes. Actual saved tokens are reported separately from local estimates.',
  },
  {
    terms: ['Compaction', 'Context Compaction', 'Chat History Trimming'],
    label: 'Chat History Trimming (Compaction)',
    explanation:
      'Replaces older conversation turns with a short summary while keeping recent details. This leaves room for the current question and source documents.',
  },
  {
    terms: ['Turn Size Growth Rate', 'Token-Per-Turn', 'growth_rate'],
    label: 'Turn Size Growth Rate',
    explanation:
      'Measures the average tokens added by recent turns. Fast-growing conversations are summarized early instead of waiting until the model runs out of room.',
  },
  {
    terms: ['tokens', 'token count'],
    label: 'Text Size Units (Tokens)',
    explanation:
      'Tokens are the small pieces of text a model reads or writes, roughly three quarters of a word each. Counts shown by this console are conservative estimates unless reported by the provider.',
  },
  {
    terms: ['Hard Window', 'hard_window_cap', 'ContextWindowExceededError'],
    label: 'Model Size Limit',
    explanation:
      'The model can read only a limited amount of text in one call. If required content still cannot fit after trimming, the call is stopped before sending.',
  },
  {
    terms: ['Model Router', 'Router', 'Model Selection'],
    label: 'Model Selection (Router)',
    explanation:
      'Chooses a smaller, cheaper model for simple questions and a larger one for difficult work. It shows the signals behind every choice.',
  },
  {
    terms: ['Proxy Signals', 'decision signals'],
    label: 'Difficulty Clues',
    explanation:
      'Uses observable clues such as question length, wording, tool needs, and past answer quality. These estimate difficulty without an extra model call.',
  },
  {
    terms: ['Linguistic Tells', 'linguistic tells'],
    label: 'Complexity Wording',
    explanation:
      'Words such as “compare,” “analyze,” and “why” suggest that a question needs deeper reasoning.',
  },
  {
    terms: ['historical quality', 'historical_quality'],
    label: 'Past Model Results',
    explanation:
      'Uses scores from similar earlier questions to help choose a model. Runtime scores are recorded alongside the initial reference results.',
  },
  {
    terms: ['Fallback Chain', 'Backup Models'],
    label: 'Backup Model Sequence (Fallback Chain)',
    explanation:
      'If the selected model fails, the system tries the next approved model in order. It stops at the first success and records which models failed.',
  },
  {
    terms: ['HTTP 503', 'http_503'],
    label: 'Service Temporarily Unavailable (503)',
    explanation:
      'The model service could not handle the call right now. The next backup model is tried.',
  },
  {
    terms: ['429', 'rate limit'],
    label: 'Too Many Requests (429)',
    explanation:
      'The provider is limiting traffic for this account. The backup chain tries another permitted model.',
  },
  {
    terms: ['timeout', 'TTFT', 'Time to First Token'],
    label: 'Response Timing',
    explanation:
      'A timeout stops a call that takes too long. TTFT measures how long it takes for the first piece of answer text to arrive.',
  },
  {
    terms: ['SSE', 'Live Token Stream', 'Streaming'],
    label: 'Live Answer Stream (SSE)',
    explanation:
      'The server sends answer fragments as they arrive, instead of waiting for the entire response. The visible draft stays provisional until validation finishes.',
  },
  {
    terms: ['Structured Output', 'JSON Schema', 'Required Response Format'],
    label: 'Required Response Format (JSON Schema)',
    explanation:
      'Every answer must contain required fields such as answer, sources, and confidence. Missing or invalid fields are rejected before release.',
  },
  {
    terms: ['Agent Loop', 'Tool iteration', 'Max Iterations'],
    label: 'Bounded Tool Workflow (Agent Loop)',
    explanation:
      'The model can call a tool, read its result, and choose another step or a final answer. A five-call limit prevents endless loops.',
  },
  {
    terms: ['Search Agent', 'Follow-up Search'],
    label: 'Follow-up Search (Search Agent)',
    explanation:
      'Searches, reads snippets, and refines the query when important parts remain unanswered. It stops when evidence is sufficient or after four passes.',
  },
  {
    terms: ['Tools', 'Tool Definitions', 'toolsInvoked', 'Tool Steps'],
    label: 'Available Support Actions',
    explanation:
      'Defines the actions the model may request: document search, ticket lookup, and local escalation. Each action has required inputs and checked results.',
  },
  {
    terms: ['Context Header', 'Chunk Context', 'Document Context'],
    label: 'Document Context Header',
    explanation:
      'Adds a short description of the parent document and section before search indexing. A small section stays understandable on its own.',
  },
  {
    terms: ['chunk', 'snippet'],
    label: 'Document Section (Chunk)',
    explanation:
      'A small section of a larger support document. Search returns these sections rather than sending every document to the model.',
  },
  {
    terms: ['Re-Indexer', 'Mixed-Source Re-Indexing', 'Re-Indexing', 'Changed-Document Refresh'],
    label: 'Changed-Document Refresh',
    explanation:
      'Keeps search results in sync with file and database documents. Only sections whose text changed need new search representations.',
  },
  {
    terms: ['SQLite Write Trigger', 'SQLite', 'write-hook'],
    label: 'Database Change Hook (SQLite Trigger)',
    explanation:
      'A database rule records inserted, changed, or deleted documents automatically. The refresh worker processes those recorded changes.',
  },
  {
    terms: ['SHA-256', 'contentHash', 'Content Hash', 'Prefix Hash'],
    label: 'Text Fingerprint (SHA-256)',
    explanation:
      'A digital fingerprint identifies exact text. If it has not changed, the system can skip rebuilding that document’s search representation.',
  },
  {
    terms: ['Confidence Score', 'Response Confidence'],
    label: 'Response Confidence Score',
    explanation:
      'Combines source agreement, search strength, valid format, and numeric consistency. The model’s own confidence is only a small part of the score.',
  },
  {
    terms: ['Review Queue', 'Held Responses'],
    label: 'Held Responses (Review Queue)',
    explanation:
      'Responses below the release threshold wait here with their source evidence and catch reason. An operator can approve, edit and release, or reject them.',
  },
  {
    terms: ['Warm Human Handoff', 'Human Handoff', 'Transfer to a Human'],
    label: 'Human Transfer Package',
    explanation:
      'Preserves the conversation, summary, confidence, and linked review items for a human specialist. This local console records the transfer but does not dispatch an external agent.',
  },
  {
    terms: ['Stuck-Bot Detection', 'stuck_bot'],
    label: 'Repeated-Answer Detection',
    explanation:
      'Detects repeated answers, repeated tool calls, or several unresolved turns. It prepares the conversation for a human rather than continuing the same loop.',
  },
  {
    terms: ['LLM Judge Rubric', 'LLM Judge', 'Independent Answer Review'],
    label: 'Independent Answer Review (LLM Judge)',
    explanation:
      'A separate evaluator checks facts, source support, tone, and whether the question was answered. One failed dimension can fail the whole response.',
  },
  {
    terms: ['factualAccuracy', 'Factual Accuracy'],
    label: 'Fact Accuracy',
    explanation:
      'Checks that the answer agrees with the available facts. Unsupported numbers or reversed meanings reduce the score.',
  },
  {
    terms: ['citationSupport', 'Citation Support'],
    label: 'Source Support',
    explanation:
      'Checks whether the cited documents back up the claims. A working link alone is not enough.',
  },
  {
    terms: ['questionAnswered', 'Question Answered'],
    label: 'Question Coverage',
    explanation:
      'Checks whether the answer directly addresses the customer’s question. Correct but unrelated facts do not count as a complete answer.',
  },
  {
    terms: ['tone'],
    label: 'Professional Tone',
    explanation:
      'Checks whether the response is respectful, direct, and appropriate for customer support.',
  },
  {
    terms: ['Eval Suite', 'Golden Eval Suite', 'Golden Evaluation'],
    label: 'Fixed Answer Regression Suite',
    explanation:
      'Replays twenty representative questions through the response pipeline. New answers are compared with required facts and sources to spot regressions.',
  },
  {
    terms: ['Answer Drift', 'drifted', 'drift alert'],
    label: 'Answer Quality Change (Drift)',
    explanation:
      'Flags answers or rolling metrics that no longer meet the required standard. Healthy recent results clear metric alerts automatically.',
  },
  {
    terms: ['Rolling Window', 'rolling average', 'Sparkline'],
    label: 'Recent Quality Trend',
    explanation:
      'Shows averages over the most recent samples inside the selected time window. The small trend line makes changes over time visible.',
  },
  {
    terms: ['retrieval match', 'Search Match Strength'],
    label: 'Search Match Strength',
    explanation:
      'Measures how strongly the best retrieved section matches the question. Weak matches lower response confidence and may require review.',
  },
  {
    terms: ['guard block rate', 'Security Block Rate'],
    label: 'Security Block Rate',
    explanation:
      'The share of requests blocked by security checks. An unusual increase can signal a burst of attacks or an overly strict rule.',
  },
  {
    terms: ['schema validation', 'Required Format Success Rate'],
    label: 'Required Format Success Rate',
    explanation:
      'The share of responses that contain every required field with valid values. Failures are held rather than released.',
  },
  {
    terms: ['Ollama', 'qwen2.5', 'local fallback'],
    label: 'Optional Local Last Resort',
    explanation:
      'Runs a free local model when available, or an explicitly labeled document extractor. It is used only when enabled and all approved cloud links fail.',
  },
  {
    terms: ['Haiku', 'Sonnet', 'Opus'],
    label: 'Claude Model Tiers',
    explanation:
      'Haiku is the smaller fast option; Sonnet and Opus handle harder requests. All cloud links in this response chain use Claude.',
  },
  {
    terms: ['Pinecone'],
    label: 'Permission-Filtered Vector Store',
    explanation:
      'Stores document number representations for meaning search. Without a cloud key, this console uses a local store with the same permission filters.',
  },
  {
    terms: ['Rerank Score', 'rerankScore'],
    label: 'Deep Relevance Score',
    explanation:
      'Measures how directly a document section answers the current question. Higher scores move stronger sections toward the final answer.',
  },
  {
    terms: ['RRF k', 'k=30'],
    label: 'Ranking Balance Setting',
    explanation:
      'Controls how much a high list position contributes when search rankings are merged. The configured value is thirty.',
  },
  {
    terms: ['latency', 'ms'],
    label: 'Elapsed Time',
    explanation: 'The time taken by a step or request. Milliseconds are thousandths of a second.',
  },
  {
    terms: ['CLI', 'Command-Line Interface'],
    label: 'Local Claude Connection',
    explanation:
      'Runs Claude through the installed command-line app on this computer. Prompt-cache savings here are estimates, not provider-reported billing data.',
  },
  {
    terms: ['BM25 Score', 'IDF', 'TF', 'term frequency'],
    label: 'Word Search Weight',
    explanation:
      'Measures how strongly exact question terms match a section. Uncommon words and repeated relevant terms contribute to the score.',
  },
  {
    terms: ['URL Validation', 'URL Check', 'URL'],
    label: 'Source Link Check',
    explanation:
      'Fetches each cited web address and checks that it returns readable content. Missing pages and connection errors fail this check.',
  },
  {
    terms: ['Exact Quote', 'verbatim'],
    label: 'Exact Quoted Words',
    explanation:
      'Checks that quoted text appears in the fetched source. Letter case and repeated whitespace are ignored, but the words must match.',
  },
  {
    terms: ['Dot Product'],
    label: 'Arrow Alignment Total',
    explanation:
      'Multiplies matching numbers in two text representations and adds them together. It is one part of measuring whether their meanings point in the same direction.',
  },
  {
    terms: ['Magnitude', 'L2 Norm'],
    label: 'Arrow Length',
    explanation:
      'Measures the size of a number list. Dividing by the arrow lengths lets meaning search compare direction rather than text size.',
  },
  {
    terms: ['Query Vector', 'Chunk Vector', 'vector'],
    label: 'Text Meaning Arrow',
    explanation:
      'A text representation shown as an arrow in this view. Arrows pointing in similar directions represent related meanings.',
  },
  {
    terms: ['Term Frequency', 'TF saturation'],
    label: 'Word Repetition Weight',
    explanation:
      'Counts how often a search word appears in a section. Extra repetitions help less and less so one repeated word cannot dominate.',
  },
  {
    terms: ['Inverse Document Frequency', 'IDF'],
    label: 'Word Rarity Weight',
    explanation:
      'Gives uncommon words more weight than words found almost everywhere. Specific error codes are especially useful search clues.',
  },
  {
    terms: ['smoothing'],
    label: 'Rank Balance Adjustment',
    explanation:
      'Adds a fixed amount to each list position before calculating its contribution. This prevents the first result in one list from overwhelming the combined ranking.',
  },
  {
    terms: ['logit'],
    label: 'Raw Relevance Score',
    explanation:
      'A model’s raw score before converting it into a probability. It is useful for ordering document sections, not as a percentage confidence.',
  },
  {
    terms: ['RAG', 'Retrieval-Augmented Generation'],
    label: 'Answers Grounded in Documents (RAG)',
    explanation:
      'Searches approved support documents before writing the answer. The selected passages provide the facts and sources.',
  },
  {
    terms: ['Large Language Model', 'LLM'],
    label: 'Answer Writing Model',
    explanation:
      'A language model writes a response from the selected evidence and instructions. Other checks verify its output before release.',
  },
  {
    terms: ['mock', 'simulator', 'offline'],
    label: 'Local Deterministic Mode',
    explanation:
      'Runs repeatable local behavior without a paid model request. This is clearly labeled and does not represent live provider inference or billing.',
  },
  {
    terms: ['RRF Rank', 'rankDelta', 'rank'],
    label: 'Search Result Position',
    explanation:
      'Shows where a section appears in a search result list. A smaller position number means it was placed closer to the top.',
  },
  {
    terms: ['injection probability', 'prompt injection'],
    label: 'Instruction Override Attempt',
    explanation:
      'An attempt to make the chatbot ignore its rules or follow hidden document commands. The security checks estimate and block this behavior.',
  },
  {
    terms: ['Data Envelope', 'fenced payload'],
    label: 'Isolated Input Package',
    explanation:
      'Keeps the question, documents, and earlier turns inside boundaries that mark them as untrusted data. Only the system’s instructions are authoritative.',
  },
  {
    terms: ['API'],
    label: 'Product Interface (API)',
    explanation:
      'A defined way for software to request product data or actions. The support documents specify its request limits and errors.',
  },
  {
    terms: ['webhook'],
    label: 'Automatic Event Notice (Webhook)',
    explanation:
      'An automatic message sent to another application when a product event happens. Signature checks verify who sent it.',
  },
  {
    terms: ['HMAC'],
    label: 'Shared-Secret Signature (HMAC)',
    explanation:
      'Uses a shared secret to calculate a signature for a message. Matching signatures help confirm that a webhook was not altered.',
  },
  {
    terms: ['SSO', 'Single Sign-On'],
    label: 'Company Sign-In (SSO)',
    explanation:
      'Lets people use their company identity to sign in rather than a separate product password.',
  },
  {
    terms: ['SAML'],
    label: 'Company Sign-In Protocol (SAML)',
    explanation:
      'A standard format used to pass sign-in information between a company identity service and an application.',
  },
  {
    terms: ['IdP'],
    label: 'Company Identity Service (IdP)',
    explanation:
      'The service that verifies company users at sign-in. Its signing certificate helps the application trust those results.',
  },
  {
    terms: ['GDPR'],
    label: 'European Privacy Rules (GDPR)',
    explanation:
      'Privacy rules that govern handling personal data. Support policies define the export and deletion steps used here.',
  },
  {
    terms: ['DSAR'],
    label: 'Personal Data Request (DSAR)',
    explanation:
      'A person’s request to access or delete their personal data. The privacy policy specifies the timing and access checks.',
  },
  {
    terms: ['SLA'],
    label: 'Service Timing Commitment (SLA)',
    explanation:
      'A promised response or completion timeframe for a service. The relevant support policy gives the applicable deadline.',
  },
  {
    terms: ['BM25 k1', 'b =', 'k₁'],
    label: 'Search Scoring Controls',
    explanation:
      'Settings that limit the effect of repeated words and adjust for section length. They keep keyword rankings balanced.',
  },
  {
    terms: ['ONNX', 'Transformers'],
    label: 'Local Model Runtime',
    explanation:
      'Runs downloaded model weights on this computer. Security and meaning checks can run locally without sending source text to an outside service.',
  },
  {
    terms: ['BM25 + vector', 'hybrid retriever', 'hybrid retrieval'],
    label: 'Combined Word and Meaning Search',
    explanation:
      'Runs exact-word search and meaning search together. Their combined results cover both precise codes and differently worded questions.',
  },
  {
    terms: ['rubric', 'dimension'],
    label: 'Review Criterion',
    explanation:
      'One independent aspect of answer quality, such as facts, tone, or source support. Each criterion has its own passing score.',
  },
  {
    terms: ['Cache', 'HIT', 'MISS'],
    label: 'Saved Result Check',
    explanation:
      'A cache keeps a previous result so the system can reuse it. A hit finds a close-enough saved answer; a miss continues with a fresh search.',
  },
  {
    terms: ['Query Rewrite', 'Query Rewriting', 'Relevance Change'],
    label: 'Question Clarity Check',
    explanation:
      'Expands abbreviations and references to earlier turns into a clear search question. Complete questions stay unchanged and use no extra model call.',
  },
  {
    terms: ['Context', 'Context Assembly'],
    label: 'Text Prepared for the Model',
    explanation:
      'The instructions, evidence, history and question assembled for one model call. It must fit within the model’s text-size limit.',
  },
  {
    terms: ['System Instructions'],
    label: 'Fixed Response Rules',
    explanation:
      'The fixed rules the chatbot follows for safety, source use and answer format. User questions do not override these rules.',
  },
  {
    terms: ['Quality Meter'],
    label: 'Recent Answer Quality',
    explanation:
      'Tracks six recent quality measures, including source support and security blocks. Alerts appear when recent results leave their safe range and clear after recovery.',
  },
  {
    terms: ['Strictness'],
    label: 'Required Match Closeness',
    explanation:
      'How close a question must be to a saved question before its answer is reused. A stricter setting reduces unrelated matches.',
  },
  {
    terms: ['Prefix'],
    label: 'Shared Beginning of a Model Call',
    explanation:
      'The fixed instructions and tool descriptions shared across requests. Keeping this text identical lets the provider reuse eligible cached text.',
  },
] as const;

/**
 * Turns glossary terms on the whole page into tooltip targets, now and as the page changes.
 * Side effects: adds one tooltip element to the body, wraps matching text in spans, and listens to pointer, focus, key, scroll and DOM change events.
 * Call it once per page. A second call would add a second tooltip and a second set of listeners.
 */
export function installGlossary() {
  const portal = document.createElement('div');
  portal.id = 'glossary-tooltip';
  portal.role = 'tooltip';
  portal.setAttribute('popover', 'manual');
  portal.hidden = true;
  document.body.append(portal);
  /** The element the tooltip is currently showing for, or null when it is hidden. */
  let owner: HTMLElement | null = null;
  /**
   * Hides the tooltip and clears the link to its owner.
   * The popover calls can throw if the popover is not in that state, so the errors are ignored.
   * Without this, a tooltip would stay on screen after the reader moves away.
   */
  const hide = () => {
    if (typeof portal.hidePopover === 'function') {
      try {
        portal.hidePopover();
      } catch {}
    }
    portal.hidden = true;
    owner?.removeAttribute('aria-describedby');
    owner = null;
  };
  /**
   * Fills the tooltip from the target's data-tooltip text and places it near the target.
   * Normally: it sits 10 pixels below the target.
   * If it would run off the bottom of the window: it sits above the target instead.
   * It is at most 360 pixels wide and stays 12 pixels from the left and right edges.
   * Without this, long tooltips would be cut off at the window edge.
   */
  const show = (target: HTMLElement) => {
    owner = target;
    portal.textContent = target.dataset.tooltip || '';
    target.setAttribute('aria-describedby', portal.id);
    portal.hidden = false;
    if (typeof portal.showPopover === 'function') {
      try {
        portal.showPopover();
      } catch {}
    }
    const r = target.getBoundingClientRect(),
      width = Math.min(360, innerWidth - 24);
    portal.style.width = width + 'px';
    portal.style.left = Math.max(12, Math.min(innerWidth - width - 12, r.left)) + 'px';
    const height = portal.getBoundingClientRect().height;
    portal.style.top =
      (r.bottom + 10 + height < innerHeight ? r.bottom + 10 : Math.max(8, r.top - height - 10)) +
      'px';
  };
  /** When the mouse enters a tooltip target, show its tooltip. */
  document.addEventListener('pointerover', (e) => {
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tooltip]') : null;
    if (t) show(t);
  });
  /** When the mouse leaves a target for somewhere that is not another target, hide the tooltip. */
  document.addEventListener('pointerout', (e) => {
    if (!(e.relatedTarget as Element | null)?.closest?.('[data-tooltip]')) hide();
  });
  /**
   * When the keyboard focuses a tooltip target, show its tooltip. Keyboard users get the same help as mouse users.
   */
  document.addEventListener('focusin', (e) => {
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tooltip]') : null;
    if (t) show(t);
  });
  /** When focus leaves a target, hide the tooltip. */
  document.addEventListener('focusout', hide);
  /** Pressing Escape hides the tooltip. */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
  /**
   * Any scroll hides the tooltip. Scrolling would otherwise leave it floating away from its target.
   * The true flag catches scrolls inside inner panels as well.
   */
  addEventListener('scroll', hide, true);
  /**
   * One row per term, longest term first.
   * The regex picks the first alternative that matches, so longer terms must come first.
   * Otherwise BM25 would win over BM25 Score and hide the longer match.
   */
  const entries = GLOSSARY.flatMap((g) =>
    g.terms.map((term) => ({ term, label: g.label, explanation: g.explanation })),
  ).sort((a, b) => b.term.length - a.term.length);
  /**
   * Escapes characters that mean something in a regex, so a term like k=30 or b = is matched as plain text.
   */
  const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /**
   * One regex that finds any glossary term.
   * It matches whole words only: no letter, digit or underscore may touch either end.
   * The i flag ignores case. The u flag lets the letter and digit classes work on all scripts.
   * It has the g flag, so it keeps a position that must be reset before each new test.
   */
  const pattern = new RegExp(
    '(?<![\\p{L}\\p{N}_])(' +
      entries.map((e) => escapeRx(e.term)).join('|') +
      ')(?![\\p{L}\\p{N}_])',
    'giu',
  );
  /**
   * Wraps every glossary term found in the text under root in a focusable tooltip span.
   * If root sits inside code, a form field or the tooltip itself: does nothing.
   * Text already inside a tooltip target is left alone, so a term is never wrapped twice.
   * It collects the text nodes first and edits them afterwards, because editing while walking would confuse the walker.
   */
  function enhance(root: Node) {
    if (
      root instanceof Element &&
      root.closest('script,style,pre,code,textarea,input,[data-jargon],#glossary-tooltip')
    )
      return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      if (
        !node.parentElement ||
        node.parentElement.closest(
          'script,style,pre,code,textarea,input,[data-tooltip],#glossary-tooltip',
        )
      )
        continue;
      const text = node.textContent || '';
      /** Resets the regex position. A global regex remembers where its last match ended. */
      pattern.lastIndex = 0;
      if (!pattern.test(text)) continue;
      pattern.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let end = 0;
      for (const m of text.matchAll(pattern)) {
        const before = m.index!;
        frag.append(text.slice(end, before));
        const entry = entries.find((e) => e.term.toLowerCase() === m[0].toLowerCase())!;
        const span = document.createElement('span');
        span.dataset.jargon = 'true';
        span.dataset.tooltip = entry.explanation;
        span.tabIndex = 0;
        span.className = 'jargon-term';
        span.textContent = m[0];
        span.setAttribute('aria-label', entry.label);
        frag.append(span);
        end = before + m[0].length;
      }
      frag.append(text.slice(end));
      node.replaceWith(frag);
    }
  }
  /** Wraps the terms already on the page when this runs. */
  enhance(document.body);
  /** True while a wrap pass is already queued for the next frame. */
  let scheduled = false;
  /**
   * Watches for new page content and wraps its terms.
   * If the tooltip's owner was removed from the page: hides the tooltip, so it does not float with no target.
   * Many changes in one frame cause one pass.
   * The observer is switched off during the pass, so the spans it adds do not trigger another pass.
   */
  const observer = new MutationObserver(() => {
    if (owner && !owner.isConnected) hide();
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      observer.disconnect();
      enhance(document.body);
      observer.observe(document.body, { childList: true, subtree: true });
      scheduled = false;
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
