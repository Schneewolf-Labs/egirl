import type { EmbeddingInput, EmbeddingProvider } from './types'

/**
 * llama.cpp embedding provider.
 * Uses /embeddings endpoint (non-OpenAI format for multimodal support).
 * Supports multimodal input when running with --mmproj.
 *
 * API format for multimodal:
 * {
 *   "content": "Image: [img-1].\nDescription text",
 *   "image_data": [{ "id": 1, "data": "<base64>" }]
 * }
 */
export class LlamaCppEmbeddings implements EmbeddingProvider {
  name: string
  dimensions: number
  supportsImages: boolean
  private endpoint: string

  constructor(
    endpoint: string,
    model: string,
    options: { dimensions?: number; multimodal?: boolean } = {},
  ) {
    this.endpoint = endpoint.replace(/\/$/, '')
    this.name = `llamacpp/${model}`
    this.dimensions = options.dimensions ?? 2048
    this.supportsImages = options.multimodal ?? false
  }

  async embed(input: EmbeddingInput): Promise<Float32Array> {
    const payload = this.formatPayload(input)

    // Use /embeddings for multimodal, /v1/embeddings for text-only
    const endpoint =
      this.supportsImages && input.type !== 'text'
        ? `${this.endpoint}/embeddings`
        : `${this.endpoint}/v1/embeddings`

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`llama.cpp embeddings error: ${response.status} - ${error}`)
    }

    const data = await response.json()

    // Handle different response formats
    if ('embedding' in data) {
      // Non-OpenAI format: { embedding: number[] }
      return new Float32Array(data.embedding as number[])
    } else if ('data' in data) {
      // OpenAI format: { data: [{ embedding: number[] }] }
      const first = (data.data as Array<{ embedding: number[] }>)[0]
      if (!first) throw new Error('No embedding returned')
      return new Float32Array(first.embedding)
    }

    throw new Error('Unexpected response format')
  }

  async embedBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
    // Process sequentially for multimodal, batch for text-only
    if (this.supportsImages && inputs.some((i) => i.type !== 'text')) {
      return Promise.all(inputs.map((input) => this.embed(input)))
    }

    const texts = inputs.map((input) => {
      if (input.type !== 'text') {
        throw new Error('Batch embedding only supports text input')
      }
      return input.text
    })

    const response = await fetch(`${this.endpoint}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: texts }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`llama.cpp embeddings error: ${response.status} - ${error}`)
    }

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> }
    return data.data.map((d) => new Float32Array(d.embedding))
  }

  /**
   * Format payload for llama.cpp embeddings API.
   * Multimodal uses [img-N] placeholder syntax with image_data array.
   */
  private formatPayload(input: EmbeddingInput): Record<string, unknown> {
    if (input.type === 'text') {
      return { input: input.text }
    }

    if (!this.supportsImages) {
      throw new Error('Image input requires multimodal embedding model (use --mmproj)')
    }

    // Extract base64 data from data URL if present
    const imageData = this.extractBase64(input.image)

    if (input.type === 'image') {
      return {
        content: '[img-1]',
        image_data: [{ id: 1, data: imageData }],
      }
    }

    // Multimodal: text + image
    return {
      content: `[img-1]\n${input.text}`,
      image_data: [{ id: 1, data: imageData }],
    }
  }

  /**
   * Extract base64 data from a data URL or return as-is
   */
  private extractBase64(imageData: string): string {
    if (imageData.startsWith('data:')) {
      const parts = imageData.split(',')
      return parts[1] ?? imageData
    }
    return imageData
  }
}
