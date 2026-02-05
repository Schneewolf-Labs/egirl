#!/usr/bin/env python3
"""
Qwen3-VL Embedding Server

A simple FastAPI service that wraps Qwen3VLEmbedder for multimodal embeddings.

Usage:
    python scripts/embedding-server.py --model Qwen/Qwen3-VL-Embedding-2B --port 8082

Requirements:
    pip install fastapi uvicorn torch transformers qwen-vl-utils
"""

import argparse
import base64
import io
from typing import Optional

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image

# Import the Qwen embedder
# This assumes you've cloned the model repo or have the script available
try:
    from qwen3_vl_embedding import Qwen3VLEmbedder
except ImportError:
    # Fallback: try importing from transformers directly
    from transformers import Qwen2VLForConditionalGeneration, AutoProcessor
    Qwen3VLEmbedder = None


app = FastAPI(title="Qwen3-VL Embedding Server")

# Global model instance
model: Optional["Qwen3VLEmbedder"] = None
processor = None
model_raw = None


class EmbeddingInput(BaseModel):
    text: Optional[str] = None
    image: Optional[str] = None  # base64 data URL or file path


class EmbeddingRequest(BaseModel):
    inputs: list[EmbeddingInput]
    dimensions: int = 2048


class EmbeddingResponse(BaseModel):
    embeddings: list[list[float]]


def load_image(image_data: str) -> Image.Image:
    """Load image from base64 data URL or file path."""
    if image_data.startswith("data:"):
        # Base64 data URL
        header, data = image_data.split(",", 1)
        image_bytes = base64.b64decode(data)
        return Image.open(io.BytesIO(image_bytes))
    else:
        # File path
        return Image.open(image_data)


@app.post("/embed", response_model=EmbeddingResponse)
async def embed(request: EmbeddingRequest):
    """Generate embeddings for text, images, or multimodal inputs."""
    if model is None and model_raw is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    try:
        if model is not None:
            # Use the Qwen3VLEmbedder wrapper
            formatted_inputs = []
            for inp in request.inputs:
                if inp.text and inp.image:
                    formatted_inputs.append({"text": inp.text, "image": inp.image})
                elif inp.text:
                    formatted_inputs.append({"text": inp.text})
                elif inp.image:
                    formatted_inputs.append({"image": inp.image})
                else:
                    raise HTTPException(status_code=400, detail="Input must have text or image")

            embeddings = model.process(formatted_inputs, max_length=request.dimensions)
            return EmbeddingResponse(embeddings=embeddings.tolist())
        else:
            # Fallback: basic embedding extraction
            # This is a simplified version - the official wrapper is better
            embeddings = []
            for inp in request.inputs:
                if inp.text:
                    inputs = processor(text=inp.text, return_tensors="pt").to(model_raw.device)
                    with torch.no_grad():
                        outputs = model_raw(**inputs, output_hidden_states=True)
                        # Use last hidden state mean as embedding
                        hidden = outputs.hidden_states[-1]
                        emb = hidden.mean(dim=1).squeeze().cpu().numpy()
                        # Truncate to requested dimensions
                        emb = emb[:request.dimensions]
                        embeddings.append(emb.tolist())
                else:
                    raise HTTPException(
                        status_code=400,
                        detail="Image-only embedding requires Qwen3VLEmbedder wrapper"
                    )

            return EmbeddingResponse(embeddings=embeddings)

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "ok",
        "model_loaded": model is not None or model_raw is not None,
        "supports_images": model is not None,
    }


def main():
    global model, model_raw, processor

    parser = argparse.ArgumentParser(description="Qwen3-VL Embedding Server")
    parser.add_argument(
        "--model",
        type=str,
        default="Qwen/Qwen3-VL-Embedding-2B",
        help="Model name or path",
    )
    parser.add_argument("--port", type=int, default=8082, help="Server port")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Server host")
    parser.add_argument(
        "--dtype",
        type=str,
        default="float16",
        choices=["float16", "bfloat16", "float32", "int8"],
        help="Model dtype",
    )
    parser.add_argument(
        "--dimensions",
        type=int,
        default=2048,
        help="Default embedding dimensions",
    )

    args = parser.parse_args()

    # Determine dtype
    dtype_map = {
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
        "float32": torch.float32,
    }
    torch_dtype = dtype_map.get(args.dtype, torch.float16)

    print(f"Loading model: {args.model}")

    if Qwen3VLEmbedder is not None:
        # Use the official wrapper
        load_kwargs = {
            "model_name_or_path": args.model,
            "torch_dtype": torch_dtype,
            "attn_implementation": "flash_attention_2",
        }
        if args.dtype == "int8":
            load_kwargs["load_in_8bit"] = True

        model = Qwen3VLEmbedder(**load_kwargs)
        print("Loaded Qwen3VLEmbedder (full multimodal support)")
    else:
        # Fallback to basic loading
        print("Warning: Qwen3VLEmbedder not found, using basic transformer loading")
        print("Image embedding will not be available")
        model_raw = Qwen2VLForConditionalGeneration.from_pretrained(
            args.model,
            torch_dtype=torch_dtype,
            device_map="auto",
        )
        processor = AutoProcessor.from_pretrained(args.model)

    print(f"Starting server on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
