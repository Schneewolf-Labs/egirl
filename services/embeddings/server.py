#!/usr/bin/env python3
"""
Qwen3-VL-Embedding Service

A FastAPI service for generating multimodal embeddings using Qwen3-VL-Embedding-2B.
Supports text, images, and mixed modality inputs.

Usage:
    python server.py --port 8082 --model Qwen/Qwen3-VL-Embedding-2B
"""

import argparse
import base64
import io
import logging
from typing import Any, Dict, List, Optional, Union

import numpy as np
import torch
import torch.nn.functional as F
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel
from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration
from qwen_vl_utils import process_vision_info

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
MAX_LENGTH = 8192
MIN_PIXELS = 256 * 28 * 28
MAX_PIXELS = 1280 * 28 * 28
DEFAULT_INSTRUCTION = "Represent the input for retrieval."


class Qwen3VLEmbedder:
    """Wrapper for Qwen3-VL-Embedding model."""

    def __init__(
        self,
        model_name_or_path: str,
        device: Optional[str] = None,
        torch_dtype: torch.dtype = torch.float16,
    ):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        logger.info(f"Loading model {model_name_or_path} on {self.device}")

        self.processor = AutoProcessor.from_pretrained(
            model_name_or_path,
            min_pixels=MIN_PIXELS,
            max_pixels=MAX_PIXELS,
        )

        self.model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            model_name_or_path,
            torch_dtype=torch_dtype,
            device_map=self.device,
        )
        self.model.eval()

        # Get embedding dimension from model config
        self.embedding_dim = self.model.config.hidden_size
        logger.info(f"Model loaded. Embedding dimension: {self.embedding_dim}")

    def _format_input(
        self,
        text: Optional[str] = None,
        image: Optional[Union[str, Image.Image]] = None,
        instruction: str = DEFAULT_INSTRUCTION,
    ) -> List[Dict]:
        """Format input for the model as a conversation."""
        content = []

        # Add image if provided
        if image is not None:
            if isinstance(image, str):
                content.append({"type": "image", "image": image})
            elif isinstance(image, Image.Image):
                content.append({"type": "image", "image": image})

        # Add text if provided
        if text:
            content.append({"type": "text", "text": text})

        # Build conversation format
        messages = [
            {"role": "system", "content": instruction},
            {"role": "user", "content": content},
        ]

        return messages

    def _decode_base64_image(self, data: str) -> Image.Image:
        """Decode base64 image data."""
        # Handle data URL format
        if data.startswith("data:"):
            # Extract base64 part after comma
            data = data.split(",", 1)[1]

        image_bytes = base64.b64decode(data)
        return Image.open(io.BytesIO(image_bytes)).convert("RGB")

    @torch.no_grad()
    def embed(
        self,
        inputs: List[Dict[str, Any]],
        normalize: bool = True,
        dimensions: Optional[int] = None,
    ) -> np.ndarray:
        """
        Generate embeddings for a batch of inputs.

        Args:
            inputs: List of dicts with optional 'text' and 'image' keys.
                    Image can be a URL, file path, or base64 string.
            normalize: Whether to L2 normalize embeddings.
            dimensions: Optional output dimensions (uses MRL truncation).

        Returns:
            numpy array of embeddings with shape (batch_size, dimensions)
        """
        all_embeddings = []

        for inp in inputs:
            text = inp.get("text")
            image_data = inp.get("image")

            # Process image if provided
            image = None
            if image_data:
                if isinstance(image_data, str):
                    if image_data.startswith("data:") or len(image_data) > 500:
                        # Likely base64
                        image = self._decode_base64_image(image_data)
                    elif image_data.startswith(("http://", "https://", "file://")):
                        # URL or file path
                        image = image_data
                    else:
                        # Assume it's a file path
                        image = f"file://{image_data}"

            # Format as conversation
            messages = self._format_input(text=text, image=image)

            # Apply chat template
            prompt = self.processor.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=False,
            )

            # Process vision info
            image_inputs, video_inputs = process_vision_info(messages)

            # Prepare model inputs
            model_inputs = self.processor(
                text=[prompt],
                images=image_inputs,
                videos=video_inputs,
                padding=True,
                return_tensors="pt",
            )
            model_inputs = {k: v.to(self.device) for k, v in model_inputs.items()}

            # Forward pass
            outputs = self.model(**model_inputs, output_hidden_states=True)

            # Get last hidden state and pool using last token
            hidden_state = outputs.hidden_states[-1]
            attention_mask = model_inputs.get("attention_mask")

            # Last token pooling
            if attention_mask is not None:
                # Find last valid token position
                seq_lengths = attention_mask.sum(dim=1) - 1
                batch_indices = torch.arange(hidden_state.shape[0], device=hidden_state.device)
                embedding = hidden_state[batch_indices, seq_lengths]
            else:
                # Use last token
                embedding = hidden_state[:, -1]

            all_embeddings.append(embedding)

        # Stack all embeddings
        embeddings = torch.cat(all_embeddings, dim=0)

        # Truncate dimensions if requested (MRL)
        if dimensions and dimensions < embeddings.shape[-1]:
            embeddings = embeddings[..., :dimensions]

        # Normalize if requested
        if normalize:
            embeddings = F.normalize(embeddings, p=2, dim=-1)

        return embeddings.cpu().numpy()


