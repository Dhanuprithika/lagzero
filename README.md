# LagZero

> AI assistance that doesn't wait for the internet.

LagZero is a local-first AI browser assistant designed to make supported browsing and information-retrieval workflows more resilient to slow, unstable, or unavailable internet connections.

Instead of sending every request and full webpage content to remote cloud AI services, LagZero's intended approach is to reuse locally stored webpage content, search locally available information first, and coordinate between local or cloud AI according to availability and usefulness.

---

## Intended Benefits & Scope

- **Reuse Local Web Content:** Reuse previously captured webpage content instead of repeatedly fetching it over the network when a valid local copy is available.
- **Fast Local Retrieval:** Search and retrieve relevant passages from locally stored information first.
- **Offline Assistance:** Provide offline assistance over previously stored content when the required local runtime and model assets are available.
- **Selective Cloud AI:** Leverage cloud AI when appropriate and connectivity is available, sending only the question and necessary excerpts.
- **Reduced Network Traffic:** Reduce unnecessary network requests and data transfer for supported workflows.

### Technical Honesty & Limitations
- LagZero **cannot** increase your physical ISP bandwidth, bypass upstream network outages, or universally accelerate every website.
- Offline and local-first capabilities depend strictly on previously captured content and the required local runtime components being present.
- Features not marked as completed are planned roadmap items undergoing active, iterative development.

---

## Problem Statement

Unstable, slow, or intermittent internet connectivity frequently interrupts browsing and knowledge-retrieval workflows. Standard browser tools and cloud-only AI assistants fail completely when disconnected and introduce high latency on sluggish connections by repeatedly refetching full remote pages.

LagZero aims to reduce avoidable network dependence by making previously captured webpage information reusable and progressively adding local retrieval and AI assistance.

---

## Product Principles

1. **Local content first:** Prioritize locally captured data and storage before touching the network.
2. **Reuse before refetching:** Check for valid local content before initiating network requests, with sensible freshness policies.
3. **Local AI when practical:** Run inference on-device when resources, model assets, and runtime conditions permit.
4. **Cloud AI when useful:** Use cloud models when connectivity is available and complex reasoning or broader knowledge is beneficial.
5. **Graceful degradation:** Provide clear feedback and useful offline fallbacks during network failure rather than throwing blank error screens.
6. **Privacy-conscious data handling:** Keep webpage content and credentials local; send only minimal, explicit context when cloud fallback is engaged.
7. **Measured performance:** Base claims on empirical latency, cache hit rates, and avoided bytes rather than promising universal speedups.

---

## Architecture Overview

```
Webpage (Active Tab)
       │
       ▼ [Phase 1: Planned]
Content Extraction (Readability.js) & Cleaning
       │
       ▼ [Phase 1: Planned]
Heading-Aware Chunking & Metadata Tagging
       │
       ▼ [Phase 1: Planned]
Local Storage & Indexing (IndexedDB)
       │
       ├──────────────────────────────┐
       ▼ [Phase 1: Planned]           ▼ [Phase 2: Planned]
Keyword Search (Passage Matches)    Local Semantic Embeddings
                                      │
                                      ▼ [Phase 2: Planned]
                               Adaptive Router (Local / Cloud)
                                      │
                     ┌────────────────┴────────────────┐
                     ▼                                 ▼
              Local On-Device AI                  Cloud AI Fallback
               (WebLLM / WebGPU)                 (Minimal Excerpt RAG)
```

---

## Current Technology Stack

