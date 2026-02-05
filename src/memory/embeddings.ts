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
 * llama.cpp embedding provider (text only).
 * Uses the OpenAI-compatible /v1/embeddings endpoint.
 */
export class LlamaCppEmbeddings implements EmbeddingProvider {
  name: string
  dimensions: number
  supportsImages = false
  private endpoint: string

  constructor(endpoint: string, model: string, dimensions = 768) {
    this.endpoint = endpoint.replace(/\/$/, '')
    this.name = `llamacpp/${model}`
    this.dimensions = dimensions
  }

  async embed(input: EmbeddingInput): Promise<Float32Array> {
    if (input.type !== 'text') {
      throw new Error('LlamaCppEmbeddings only supports text input')
    }

    const response = await fetch(`${this.endpoint}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: input.text,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`llama.cpp embeddings error: ${response.status} - ${error}`)
    }

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> }
    const first = data.data[0]
    if (!first) throw new Error('No embedding returned')
    return new Float32Array(first.embedding)
  }

  async embedBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
    // llama.cpp supports batch via array input
    const texts = inputs.map(input => {
      if (input.type !== 'text') {
        throw new Error('LlamaCppEmbeddings only supports text input')
      }
      return input.text
    })

    const response = await fetch(`${this.endpoint}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: texts,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`llama.cpp embeddings error: ${response.status} - ${error}`)
    }

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> }
    return data.data.map(d => new Float32Array(d.embedding))
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

  constructor(apiKey: string, model = 'text-embedding-3-small', dimensions = 1536) {
    this.apiKey = apiKey
    this.model = model
    this.dimensions = dimensions
  }

  async embed(input: EmbeddingInput): Promise<Float32Array> {
    if (input.type !== 'text') {
      throw new Error('OpenAIEmbeddings only supports text input')
    }

    const response = await fetch('https://api.openai.com/v1/embeddings', {
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

    const response = await fetch('https://api.openai.com/v1/embeddings', {
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
        config.model ?? 'nomic-embed-text',
        config.dimensions ?? 768
      )
    case 'openai':
      if (!config.apiKey) throw new Error('OpenAI API key required')
      return new OpenAIEmbeddings(config.apiKey, config.model, config.dimensions)
    default:
      throw new Error(`Unknown embedding provider: ${type}`)
  }
}