# FastAPI app
app = FastAPI(
    title="Qwen3-VL-Embedding Service",
    description="Multimodal embedding service using Qwen3-VL-Embedding-2B",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global embedder instance
embedder: Optional[Qwen3VLEmbedder] = None


class EmbeddingInput(BaseModel):
    text: Optional[str] = None
    image: Optional[str] = None  # URL, file path, or base64


class EmbedRequest(BaseModel):
    inputs: List[EmbeddingInput]
    normalize: bool = True
    dimensions: Optional[int] = None  # For MRL truncation


class EmbedResponse(BaseModel):
    embeddings: List[List[float]]
    dimensions: int


class HealthResponse(BaseModel):
    status: str
    model: str
    device: str
    embedding_dim: int


@app.get("/health", response_model=HealthResponse)
async def health():
    """Health check endpoint."""
    if embedder is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    return HealthResponse(
        status="healthy",
        model="Qwen3-VL-Embedding-2B",
        device=embedder.device,
        embedding_dim=embedder.embedding_dim,
    )


@app.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest):
    """Generate embeddings for text and/or images."""
    if embedder is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    if not request.inputs:
        raise HTTPException(status_code=400, detail="No inputs provided")

    try:
        # Convert Pydantic models to dicts
        inputs = [inp.model_dump() for inp in request.inputs]

        # Generate embeddings
        embeddings = embedder.embed(
            inputs,
            normalize=request.normalize,
            dimensions=request.dimensions,
        )

        dimensions = embeddings.shape[-1] if len(embeddings.shape) > 1 else embedder.embedding_dim

        return EmbedResponse(
            embeddings=embeddings.tolist(),
            dimensions=dimensions,
        )
    except Exception as e:
        logger.exception("Error generating embeddings")
        raise HTTPException(status_code=500, detail=str(e))


# OpenAI-compatible endpoint for drop-in replacement
class OpenAIEmbedRequest(BaseModel):
    input: Union[str, List[str]]
    model: str = "qwen3-vl-embedding"


class OpenAIEmbedResponse(BaseModel):
    object: str = "list"
    data: List[Dict[str, Any]]
    model: str
    usage: Dict[str, int]


@app.post("/v1/embeddings", response_model=OpenAIEmbedResponse)
async def openai_embed(request: OpenAIEmbedRequest):
    """OpenAI-compatible embeddings endpoint (text only)."""
    if embedder is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    # Handle single string or list
    texts = [request.input] if isinstance(request.input, str) else request.input

    try:
        inputs = [{"text": t} for t in texts]
        embeddings = embedder.embed(inputs, normalize=True)

        data = [
            {"object": "embedding", "index": i, "embedding": emb.tolist()}
            for i, emb in enumerate(embeddings)
        ]

        return OpenAIEmbedResponse(
            data=data,
            model=request.model,
            usage={"prompt_tokens": sum(len(t.split()) for t in texts), "total_tokens": sum(len(t.split()) for t in texts)},
        )
    except Exception as e:
        logger.exception("Error generating embeddings")
        raise HTTPException(status_code=500, detail=str(e))


def main():
    global embedder

    parser = argparse.ArgumentParser(description="Qwen3-VL-Embedding Service")
    parser.add_argument("--model", type=str, default="Qwen/Qwen3-VL-Embedding-2B", help="Model name or path")
    parser.add_argument("--port", type=int, default=8082, help="Port to run on")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--device", type=str, default=None, help="Device (cuda, cpu)")
    args = parser.parse_args()

    # Load model
    embedder = Qwen3VLEmbedder(args.model, device=args.device)

    # Run server
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
