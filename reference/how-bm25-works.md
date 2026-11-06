# How BM25 Works

Operational scoring specification of the **BM25** keyword ranking function used in this Support RAG runtime (`src/bm25.ts`: `k₁ = 1.5`, `b = 0.75`).

## What BM25 Stands For

**BM25** means **Best Matching 25**. It is the 25th iteration of the probabilistic retrieval ranking function developed for the **Okapi** information-retrieval system by Stephen Robertson, Karen Spärck Jones, and colleagues. In this runtime BM25 scores every heading-prefixed support chunk against the user query so rare identifiers like `ERR_PAYMENT_402` can outrank vague semantic near-misses before Reciprocal Rank Fusion and the cross-encoder run.

## Step 1 — Term Frequency (tf) & Saturation (k₁ = 1.5)

### Raw term frequency

For a query term `t` and a chunk `d`, **`tf(t, d)`** is simply how many times `t` appears in `d` after tokenization (we preserve tokens like `err_payment_402` and `429`).

### Why we saturate with k₁

If we used raw `tf` alone, a chunk that repeats a word twenty times would score about twenty times higher than a chunk that uses it once — even when the second mention adds almost no new evidence. BM25 therefore uses a **saturating** transform:

```
TF_norm(t, d) = [ tf(t, d) · (k₁ + 1) ] / [ tf(t, d) + k₁ · L(d) ]
```

With the classic default **`k₁ = 1.5`**:

- As `tf → ∞`, `TF_norm` approaches **`k₁ + 1 = 2.5`** (an asymptote).
- Going from `tf = 1` to `tf = 2` still helps, but going from `tf = 10` to `tf = 20` barely moves the needle.

That is **diminishing returns** by design.

## Step 2 — Inverse Document Frequency (IDF)

### The rarity weight

A term that appears in almost every chunk (`the`, `and`) should barely affect ranking. A term that appears in one chunk (`err_payment_402`) should dominate. BM25 uses:

```
IDF(t) = ln( 1 + (N − df(t) + 0.5) / (df(t) + 0.5) )
```

where:

- **`N`** = total number of chunks in the index
- **`df(t)`** = number of chunks that contain term `t`

### Intuition

- If `df(t) ≈ N` (ubiquitous word), the fraction collapses near `0` and **`IDF ≈ ln(1 + ε) ≈ 0`**.
- If `df(t) = 1` (rare technical token), the fraction is large and **`IDF` is high**.

## Step 3 — Document Length Normalization (b = 0.75, |d| / avgdl)

### Length factor L(d)

Long, rambling chunks can accumulate query terms by sheer volume. BM25 penalizes that with:

```
L(d) = 1 − b + b · (|d| / avgdl)
```

where:

- **`|d|`** = token length of chunk `d`
- **`avgdl`** = average chunk length across the corpus
- **`b = 0.75`** (classic Okapi default) blends full length-normalization (`b = 1`) with none (`b = 0`)

### Effect on scoring

- If `|d| > avgdl`, then `L(d) > 1` → the TF denominator grows → score is **penalized**.
- If `|d| < avgdl`, then `L(d) < 1` → concise focused chunks are **rewarded**.

`L(d)` is exactly the factor that appears inside the TF denominator as `k₁ · L(d)`.

## Step 4 — Complete Blended BM25 Formula

Putting the pieces together, the score of chunk `d` for query `Q` is:

```
BM25(Q, d) = ∑_{t ∈ Q}  IDF(t) × [ tf(t, d) · (k₁ + 1) ] / [ tf(t, d) + k₁ · (1 − b + b · (|d| / avgdl)) ]
```

Only query terms with `tf(t, d) > 0` contribute. In this runtime we use **`k₁ = 1.5`** and **`b = 0.75`**, then fuse BM25 ranks with vector ranks via **`RRF(k = 30)`**.

## Step 5 — Full Worked Numerical Example

Assume a tiny corpus snapshot:

| Symbol  | Value     |
| ------- | --------- |
| `N`     | 45 chunks |
| `avgdl` | 50 tokens |
| `       | d         | `   | 42 tokens (slightly shorter than average) |
| `k₁`    | 1.5       |
| `b`     | 0.75      |

Query (after stopword handling for the IDF walkthrough we still show `the` as a contrast term): terms of interest = `err_payment_402`, `declined`, `the`.

### Length factor first

```
L(d) = 1 − 0.75 + 0.75 · (42 / 50)
     = 0.25 + 0.75 · 0.84
     = 0.25 + 0.63
     = 0.88
```

### Per-term arithmetic

#### Term A — rare code `err_payment_402` (`tf = 2`, `df = 1`)

```
IDF = ln(1 + (45 − 1 + 0.5) / (1 + 0.5))
    = ln(1 + 44.5 / 1.5)
    = ln(1 + 29.666…)
    = ln(30.666…)
    ≈ 3.423

denom = tf + k₁ · L(d) = 2 + 1.5 · 0.88 = 2 + 1.32 = 3.32
TF_norm = (tf · (k₁ + 1)) / denom = (2 · 2.5) / 3.32 = 5 / 3.32 ≈ 1.506

termScore = IDF × TF_norm ≈ 3.423 × 1.506 ≈ 5.155
```

#### Term B — domain word `declined` (`tf = 2`, `df = 2`)

```
IDF = ln(1 + (45 − 2 + 0.5) / (2 + 0.5))
    = ln(1 + 43.5 / 2.5)
    = ln(1 + 17.4)
    = ln(18.4)
    ≈ 2.912

TF_norm (same tf & L) ≈ 1.506
termScore ≈ 2.912 × 1.506 ≈ 4.386
```

#### Term C — common word `the` (`tf = 3`, `df = 40`)

```
IDF = ln(1 + (45 − 40 + 0.5) / (40 + 0.5))
    = ln(1 + 5.5 / 40.5)
    = ln(1 + 0.1358)
    = ln(1.1358)
    ≈ 0.127

denom = 3 + 1.5 · 0.88 = 3 + 1.32 = 4.32
TF_norm = (3 · 2.5) / 4.32 = 7.5 / 4.32 ≈ 1.736

termScore ≈ 0.127 × 1.736 ≈ 0.221
```

### Final summed BM25

```
BM25(Q, d) ≈ 5.155 + 4.386 + 0.221 ≈ 9.762
```

Notice how the rare error code contributes the most, the domain word still matters, and the common word barely moves the total — exactly why BM25 shines for support-doc lookups like `ERR_PAYMENT_402`.
