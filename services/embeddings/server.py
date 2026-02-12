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
import unicodedata
from typing import Any, Dict, List, Optional, Union
from dataclasses import dataclass

import numpy as np
import torch
import torch.nn.functional as F
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel
from transformers.models.qwen3_vl.modeling_qwen3_vl import Qwen3VLPreTrainedModel, Qwen3VLModel, Qwen3VLConfig
from transformers.models.qwen3_vl.processing_qwen3_vl import Qwen3VLProcessor
from transformers.modeling_outputs import ModelOutput
from qwen_vl_utils.vision_process import process_vision_info

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
MAX_LENGTH = 8192
IMAGE_BASE_FACTOR = 16
IMAGE_FACTOR = IMAGE_BASE_FACTOR * 2
MIN_PIXELS = 4 * IMAGE_FACTOR * IMAGE_FACTOR
MAX_PIXELS = 1800 * IMAGE_FACTOR * IMAGE_FACTOR
DEFAULT_INSTRUCTION = "Represent the input for retrieval."


@dataclass
class Qwen3VLForEmbeddingOutput(ModelOutput):
    """Output structure for embeddings."""
    last_hidden_state: Optional[torch.FloatTensor] = None
    attention_mask: Optional[torch.Tensor] = None


class Qwen3VLForEmbedding(Qwen3VLPreTrainedModel):
    """Model class to compute embeddings from Qwen3-VL."""
    _checkpoint_conversion_mapping = {}
    accepts_loss_kwargs = False
    config: Qwen3VLConfig

    def __init__(self, config):
        super().__init__(config)
        self.model = Qwen3VLModel(config)
        self.post_init()

    def get_input_embeddings(self):
        return self.model.get_input_embeddings()

    def set_input_embeddings(self, value):
        self.model.set_input_embeddings(value)

    def get_image_features(self, pixel_values: torch.FloatTensor,
                           image_grid_thw: Optional[torch.LongTensor] = None):
        return self.model.get_image_features(pixel_values, image_grid_thw)

    @property
    def language_model(self):
        return self.model.language_model

    @property
    def visual(self):
        return self.model.visual

    def forward(
        self,
        input_ids: torch.LongTensor = None,
        attention_mask: Optional[torch.Tensor] = None,
        position_ids: Optional[torch.LongTensor] = None,
        past_key_values=None,
        inputs_embeds: Optional[torch.FloatTensor] = None,
        pixel_values: Optional[torch.Tensor] = None,
        pixel_values_videos: Optional[torch.FloatTensor] = None,
        image_grid_thw: Optional[torch.LongTensor] = None,
        video_grid_thw: Optional[torch.LongTensor] = None,
        cache_position: Optional[torch.LongTensor] = None,
        **kwargs,
    ) -> Qwen3VLForEmbeddingOutput:
        outputs = self.model(
            input_ids=input_ids,
            pixel_values=pixel_values,
            pixel_values_videos=pixel_values_videos,
            image_grid_thw=image_grid_thw,
            video_grid_thw=video_grid_thw,
            position_ids=position_ids,
            attention_mask=attention_mask,
            past_key_values=past_key_values,
            inputs_embeds=inputs_embeds,
            cache_position=cache_position,
            **kwargs,
        )
        return Qwen3VLForEmbeddingOutput(
            last_hidden_state=outputs.last_hidden_state,
            attention_mask=attention_mask,
        )


