# Memory System

egirl has a hybrid memory system that combines keyword search (SQLite FTS5) with semantic search (vector embeddings). This enables both precise lookups and fuzzy recall.

Without `[local.embeddings]` configured, memory runs on keyword search alone: the `memory_*` tools, recall and daily-log indexing all work, and only semantic matching is missing. Auto-extraction runs as usual; set `[memory] auto_extract = false` to keep that instance from making the extra aux-model call after turns.

## Overview

```
┌───────────────────────────────────────────┐
│              MemoryManager                │
│                                           │
│  set() / get() / search()                 │
│                                           │
│  ┌─────────────┐  ┌───────────────────┐   │
│  │ MemoryFiles │  │  MemoryIndexer    │   │
│  │             │  │                   │   │
│  │ MEMORY.md   │  │  SQLite (FTS5)    │   │
│  │ daily logs  │  │  embedding vectors│   │
│  └─────────────┘  └────────┬──────────┘   │
│                            │              │
│                   ┌────────▼──────────┐   │
│                   │  MemorySearch     │   │
│                   │                   │   │
│                   │  FTS + Vector     │   │
│                   │  Hybrid ranking   │   │
│                   └────────┬──────────┘   │
│                            │              │
│                   ┌────────▼──────────┐   │
│                   │ EmbeddingProvider │   │
│                   │                   │   │
│                   │ Qwen3-VL / llama  │   │
│                   │ / OpenAI          │   │
│                   └───────────────────┘   │
└───────────────────────────────────────────┘
```

## Components

### MemoryManager (`src/memory/index.ts`)

The public API. All memory operations go through this class.

**Text operations:**
- `set(key, value)` — Store a text memory with optional embedding
- `get(key)` — Retrieve by exact key
- `delete(key)` — Remove a memory

**Search operations:**
- `searchText(query, limit?)` — Keyword search (FTS only)
- `searchSemantic(query, limit?)` — Vector similarity search
- `searchHybrid(query, limit?)` — Combined FTS + vector search (default for tools)
- `findSimilar(key, limit?)` — Find memories similar to a given memory

### MemoryFiles (`src/memory/files.ts`)

Handles filesystem storage:

- **MEMORY.md**: The curated memory file in the workspace. This is a sacred file — never modified programmatically without user permission.
- **Daily logs**: Append-only logs in `workspace/logs/` recording memory operations.

### MemoryIndexer (`src/memory/indexer.ts`)

SQLite database (`workspace/memory.db`) with two storage mechanisms:

1. **Full-text search (FTS5)**: SQLite's built-in text search. Fast keyword matching with ranking.
2. **Embedding vectors**: Stored as binary blobs (Float32Array). Used for semantic similarity.

Schema (conceptual):
```
memories:
  key         TEXT PRIMARY KEY
  value       TEXT
  contentType TEXT
  embedding   BLOB (Float32Array)
  createdAt   TEXT
  updatedAt   TEXT
```

### MemorySearch (`src/memory/search.ts`)

Implements search strategies:

**FTS search** (`searchText`):
- Uses SQLite FTS5 for keyword matching
- Results are ranked by FTS relevance, converted to a 0–1 score based on rank position

**Vector search** (`searchVector`):
- Loads all embeddings into memory
- Computes cosine similarity between query vector and each stored vector
- Sorts by similarity score

**Hybrid search** (`searchHybrid`):
- Runs both FTS and vector search in parallel
- Combines scores using configurable weights (default: 30% FTS, 70% vector)
- Deduplicates by key, keeping the higher combined score
- This is the default search used by the `memory_search` tool


## Embedding Providers

Three embedding provider implementations exist in `src/memory/embeddings/`:

### Qwen3VLEmbeddings (`src/memory/embeddings/qwen3-vl.ts`)

The default provider (`provider = "qwen3-vl"`). Calls the Python service in `services/embeddings/`, which runs Qwen3-VL-Embedding-2B.

- Supports text, image, and multimodal inputs
- Endpoint: `POST /embed`, with the requested `dimensions` (the service truncates to it)

### LlamaCppEmbeddings (`src/memory/embeddings/llamacpp.ts`)

A `llama-server --embedding` (`provider = "llamacpp"`).

- Text goes to `POST /v1/embeddings`
- With `multimodal = true`, image inputs go to `POST /embeddings` (needs `--mmproj`)

