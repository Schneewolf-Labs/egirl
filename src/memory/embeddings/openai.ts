import type { EmbeddingInput, EmbeddingProvider } from './types'

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
