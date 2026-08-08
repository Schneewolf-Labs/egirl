# Embedding Server Benchmark

## Results (before optimization)

- Sequential 8 single-text requests: ~3.5s (~0.44s/text)
- One batch of 8 texts: ~1.6s (~0.2s/text)
- **Speedup: ~2.2x** for batched vs sequential

Batching helps because a single forward pass of the 2B model is expensive on CPU.
