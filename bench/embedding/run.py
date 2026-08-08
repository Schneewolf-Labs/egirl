#!/usr/bin/env python3
"""Benchmark for the Qwen3-VL embedding server.

Tests: sequential single requests vs batched requests.
"""
import json
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8082"

def embed_one(text: str):
    """Send a single text embedding request."""
    body = json.dumps({
        "inputs": [{"text": text}],
        "normalize": True
    }).encode()
    req = urllib.request.Request(
        f"{BASE}/embed",
        data=body,
        headers={"Content-Type": "application/json"}
    )
    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP error {e.code}: {e.read()}")
        return None

def embed_batch(texts: list):
    """Send a batch embedding request."""
    body = json.dumps({
        "inputs": [{"text": t} for t in texts],
        "normalize": True
    }).encode()
    req = urllib.request.Request(
        f"{BASE}/embed",
        data=body,
        headers={"Content-Type": "application/json"}
    )
    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP error {e.code}: {e.read()}")
        return None

# Test texts
TEXTS = [
    "The quick brown fox jumps over the lazy dog.",
    "A fast canine leaps over a resting canine.",
    "The capital of France is Paris.",
    "Paris is the capital of France.",
    "Machine learning is a subset of artificial intelligence.",
    "Deep learning uses neural networks with many layers.",
    "Python is a popular programming language.",
    "JavaScript runs in the browser.",
]

print("=" * 60)
print("Embedding Server Benchmark")
print("=" * 60)

# Warmup
print("\n[Warmup] embedding one text...")
embed_one("warmup")

# Sequential single requests
print(f"\n[Sequential] embedding {len(TEXTS)} texts individually...")
t0 = time.time()
for t in TEXTS:
    embed_one(t)
sequential = time.time() - t0
print(f"  Total: {sequential:.3f}s")
print(f"  Per-text: {sequential / len(TEXTS):.3f}s")

# Batched request
print(f"\n[Batched] embedding {len(TEXTS)} texts in one request...")
t0 = time.time()
result = embed_batch(TEXTS)
batched = time.time() - t0
print(f"  Total: {batched:.3f}s")
print(f"  Per-text: {batched / len(TEXTS):.3f}s")

print(f"\n{'=' * 60}")
print(f"Speedup: {sequential / batched:.2f}x")
print(f"{'=' * 60}")
