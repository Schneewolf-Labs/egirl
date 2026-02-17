# Memory System

egirl has a hybrid memory system that combines keyword search (SQLite FTS5) with semantic search (vector embeddings). This enables both precise lookups and fuzzy recall.

## Overview

```
┌───────────────────────────────────────────┐
│              MemoryManager                │
│                                           │
│  set() / get() / search()                 │
│  setImage() / setMultimodal()             │
│                                           │
│  ┌─────────────┐  ┌───────────────────┐   │
│  │ MemoryFiles │  │  MemoryIndexer    │   │
│  │             │  │                   │   │
│  │ MEMORY.md   │  │  SQLite (FTS5)    │   │
│  │ daily logs  │  │  embedding vectors│   │
│  │ images/     │  │                   │   │
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

**Image operations:**
- `setImage(key, imageData, description?)` — Store an image (base64) with optional text description
- `setMultimodal(key, text, imageData)` — Store text + image together
- `getWithImage(key)` — Retrieve a memory including its image data

**Search operations:**
- `searchText(query, limit?)` — Keyword search (FTS only)
- `searchSemantic(query, limit?)` — Vector similarity search
- `searchByImage(imageData, limit?)` — Find memories similar to an image
- `searchHybrid(query, limit?)` — Combined FTS + vector search (default for tools)
- `findSimilar(key, limit?)` — Find memories similar to a given memory

### MemoryFiles (`src/memory/files.ts`)

Handles filesystem storage:

- **MEMORY.md**: The curated memory file in the workspace. This is a sacred file — never modified programmatically without user permission.
- **Daily logs**: Append-only logs in `workspace/logs/` recording memory operations.
- **Images**: Stored in `workspace/images/` as PNG files keyed by memory key.

### MemoryIndexer (`src/memory/indexer.ts`)

SQLite database (`workspace/memory.db`) with two storage mechanisms:

1. **Full-text search (FTS5)**: SQLite's built-in text search. Fast keyword matching with ranking.
2. **Embedding vectors**: Stored as binary blobs (Float32Array). Used for semantic similarity.

Schema (conceptual):
```
memories:
  key         TEXT PRIMARY KEY
  value       TEXT
  contentType TEXT ('text' | 'image' | 'multimodal')
  imagePath   TEXT
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
- Can filter by content type (text, image, multimodal)

**Hybrid search** (`searchHybrid`):
- Runs both FTS and vector search in parallel
- Combines scores using configurable weights (default: 30% FTS, 70% vector)
- Deduplicates by key, keeping the higher combined score
- This is the default search used by the `memory_search` tool

**Image search** (`searchByImage`):
- Embeds the query image using the multimodal embedding provider
- Runs vector search against stored embeddings
- Requires a multimodal embedding provider (e.g., Qwen3-VL-Embedding)

## Embedding Providers

Three embedding provider implementations exist in `src/memory/embeddings/`:

### Qwen3VLEmbeddings (`src/memory/embeddings/qwen3-vl.ts`)

The default provider. Sends requests to a llama.cpp server running a Qwen3-VL-Embedding model.

- Supports text, image, and multimodal inputs
- Images are sent as base64 with `[img-N]` placeholder format
- Endpoint: `POST /embeddings` (llama.cpp compatible)

### LlamaCppEmbeddings (`src/memory/embeddings/llamacpp.ts`)

Generic llama.cpp embedding endpoint. Text-only (no image support).

- Endpoint: `POST /embeddings`
- Used when the embedding model doesn't support vision

### OpenAIEmbeddings (`src/memory/embeddings/openai.ts`)

Uses the OpenAI Embeddings API. Text-only.

- Model: configurable (e.g., `text-embedding-3-small`)
- Endpoint: OpenAI API via the `openai` npm package

## Additional Components

### MemoryRetrieval (`src/memory/retrieval.ts`)

Proactive memory retrieval for context injection. Before each agent turn, relevant memories are automatically loaded based on the user's message. Supports category-filtered retrieval for scoped context (e.g., only loading project-related memories for background tasks).

### MemoryExtractor (`src/memory/extractor.ts`)

Auto-extraction of notable facts from conversations. After each conversation, the extractor scans the messages for facts worth remembering and stores them with `source: 'auto'`. Uses the local model — zero API cost.

### LogIndexer (`src/memory/log-indexer.ts`)

Indexes stdout logs as searchable memories, enabling the agent to recall information from previous sessions.

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

These tools are created via factory function `createMemoryTools(memory)` in `src/tools/builtin/memory.ts`. If the memory system is not initialized (no embeddings configured), stub implementations return an error message.

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

Memory requires the `[local.embeddings]` section in `egirl.toml`:

```toml
[local.embeddings]
endpoint = "http://localhost:8082"
model = "qwen3-vl-embedding-2b"
dimensions = 2048
multimodal = true
```

If this section is omitted, `createMemory()` returns `undefined` and the memory tools return error messages when invoked.

## Running the Embedding Service

### Option A: llama.cpp (recommended)

Run a second llama.cpp instance with the `--embedding` flag:

```bash
llama-server \
  -m Qwen.Qwen3-VL-Embedding-2B.Q8_0.gguf \
  --mmproj mmproj-Qwen.Qwen3-VL-Embedding-2B.f16.gguf \
  -c 8192 --port 8082 --embedding -ngl 99
```

### Option B: Python service

A standalone Python server is included in `services/embeddings/`:

```bash
cd services/embeddings && ./run.sh
```

This starts a FastAPI server on port 8082 with `GET /health` and `POST /embeddings` endpoints.

## Data Persistence

- **SQLite database** (`memory.db`): Stores all indexed memories with embeddings. Survives restarts.
- **Daily logs**: Append-only text files for audit trail. Not used for search.
- **Images**: PNG files on disk, referenced by path in the SQLite index.
- **MEMORY.md**: User-editable file. Not indexed — treated as static context in the system prompt.