### OpenAIEmbeddings (`src/memory/embeddings/openai.ts`)

Any OpenAI-compatible embeddings API (`provider = "openai"`). Text-only.

- Model: configurable (e.g., `text-embedding-3-small`)
- Endpoint: `POST {base_url}/embeddings`, default `https://api.openai.com/v1`, with `api_key` from the config

## Additional Components

### MemoryRetrieval (`src/memory/retrieval.ts`)

Proactive memory retrieval for context injection. Before each agent turn, relevant memories are automatically loaded based on the user's message. Supports category-filtered retrieval for scoped context (e.g., only loading project-related memories for background tasks).

### MemoryExtractor (`src/memory/extractor.ts`)

Auto-extraction of notable facts from conversations. After each conversation, the extractor scans the messages for facts worth remembering and stores them with `source: 'auto'`. Uses the local model — zero API cost.

### LogIndexer (`src/memory/log-indexer.ts`)

Indexes stdout logs as searchable memories, enabling the agent to recall information from previous sessions.

### Garbage collection (`src/memory/gc.ts`)

Runs at startup and every 24 hours. It deletes machine-written memories that are older than 14 days and were never recalled (every search hit counts as an access): extracted facts (`auto/` keys) and the permission supervisor's decision traces (`permission:` keys). Each deletion is logged under `gc`.

It never deletes manual or compaction memories, lessons (`lesson/` keys, though they are also written with source `auto`), or conversation-log chunks. The daily log files are the source of truth for the chunks, and the log indexer re-adds any it finds missing.

### CompactionFlush (`src/memory/compaction-flush.ts`)

Database maintenance for the memory store. Removes stale embeddings, compacts the FTS index, and flushes write-ahead logs.

## Tool Integration

The memory system is exposed to the agent through six tools:

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid search — finds memories by meaning and keywords |
| `memory_get` | Exact key lookup — retrieves a specific memory |
| `memory_set` | Store a new memory — generates embedding automatically |
| `memory_delete` | Remove a memory by key — deletes entry and embedding |
| `memory_list` | List all stored memories with previews |
| `memory_recall` | Temporal recall — finds memories from a specific time period with optional category filtering |

These tools are created via factory function `createMemoryTools(memory)` in `src/tools/builtin/memory.ts`. They work without embeddings, on keyword search. Only if the memory database itself fails to open are `memory_search` and `memory_get` replaced by stubs that return an error message.

## Search Results

All search methods return `SearchResult[]`:

```typescript
interface SearchResult {
  memory: IndexedMemory  // key, value, contentType, imagePath, embedding
  score: number          // 0.0–1.0 relevance score
  matchType: 'fts' | 'vector' | 'hybrid'
}
```

## Configuration

Memory needs no configuration: without `[local.embeddings]` it runs on keyword search. Add an embedding service for matching by meaning:

```toml
[local.embeddings]
provider = "llamacpp"
endpoint = "http://127.0.0.1:8083"
model = "nomic-embed-text-v1.5"
dimensions = 768
multimodal = false
```

If the embedding provider fails to start (for example `provider = "openai"` with no `api_key`), memory falls back to keyword search with a warning.

When the service is down, recall falls back to keyword search and recovers when it returns. Memories saved meanwhile are stored without an embedding and never get one later.

A different embedding model or `dimensions` leaves stored vectors that no longer match. A size mismatch makes vector search fail, so recall drops to keyword search and auto-extracted memories are not stored. Nothing re-embeds old memories.

## Running the Embedding Service

Two options, both on the CPU: nomic-embed-text-v1.5 on `llama-server` (146 MB, 768 dimensions), or the Python service in `services/embeddings/` (Qwen3-VL-Embedding-2B, 2048 dimensions, `GET /health`, `POST /embed`, `POST /v1/embeddings`). Commands, config for each, and what to do after a model change: [optional-services.md](optional-services.md#embeddings).

## Data Persistence

- **SQLite database** (`memory.db`): Stores all indexed memories with embeddings. Survives restarts.
- **Daily logs**: Append-only text files for audit trail. Not used for search.
- **Images**: PNG files on disk, referenced by path in the SQLite index.
- **MEMORY.md**: User-editable file. Not indexed — treated as static context in the system prompt.