class Qwen3VLEmbedder:
    """Wrapper for Qwen3-VL-Embedding model."""

    def __init__(
        self,
        model_name_or_path: str,
        max_length: int = MAX_LENGTH,
        min_pixels: int = MIN_PIXELS,
        max_pixels: int = MAX_PIXELS,
        default_instruction: str = DEFAULT_INSTRUCTION,
        **kwargs,
    ):
        logger.info(f"Loading model {model_name_or_path}...")

        self.max_length = max_length
        self.min_pixels = min_pixels
        self.max_pixels = max_pixels
        self.default_instruction = default_instruction

        # Note: CUDA has issues with M-RoPE position embeddings in this model
        # CPU works fine and keeps VRAM free for the main LLM
        self.model = Qwen3VLForEmbedding.from_pretrained(
            model_name_or_path,
            trust_remote_code=True,
            torch_dtype=torch.float32,
            device_map="cpu",
            **kwargs,
        )

        self.processor = Qwen3VLProcessor.from_pretrained(
            model_name_or_path,
            padding_side="right",
        )
        self.model.eval()

        # Get actual device from model
        self.device = next(self.model.parameters()).device

        # Embedding dimension from model config
        self.embedding_dim = self.model.config.text_config.hidden_size
        logger.info(f"Model loaded. Embedding dimension: {self.embedding_dim}")

    def _decode_base64_image(self, data: str) -> Image.Image:
        """Decode base64 image data."""
        if data.startswith("data:"):
            data = data.split(",", 1)[1]
        image_bytes = base64.b64decode(data)
        return Image.open(io.BytesIO(image_bytes)).convert("RGB")

    def format_model_input(
        self,
        text: Optional[str] = None,
        image: Optional[Union[str, Image.Image]] = None,
        instruction: Optional[str] = None,
    ) -> List[Dict]:
        """Format input for the model as a conversation."""
        instruction = instruction or self.default_instruction
        instruction = instruction.strip()
        if instruction and not unicodedata.category(instruction[-1]).startswith("P"):
            instruction = instruction + "."

        content = []
        conversation = [
            {"role": "system", "content": [{"type": "text", "text": instruction}]},
            {"role": "user", "content": content},
        ]

        if not text and not image:
            content.append({"type": "text", "text": "NULL"})
            return conversation

        if image:
            if isinstance(image, Image.Image):
                image_content = image
            elif isinstance(image, str):
                if image.startswith(("http://", "https://")):
                    image_content = image
                else:
                    image_content = "file://" + image
            else:
                raise TypeError(f"Unrecognized image type: {type(image)}")

            content.append({
                "type": "image",
                "image": image_content,
                "min_pixels": self.min_pixels,
                "max_pixels": self.max_pixels,
            })

        if text:
            content.append({"type": "text", "text": text})

        return conversation

    def _preprocess_inputs(self, conversation: List[Dict], has_vision: bool = False) -> Dict[str, torch.Tensor]:
        """Preprocess a single conversation for model consumption."""
        text = self.processor.apply_chat_template(
            conversation,
            add_generation_prompt=True,
            tokenize=False,
        )

        # Always call process_vision_info - it handles text-only gracefully
        images = None
        videos = None
        video_metadata = None
        video_kwargs = {}

        try:
            images, video_inputs, video_kwargs = process_vision_info(
                [conversation],
                image_patch_size=16,
                return_video_metadata=True,
                return_video_kwargs=True,
            )
            if video_inputs is not None:
                videos, video_metadata = zip(*video_inputs)
                videos = list(videos)
                video_metadata = list(video_metadata)
        except Exception as e:
            logger.error(f"Error in processing vision info: {e}")
            video_kwargs = {}

        inputs = self.processor(
            text=[text],
            images=images,
            videos=videos,
            video_metadata=video_metadata,
            truncation=True,
            max_length=self.max_length,
            padding=True,
            return_tensors="pt",
            **video_kwargs,
        )

        # For text-only, don't pass position_ids - let model compute them
        # The Qwen3VL model will generate position_ids internally if not provided

        return inputs

    @staticmethod
    def _pooling_last(hidden_state: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
        """Pool the last hidden state by attention mask."""
        flipped_tensor = attention_mask.flip(dims=[1])
        last_one_positions = flipped_tensor.argmax(dim=1)
        col = attention_mask.shape[1] - last_one_positions - 1
        row = torch.arange(hidden_state.shape[0], device=hidden_state.device)
        return hidden_state[row, col]

    @torch.no_grad()
    def embed_single(self, text: Optional[str], image: Optional[Any]) -> torch.Tensor:
        """Generate embedding for a single input."""
        conversation = self.format_model_input(text=text, image=image)
        has_vision = image is not None

        model_inputs = self._preprocess_inputs(conversation, has_vision=has_vision)

        model_inputs = {k: v.to(self.device).contiguous() for k, v in model_inputs.items()}

        outputs = self.model(**model_inputs)
        embedding = self._pooling_last(outputs.last_hidden_state, outputs.attention_mask)
        return embedding

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
                    if image_data.startswith("data:") or (
                        not image_data.startswith(("http://", "https://", "file://"))
                        and len(image_data) > 500
                    ):
                        image = self._decode_base64_image(image_data)
                    else:
                        image = image_data
                elif isinstance(image_data, Image.Image):
                    image = image_data

            embedding = self.embed_single(text, image)
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
        device=str(embedder.device),
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
        inputs = [inp.model_dump() for inp in request.inputs]
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


# OpenAI-compatible endpoint
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
            usage={
                "prompt_tokens": sum(len(t.split()) for t in texts),
                "total_tokens": sum(len(t.split()) for t in texts),
            },
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
    args = parser.parse_args()

    # Load model
    embedder = Qwen3VLEmbedder(args.model)

    # Run server
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
