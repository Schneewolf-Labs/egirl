# Vision Capabilities

egirl supports visual input through Qwen3-VL. This enables screenshot analysis, image understanding, and visual debugging.

## Architecture

```
User Request ("what's on my screen?")
         │
         ▼
┌─────────────────┐
│  Screenshot Tool │  ← Captures display, saves to temp file
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Image Encoding │  ← Base64 encode for API
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Qwen3-VL      │  ← Multimodal model analyzes image + text
└────────┬────────┘
         │
         ▼
     Response
```

## Qwen3 Vision Format

The Qwen3 chat template handles images with vision tokens:

```
<|im_start|>user
What's in this image?
<|vision_start|><|image_pad|><|vision_end|><|im_end|>
```

For the OpenAI-compatible chat API (llama.cpp), images are passed as base64 in the content array:

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "What's in this image?"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
  ]
}
```

For the embeddings API (`/embeddings`), use the `[img-N]` placeholder format:

```json
{
  "content": "[img-1]\nOptional description text",
  "image_data": [
    {"id": 1, "data": "<base64 without data: prefix>"}
  ]
}
```

## Message Types

Content can be either a string or an array of content parts:

```typescript
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_call_id?: string
  tool_calls?: ToolCall[]
}
```

## Screenshot Tool

The `screenshot` tool captures the current display:

```typescript
{
  name: 'screenshot',
  description: 'Capture a screenshot of the current display',
  parameters: {
    type: 'object',
    properties: {
      display: {
        type: 'string',
        description: 'Display to capture (default: primary)'
      },
      region: {
        type: 'object',
        description: 'Optional region to capture',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' }
        }
      }
    }
  }
}
```

Returns the image as base64-encoded PNG.

## Implementation

### Dependencies

Uses native tools available on Linux:
- `grim` (Wayland) or `scrot`/`maim` (X11)
- Falls back to `gnome-screenshot` if others unavailable

### Provider Handling

The llama.cpp provider detects image content and:
1. Extracts base64 data
2. Formats for the multimodal API
3. Handles the response normally

### Training Data

Include visual task examples:

```jsonl
{"messages": [
  {"role": "user", "content": "take a screenshot and tell me what apps are open"},
  {"role": "assistant", "content": "<tool_call>\n{\"name\": \"screenshot\", \"arguments\": {}}\n</tool_call>"},
  {"role": "user", "content": [
    {"type": "text", "text": "<tool_response>\nScreenshot captured\n</tool_response>"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
  ]},
  {"role": "assistant", "content": "I can see you have Firefox, VS Code, and a terminal open..."}
]}
```

## Use Cases

- **Debug UI issues**: "Why does this button look wrong?"
- **Screen reading**: "What's the error message in that dialog?"
- **Visual verification**: "Did that command create the expected output?"
- **Documentation**: "Describe what's on screen for the changelog"

## Routing Considerations

Visual tasks should typically route to the VL model. Add to routing rules:

```toml
[routing]
always_local_vl = ["screenshot", "describe_image", "visual_debug"]
```

Or detect when the conversation includes images and switch to VL automatically.

## Multimodal Memory

With Qwen3-VL-Embedding, screenshots and images can be stored in memory with semantic embeddings:

```typescript
// Store a screenshot with context
await memoryManager.setMultimodal(
  'debug-session-2024-01-15',
  'Error dialog showing TypeScript type mismatch',
  screenshotBase64
)

// Search for images by text description
const results = await memoryManager.searchSemantic('typescript error dialog')

// Search for similar images
const similar = await memoryManager.searchByImage(newScreenshotBase64)
```

## Starting the Services

All services run via llama.cpp - no Python needed.

```bash
# Terminal 1: Chat model (48GB GPU)
CUDA_VISIBLE_DEVICES=0 llama-server \
  -m qwen3-vl-32b-q8.gguf \
  --mmproj mmproj-qwen3-vl-32b-f16.gguf \
  -c 32768 --port 8080 -ngl 99

# Terminal 2: Multimodal embeddings (16GB GPU)
CUDA_VISIBLE_DEVICES=1 llama-server \
  -m Qwen.Qwen3-VL-Embedding-2B.Q8_0.gguf \
  --mmproj mmproj-Qwen.Qwen3-VL-Embedding-2B.f16.gguf \
  -c 8192 --port 8082 --embedding -ngl 99

# Terminal 3: egirl
bun run dev
```

### Configuration

```toml
# egirl.toml
[local.embeddings]
endpoint = "http://localhost:8082"
model = "qwen3-vl-embedding-2b"
dimensions = 2048
multimodal = true  # Enable image embedding support
```

### Model Sizes

| Model | LLM (Q8) | mmproj (F16) | Total |
|-------|----------|--------------|-------|
| Qwen3-VL-Embedding-2B | 1.8 GB | 0.8 GB | ~2.6 GB |
| Qwen3-VL-Embedding-8B | ~8 GB | ~0.8 GB | ~9 GB |

Both fit comfortably on a 16GB card.
