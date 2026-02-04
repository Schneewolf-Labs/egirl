import { log } from '../utils/logger'

export interface EmbeddingProvider {
  name: string
  embed(text: string): Promise<Float32Array>
  embedBatch(texts: string[]): Promise<Float32Array[]>
}

export class OllamaEmbeddings implements EmbeddingProvider {
  name = 'ollama'
  private endpoint: string
  private model: string

  constructor(endpoint: string, model = 'nomic-embed-text') {
    this.endpoint = endpoint.replace(/\/$/, '')
    this.model = model
  }

  async embed(text: string): Promise<Float32Array> {
    const response = await fetch(`${this.endpoint}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: text,
      }),
    })

    if (!response.ok) {
      throw new Error(`Ollama embeddings error: ${response.status}`)
    }

    const data = await response.json() as { embedding: number[] }
    return new Float32Array(data.embedding)
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // Ollama doesn't support batch embeddings natively, so we do them sequentially
    return Promise.all(texts.map(text => this.embed(text)))
  }
}

// Placeholder for when we need cloud embeddings
export class OpenAIEmbeddings implements EmbeddingProvider {
  name = 'openai'
  private apiKey: string
  private model: string

  constructor(apiKey: string, model = 'text-embedding-3-small') {
    this.apiKey = apiKey
    this.model = model
  }

  async embed(text: string): Promise<Float32Array> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    })

    if (!response.ok) {
      throw new Error(`OpenAI embeddings error: ${response.status}`)
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> }
    const firstEmbedding = data.data[0]
    if (!firstEmbedding) throw new Error('No embedding returned')
    return new Float32Array(firstEmbedding.embedding)
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    })

    if (!response.ok) {
      throw new Error(`OpenAI embeddings error: ${response.status}`)
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> }
    return data.data.map(d => new Float32Array(d.embedding))
  }
}

export function createEmbeddingProvider(
  type: 'ollama' | 'openai',
  config: { endpoint?: string; apiKey?: string; model?: string }
): EmbeddingProvider {
  switch (type) {
    case 'ollama':
      return new OllamaEmbeddings(config.endpoint ?? 'http://localhost:11434', config.model)
    case 'openai':
      if (!config.apiKey) throw new Error('OpenAI API key required')
      return new OpenAIEmbeddings(config.apiKey, config.model)
    default:
      throw new Error(`Unknown embedding provider: ${type}`)
  }
}