### Confirmed & Implemented
- **Chrome Extension Manifest V3:** Modern Chrome extension platform configuration.
- **Chrome Side Panel API:** Native sidebar integration via `chrome.sidePanel`.
- **Background Service Worker:** Service worker (`src/background.ts`) managing extension lifecycle, side panel behaviors, and message routing.
- **Content Script:** Content script (`src/content.ts`) with Mozilla Readability (`@mozilla/readability`) for clean article extraction.
- **Typed Messaging Contract:** Discriminated union message protocol (`src/types/messaging.ts`) supporting reachability (`PING`), tab querying (`GET_ACTIVE_TAB`), metadata (`GET_PAGE_INFO`), and content extraction (`EXTRACT_PAGE_CONTENT`).
- **Webpage Content Extraction:** Mozilla Readability (`@mozilla/readability`) parser executed safely on cloned document nodes.
- **Paragraph-Aware Chunking:** Deterministic text chunking engine (`src/utils/chunkContent.ts`) with soft ~1,000 char target and hard 1,500 char max, preserving heading contexts and reading order.
- **Local IndexedDB Persistence:** Native IndexedDB storage layer (`src/utils/storage.ts`) storing normalized documents and sequential chunks with atomic transactional updates, stale chunk purges, individual deletion, and full cache clear.
- **Local Keyword Search Engine:** Client-side lexical ranking engine (`src/utils/search.ts`) with normalized multi-term query tokenization, exact-phrase scoring, title boosting, passage frequency weighting, deterministic tie-breaking, and safe text highlighting.
- **Frontend Framework:** React 19 + TypeScript.
- **Build Tool:** Vite 8 configured for multi-entry extension packaging (`base: './'`).
- **Styling:** Custom dark developer theme adhering to strict palette (`#0D0D0D`, `#2563EB`, `#FFFFFF`).

### Planned Stack (In Progress / Future Phases)
- **Local Embeddings & Vector Search:** In-browser embeddings / vector indexing *(Phase 2, planned)*
- **Local Inference:** WebGPU / WebLLM *(Phase 2, planned)*
- **Cloud Fallback:** External LLM provider with privacy boundaries *(Phase 2, planned)*

---

## Project Status & Roadmap

### Phase 1 — Local Content Foundation
*Goal: Establish Chrome extension infrastructure, robust webpage content extraction, IndexedDB caching, and local keyword search.*

| Milestone | Description | Status |
| :--- | :--- | :--- |
| **Milestone 1** | **Chrome Extension Setup:** MV3 manifest, side panel integration, Vite build, React+TS scaffold, dark UI | **Completed** (Verified in Chrome) |
| **Milestone 2** | **Extension Communication:** Typed message passing between sidebar, background worker, and active tab content script | **Completed** (Implemented and manually verified in Chrome) |
| **Milestone 3** | **Content Extraction:** Extract clean readability text, title, URL, and timestamp via Mozilla Readability | **Completed** (Verified in Chrome) |
| **Milestone 4** | **Chunking & Metadata:** Heading-aware content segmentation with source tracking | **Completed** (Verified in Chrome) |
| **Milestone 5** | **IndexedDB Storage:** Persistent page and chunk cache with freshness policy & purge controls | **Completed** (Verified in Chrome) |
| **Milestone 6** | **Local Keyword Search:** Fast client-side lexical search over stored passages | **Implemented** (Build/lint/tests verified; manual Chrome verification pending) |
| **Milestone 7** | **Phase 1 Validation:** End-to-end extraction, storage, and offline search verification | Pending |

### Phase 2 — Local RAG + AI (Planned)
*Goal: Integrate local embeddings, on-device semantic search, local LLM inference, and single-provider cloud fallback.*
- Improved caching and freshness invalidation.
- Network state monitoring and graceful failure detection.
- Local embeddings and vector similarity search across extracted chunks.
- Local AI model integration (e.g., WebGPU/WebLLM) for summaries and Q&A over cached pages.
- Cloud AI provider integration as an online fallback (sending only question + minimal context).
- Heuristic-based routing between local and cloud models.
- Verification under online, throttled, and disconnected states.

### Phase 3 — Adaptive LagZero (Planned)
*Goal: Deliver full adaptive routing, user control modes, rigorous performance benchmarks, and production polish.*
- User selectable operating modes: *Local-Only*, *Cloud-Only*, and *Adaptive*.
- Dynamic routing factoring in device capabilities, battery, network latency, and model availability.
- Cache management, storage quota policies, and selective invalidation.
- Comprehensive benchmarking: cache-hit latency, avoided requests, answer accuracy, and local vs. cloud response times.
- Security and privacy auditing (credential scrubbing, API key encryption).

