#!/bin/bash
# Run the Qwen3-VL-Embedding service

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Default values
PORT=${PORT:-8082}
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
