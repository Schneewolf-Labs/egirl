import { log } from '../util/logger'

export type EmbeddingInput =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string }  // base64 data URL or file path
  | { type: 'multimodal'; text: string; image: string }

export interface EmbeddingProvider {
  name: string
  dimensions: number
  supportsImages: boolean
  embed(input: EmbeddingInput): Promise<Float32Array>
  embedBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]>
}

/**
 * Qwen3-VL multimodal embedding provider.
 * Calls a Python service running the Qwen3VLEmbedder.
 */
export class Qwen3VLEmbeddings implements EmbeddingProvider {
  name = 'qwen3-vl'
  dimensions: number
  supportsImages = true
  private endpoint: string

  constructor(endpoint: string, dimensions = 2048) {
    this.endpoint = endpoint.replace(/\/$/, '')
    this.dimensions = dimensions
  }

  async embed(input: EmbeddingInput): Promise<Float32Array> {
    const results = await this.embedBatch([input])
    const first = results[0]
    if (!first) throw new Error('No embedding returned')
    return first
  }

  async embedBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
    // Convert to the format expected by the Python service
    const formattedInputs = inputs.map(input => {
      if (input.type === 'text') {
        return { text: input.text }
      } else if (input.type === 'image') {
        return { image: input.image }
      } else {
        return { text: input.text, image: input.image }
      }
    })

    const response = await fetch(`${this.endpoint}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: formattedInputs,
        dimensions: this.dimensions,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Qwen3-VL embeddings error: ${response.status} - ${error}`)
    }

    const data = (await response.json()) as { embeddings: number[][] }
    return data.embeddings.map(e => new Float32Array(e))
  }
}

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

  constructor(endpoint: string, model: string, options: { dimensions?: number; multimodal?: boolean } = {}) {
    this.endpoint = endpoint.replace(/\/$/, '')
    this.name = `llamacpp/${model}`
    this.dimensions = options.dimensions ?? 2048
    this.supportsImages = options.multimodal ?? false
  }

  async embed(input: EmbeddingInput): Promise<Float32Array> {
    const payload = this.formatPayload(input)

    // Use /embeddings for multimodal, /v1/embeddings for text-only
    const endpoint = this.supportsImages && input.type !== 'text'
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
    if (this.supportsImages && inputs.some(i => i.type !== 'text')) {
      return Promise.all(inputs.map(input => this.embed(input)))
    }

    const texts = inputs.map(input => {
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
    return data.data.map(d => new Float32Array(d.embedding))
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

/**
 * OpenAI embedding provider (text only, cloud fallback).
 */
export class OpenAIEmbeddings implements EmbeddingProvider {
  name = 'openai'
  dimensions: number
  supportsImages = false
  private apiKey: string
  private model: string
  private baseUrl: string

  constructor(apiKey: string, model = 'text-embedding-3-small', dimensions = 1536, baseUrl = 'https://api.openai.com/v1') {
    this.apiKey = apiKey
    this.model = model
    this.dimensions = dimensions
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  async embed(input: EmbeddingInput): Promise<Float32Array> {
    if (input.type !== 'text') {
      throw new Error('OpenAIEmbeddings only supports text input')
    }

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: input.text,
      }),
    })

    if (!response.ok) {
      throw new Error(`OpenAI embeddings error: ${response.status}`)
    }

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> }
    const first = data.data[0]
    if (!first) throw new Error('No embedding returned')
    return new Float32Array(first.embedding)
  }

  async embedBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
    const texts = inputs.map(input => {
      if (input.type !== 'text') {
        throw new Error('OpenAIEmbeddings only supports text input')
      }
      return input.text
    })

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    })

    if (!response.ok) {
      throw new Error(`OpenAI embeddings error: ${response.status}`)
    }

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> }
    return data.data.map(d => new Float32Array(d.embedding))
  }
}

export type EmbeddingProviderType = 'qwen3-vl' | 'llamacpp' | 'openai'

export interface EmbeddingProviderConfig {
  endpoint?: string
  apiKey?: string
  model?: string
  dimensions?: number
  multimodal?: boolean  // For llamacpp with mmproj
  baseUrl?: string      // Custom base URL for OpenAI-compatible APIs
}

export function createEmbeddingProvider(
  type: EmbeddingProviderType,
  config: EmbeddingProviderConfig
): EmbeddingProvider {
  switch (type) {
    case 'qwen3-vl':
      return new Qwen3VLEmbeddings(
        config.endpoint ?? 'http://localhost:8082',
        config.dimensions ?? 2048
      )
    case 'llamacpp':
      return new LlamaCppEmbeddings(
        config.endpoint ?? 'http://localhost:8081',
        config.model ?? 'qwen3-vl-embedding',
        {
          dimensions: config.dimensions ?? 2048,
          multimodal: config.multimodal ?? false,
        }
      )
    case 'openai':
      if (!config.apiKey) throw new Error('OpenAI API key required')
      return new OpenAIEmbeddings(config.apiKey, config.model, config.dimensions, config.baseUrl)
    default:
      throw new Error(`Unknown embedding provider: ${type}`)
  }
}
