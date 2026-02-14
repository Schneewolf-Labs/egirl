import type { EmbeddingInput, EmbeddingProvider } from './types'

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
