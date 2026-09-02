# lagzero
# LagZero

> AI assistance that doesn't wait for the internet.

LagZero is a local-first AI browser assistant built as a Chrome Extension
for low-latency web content understanding.

Instead of sending an entire webpage to a remote AI service, LagZero
extracts and processes webpage content locally, performs local RAG
retrieval, and dynamically chooses between local and cloud inference
based on network and device conditions.

## Core Technologies

- React
- TypeScript
- Chrome Extension Manifest V3
- LangChain.js
- IndexedDB
- Vector Similarity Search
- WebGPU
- WebLLM
- RAG
- Local/Cloud Adaptive Inference

## Architecture

Webpage
→ Content Extraction
→ Cleaning
→ Chunking
→ Local Embeddings
→ IndexedDB
→ Local Retrieval
→ Adaptive Router
→ Local / Cloud LLM
→ Streaming Response

## Key Features

- Local webpage indexing
- Browser-based RAG
- Persistent local vector storage
- Local inference with WebGPU
- Cloud inference fallback
- Adaptive inference routing
- Offline-capable architecture
- Source-grounded responses
- Network and latency monitoring
- Performance benchmarking

## Project Status

🚧 Under active development

The project is being developed incrementally, beginning with
webpage extraction and local RAG before adding local inference,
cloud inference, and adaptive routing.

## Vision

The AI should adapt to the environment instead of forcing the
user to adapt to the network.

##📁 Initial Repository Structure

lagzero/
│
├── src/
│   ├── background/
│   ├── content/
│   ├── sidebar/
│   ├── rag/
│   ├── inference/
│   ├── network/
│   ├── storage/
│   ├── types/
│   └── utils/
│
├── public/
│   └── icons/
│
├── docs/
│   ├── architecture/
│   ├── benchmarking/
│   └── screenshots/
│
├── tests/
│
├── .gitignore
├── README.md
├── LICENSE
├── package.json
├── tsconfig.json
└── vite.config.ts
