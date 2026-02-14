export type EmbeddingInput =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string } // base64 data URL or file path
  | { type: 'multimodal'; text: string; image: string }

export interface EmbeddingProvider {
  name: string
  dimensions: number
  supportsImages: boolean
  embed(input: EmbeddingInput): Promise<Float32Array>
  embedBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]>
}

export type EmbeddingProviderType = 'qwen3-vl' | 'llamacpp' | 'openai'

export interface EmbeddingProviderConfig {
  endpoint?: string
  apiKey?: string
  model?: string
  dimensions?: number
  multimodal?: boolean // For llamacpp with mmproj
  baseUrl?: string // Custom base URL for OpenAI-compatible APIs
}
