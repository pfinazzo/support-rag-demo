# How Cosine Similarity Works

Operational specification of the **vector cosine similarity** used in this Support RAG runtime (`src/embeddings.ts`) to rank heading-prefixed chunks against a query embedding.

## What Cosine Similarity Measures

Two embedding vectors can point in similar **directions** even when their lengths differ. Cosine similarity measures that directional alignment:

```
cos(θ) = (q · d) / (‖q‖ · ‖d‖)
```

where:

- `q` is the query embedding
- `d` is a chunk embedding
- `q · d` is the dot product
- `‖q‖` and `‖d‖` are Euclidean magnitudes
- `θ` is the angle between the vectors in embedding space

## Range & Meaning

| cos(θ)  | θ (approx) | Meaning in this runtime                                      |
| ------- | ---------- | ------------------------------------------------------------ |
| `1.00`  | `0°`       | Identical direction — same meaning                           |
| `~0.93` | `~21°`     | Strong semantic match (e.g. payment-failure paraphrase)      |
| `0.25`  | `~75.5°`   | **Minimum vector relevance floor** (`MIN_VECTOR_SIMILARITY`) |
| `~0.03` | `~88°`     | Nearly unrelated — gated out                                 |
| `0.00`  | `90°`      | Orthogonal — no directional overlap                          |
| `< 0`   | `> 90°`    | Opposite-ish directions (rare after normalization)           |

## Why We Normalize by Magnitudes

Raw dot product `q · d` grows with vector length. Dividing by `‖q‖ · ‖d‖` cancels length so only **angle** remains. After OpenAI / mock embeddings are L2-normalized, `‖q‖ ≈ ‖d‖ ≈ 1`, so `cos(θ) ≈ q · d`.

## Worked Example

Query text: `"my card payment failed"` → vector `q`.

Matching chunk: `"ERR_PAYMENT_402 billing declined"` → vector `d_match` with `θ ≈ 21°`:

```
cos ≈ 0.93  →  passes the 0.25 gate  →  enters RRF shortlist
```

Unrelated chunk: `"SAML 2.0 certificate rotation"` → `θ ≈ 88°`:

```
cos ≈ 0.03  →  fails the 0.25 gate  →  ignored unless BM25 also hit
```

## How It Fits the Pipeline

1. Embed query with the same model used at index time (`text-embedding-3-small` or mock).
2. Score every chunk with cosine similarity.
3. Rank by descending cosine → feed ranks into **RRF (`k = 30`)** with BM25 ranks.
4. Cross-encoder re-ranks the shortlist; only Top-3 reach the LLM.