---

## IndexedDB Storage Architecture (Milestone 5)

LagZero uses browser-native **IndexedDB** (`lagzero_local_db`, schema version 1) to persistently store extracted documents and chunks directly on the user's machine without any backend, cloud database, or remote network calls.

### Schema & Object Stores

1. **`documents` Object Store:**
   - **Primary Key:** `id` (normalized URL string).
   - **Indexes:**
     - `by_updatedAt`: For sorting documents by most recent update.
     - `by_sourceUrl`: For looking up documents by original URL.
   - **Stored Fields:**
     - `id`: Normalized canonical URL.
     - `title`: Extracted page title.
     - `sourceUrl`: Original webpage URL before normalization.
     - `extractedText`: Complete cleaned text from Mozilla Readability.
     - `excerpt`, `byline`, `siteName`, `publishedTime`: Metadata from extraction.
     - `extractedAt`: Extraction timestamp.
     - `cachedAt`: Initial cache creation timestamp.
     - `updatedAt`: Last update timestamp.
     - `totalChunks`: Total stored chunk count.
     - `totalCharacters`: Total stored character count.
     - `schemaVersion`: Version tracker (currently `1`).

2. **`chunks` Object Store:**
   - **Primary Key:** `id` (composite key: `${documentId}::${chunkIndex}`).
   - **Indexes:**
     - `by_documentId`: For atomic batch lookups and bulk deletions by parent document.
     - `by_doc_chunk_order`: Compound index `[documentId, chunkIndex]` for reading-order retrieval.
   - **Stored Fields:**
     - `id`: Unique composite chunk identifier.
     - `documentId`: Foreign key reference to parent `CachedDocument.id`.
     - `chunkIndex`: Zero-based sequential chunk index.
     - `text`: Chunk text content.
     - `characterCount`: Number of characters in the chunk.
     - `headingContext`: Current section/heading context when available.
     - `documentTitle`: Document title.
     - `sourceUrl`: Source URL.
     - `extractedAt`: Extraction timestamp.

### URL Normalization Policy
- **Fragments (`#section`)**: Stripped because intra-page anchors refer to the same document.
- **Host / Protocol**: Lowercased and default ports (`:80`, `:443`) removed.
- **Trailing Slashes**: Stripped for path consistency.
- **Query Parameters**: **Preserved**, because query parameters (e.g., `?id=123`, `?v=...`) frequently differentiate genuinely distinct documents or articles.

### Atomic Consistency & Stale Chunk Removal
When saving or updating a document:
- An atomic `readwrite` transaction opens over both `documents` and `chunks` stores.
- All existing chunks for the target document are deleted via a cursor over `by_documentId` before writing new chunks.
- If re-saving a document produces fewer chunks than before, no orphaned or stale chunks remain.
- If any write fails, the entire transaction aborts, preventing partial or inconsistent states.

---

## Local Keyword Search Architecture (Milestone 6)

LagZero includes a browser-local, deterministic keyword search engine (`src/utils/search.ts`) that executes entirely client-side across all cached documents and chunks saved in IndexedDB.

### Search Flow & Scope
- **Offline & Private:** Operates strictly on local IndexedDB records. Queries and stored passages are never sent across the network or to remote cloud services.
- **Cross-Document Scope:** Searches all cached documents, ranking matching passages regardless of which webpage is currently active.
- **Orphan Prevention:** Chunks whose parent documents have been deleted are automatically excluded.
- **Safe Highlighting:** Matching terms in passages are highlighted safely without injecting unsafe raw HTML strings.

### Query Normalization
1. Trims leading and trailing whitespace.
2. Converts the query string to lowercase.
3. Splits into terms across whitespace and non-alphanumeric punctuation (hyphens, commas, periods, quotes, etc.).
4. Filters out empty tokens and deduplicates repeating words while preserving sequence.

