#!/bin/bash
# Run the Qwen3-VL-Embedding service

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Default values
PORT=${PORT:-8082}

# CPU tuning. This service runs on the CPU deliberately (the model's M-RoPE path misbehaves on
# CUDA here, and staying off the GPU leaves the whole card for the main LLM), so the forward is
# memory-bound on the weights and these three knobs are what matter. Measured on a Ryzen 9
# 7900, per text, unique texts so nothing is served from cache:
#
#   fp32, one at a time (the original)   0.390 s
#   fp32, batched 16                     0.175 s   2.2x
#   bf16, batched 16                     0.069 s   5.7x
#
# bf16 halves the weight bytes the forward has to read and this CPU has AVX512-BF16. It changes
# the numbers slightly -- cosine against the fp32 embedding of the same text is 0.99987, far
# tighter than anything that would reorder a retrieval result -- so it is the default here.
# Set EMBED_DTYPE=float32 to go back; the server code still defaults to fp32 on its own.
EMBED_DTYPE=${EMBED_DTYPE:-bfloat16}
EMBED_MAX_BATCH=${EMBED_MAX_BATCH:-16}
EMBED_CACHE=${EMBED_CACHE:-2048}     # texts; a hit is ~0.002 s against ~0.15 s for a miss
export EMBED_DTYPE EMBED_MAX_BATCH EMBED_CACHE
MODEL=${MODEL:-"Qwen/Qwen3-VL-Embedding-2B"}

# Check if venv exists, create if not
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
    source venv/bin/activate
    pip install --upgrade pip
    pip install -r requirements.txt
else
    source venv/bin/activate
fi

echo "Starting Qwen3-VL-Embedding service on port $PORT..."
python server.py --model "$MODEL" --port "$PORT" "$@"
