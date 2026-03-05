#!/usr/bin/env python3
"""
Qwen3-VL-Embedding-2B serving script.
Downloads the model from HuggingFace on first run (or loads from cache).
Runs on CPU. Exposes POST /embed for egirl's qwen3-vl embedding provider.

Usage:
    python serve-embedding.py [--port 8083] [--host 0.0.0.0]

API:
    POST /embed
    {
        "inputs": [
            {"text": "..."},
            {"image": "<base64 data URL or URL>"},
            {"text": "...", "image": "..."}
        ],
        "dimensions": 2048
    }
    -> {"embeddings": [[...], ...]}
"""

import argparse
import base64
import io
import logging
from typing import Any

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel
from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

MODEL_ID = "Qwen/Qwen3-VL-Embedding-2B"

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

model = None
processor = None


def load_model() -> None:
    global model, processor
    log.info(f"Loading {MODEL_ID} on CPU...")
    model = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
    processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)

    # Load the actual embedding model
    # Qwen3-VL-Embedding uses a custom model class
    from transformers import AutoModel
    model = AutoModel.from_pretrained(
        MODEL_ID,
        trust_remote_code=True,
        torch_dtype=torch.float32,
        device_map="cpu",
    )
    model.eval()
    log.info("Model loaded.")


def decode_image(image_data: str) -> Image.Image:
    """Decode base64 data URL or fetch from URL."""
    if image_data.startswith("data:"):
        # data URL: data:image/png;base64,<data>
        header, b64 = image_data.split(",", 1)
        raw = base64.b64decode(b64)
        return Image.open(io.BytesIO(raw)).convert("RGB")
    elif image_data.startswith("http://") or image_data.startswith("https://"):
        import requests
        resp = requests.get(image_data, timeout=10)
        resp.raise_for_status()
        return Image.open(io.BytesIO(resp.content)).convert("RGB")
    else:
        # Assume raw base64
        raw = base64.b64decode(image_data)
        return Image.open(io.BytesIO(raw)).convert("RGB")


class EmbedInput(BaseModel):
    text: str | None = None
    image: str | None = None


class EmbedRequest(BaseModel):
    inputs: list[EmbedInput]
    dimensions: int = 2048


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]


@app.on_event("startup")
async def startup() -> None:
    load_model()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest) -> EmbedResponse:
    if model is None or processor is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    embeddings: list[list[float]] = []

    for inp in request.inputs:
        try:
            with torch.no_grad():
                if inp.text is not None and inp.image is not None:
                    # Multimodal
                    img = decode_image(inp.image)
                    inputs = processor(
                        text=inp.text,
                        images=[img],
                        return_tensors="pt",
                    )
                    outputs = model(**inputs, output_hidden_states=True)
                elif inp.image is not None:
                    # Image-only
                    img = decode_image(inp.image)
                    inputs = processor(images=[img], return_tensors="pt")
                    outputs = model(**inputs, output_hidden_states=True)
                else:
                    # Text-only
                    text = inp.text or ""
                    inputs = processor(text=text, return_tensors="pt")
                    outputs = model(**inputs, output_hidden_states=True)

                # Mean-pool last hidden state
                hidden = outputs.last_hidden_state  # (1, seq_len, hidden_dim)
                embedding = hidden.mean(dim=1).squeeze(0)  # (hidden_dim,)

                # Normalize to unit length
                embedding = embedding / (embedding.norm() + 1e-8)

                embeddings.append(embedding.tolist())

        except Exception as e:
            log.error(f"Embedding error: {e}")
            raise HTTPException(status_code=500, detail=str(e)) from e

    return EmbedResponse(embeddings=embeddings)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8083)
    args = parser.parse_args()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