### Scoring Formula & Ranking
Each chunk is scored deterministically based on:
1. **Exact Phrase Match (+50 pts):** If the complete multi-word query string appears in the chunk text (+25 pts if in heading, +35 pts if in title).
2. **Title Match (+20 pts per token):** If a query token appears in the document title.
3. **Heading Context (+10 pts per token):** If a query token appears in the section/heading context.
4. **Passage Term Matches (+15 pts per token):** For each distinct query token occurring in the chunk text.
5. **Term Frequency (+3 pts per occurrence, capped at +30 pts):** Rewards multiple term occurrences while preventing keyword stuffing.
6. **Query Coverage Bonus (+25 pts):** Awarded if all query tokens match the document/chunk.

**Deterministic Tie-Breaking:**
When two passages have identical relevance scores, ties are broken deterministically:
1. Document title in alphabetical order (`localeCompare`).
2. Chunk index in ascending sequential order (`chunkIndex`).

---

## Getting Started

### Prerequisites
- Node.js (v20+ recommended)
- npm (v10+)
- Google Chrome (v116+ for Side Panel API support)

### Installation & Build

1. Clone the repository:
   ```bash
   git clone https://github.com/Dhanuprithika/lagzero.git
   cd lagzero
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the production extension:
   ```bash
   npm run build
   ```
   The self-contained extension output will be emitted to the `dist/` directory.

4. Run the linter:
   ```bash
   npm run lint
   ```

5. Run the automated test suites:
   ```bash
   # Test chunking engine
   npx tsx test-chunking.ts

   # Test IndexedDB storage layer
   npx tsx test-storage.ts

   # Test local keyword search engine
   npx tsx test-search.ts
   ```

### Loading the Extension in Google Chrome

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Toggle on **Developer mode** in the top-right corner.
3. Click **Load unpacked** in the top-left toolbar.
4. Select the `dist/` folder inside the `lagzero` project directory:
   ```
   <path-to-repository>/lagzero/dist
   ```
5. Click the **Extensions** puzzle icon in the Chrome toolbar and pin **LagZero**.
6. Click the LagZero toolbar icon to open the native Side Panel.

### Manual Verification Steps in Chrome (Milestones 5 & 6)

1. Open any article webpage (e.g., `https://en.wikipedia.org/wiki/Artificial_intelligence`).
2. In the LagZero side panel, click **Test Connection** to confirm connectivity.
3. Click **Extract Page Content** and then **Chunk Content**.
4. In the **Local Content Cache** card, click **Save to Local Cache** to persist the document and chunks to IndexedDB.
5. In the **Local Keyword Search** card:
   - Type a query matching the saved article (e.g., `artificial intelligence` or `machine learning` or `neural networks`).
   - Click **Search** (or press Enter).
   - Verify the search result count and ranked passage list display.
   - Verify matching query tokens are highlighted in blue.
   - Verify the document title, chunk index, section heading, and source URL are displayed.
6. Click on a search result entry:
   - Verify it opens the cached document detail view showing the full stored content and ordered chunks.
7. Test Multi-Document Search:
   - Navigate to a second page (e.g., another article), extract, chunk, and save it.
   - Run a search query relevant to either page or both (e.g., `computing`).
   - Verify results from both documents appear ranked according to relevance.
8. Test Offline Capability:
   - Disconnect Wi-Fi/network connectivity.
   - Execute a search query in the search card.
   - Verify search operates immediately and completely offline without network errors.

---

## Known Limitations

- **Lexical Matching Only:** Search uses deterministic lexical and token matching. It does not use vector embeddings, semantic search, or fuzzy phonetic matching.
- **Text & Chunks Only:** Caching preserves the extracted clean text, structure, chunks, and metadata. It does **not** cache original full HTML, stylesheets, images, videos, or scripts.
- **No AI Inference Yet:** On-device local AI inference (WebLLM/WebGPU) and cloud fallback are scheduled for Phase 2.

---

## License

This project is licensed under the [MIT License](LICENSE).
