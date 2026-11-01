"""Private single-process, fixed-asset CPU encoder (run with the Docker command)."""

import os

# Set before transformers import: even installed optional frameworks must not load.
os.environ.update(USE_TORCH="0", USE_TF="0", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                  TOKENIZERS_PARALLELISM="false")

import asyncio
import hashlib
import logging
import sys
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import resource
from pathlib import Path
from typing import Literal

import numpy as np
import psutil
import onnxruntime as ort
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from transformers import AutoTokenizer

from manifest import GRAPH, verify_manifest

logger = logging.getLogger("embedding")


class EncodeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    binding_sha256: str = Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]{64}$")
    text: str
    max_tokens: Literal[256]
    truncate: Literal[False]

    @field_validator("max_tokens", "truncate", mode="before")
    @classmethod
    def exact_literals(cls, value, info):
        expected_type = int if info.field_name == "max_tokens" else bool
        if type(value) is not expected_type:
            raise ValueError("Literal must have its exact JSON type")
        return value


class EncodeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    binding_sha256: str
    token_count: int
    dimension: Literal[512] = 512
    vector: list[float]


class Refusal(Exception):
    def __init__(self, status, code, **details):
        self.status, self.code, self.details = status, code, details


def normalized(text):
    whitespace = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
    return unicodedata.normalize("NFC", text.replace("\r\n", "\n")).strip(whitespace)


def unit_cls(hidden, count):
    hidden = np.asarray(hidden, dtype=np.float32)
    if hidden.shape != (1, count, 512):
        raise ValueError("Unexpected graph output shape")
    vector = hidden[0, 0, :]
    norm = np.linalg.norm(vector)
    if not np.isfinite(vector).all() or not np.isfinite(norm) or norm <= 0:
        raise ValueError("Nonfinite/zero embedding")
    vector = vector / norm
    if vector.shape != (512,) or not np.isfinite(vector).all():
        raise ValueError("Invalid normalized embedding")
    return vector.tolist()


class Encoder:
    def __init__(self, assets, manifest):
        start = time.perf_counter()
        self.manifest, self.binding = verify_manifest(manifest, assets)
        self.lock = threading.Lock()
        self.inflight = self.high_water = self.forwards = self.completed = self.disconnected = 0
        self.last_token_ids_sha256 = None
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="encode")
        self.tokenizer = AutoTokenizer.from_pretrained(str(assets), local_files_only=True, trust_remote_code=False)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.session = ort.InferenceSession(str(assets / "onnx/model_int8.onnx"),
                                            sess_options=options, providers=["CPUExecutionProvider"])
        describe = lambda items: [{"name": x.name, "type": x.type, "shape": x.shape} for x in items]
        if ({"inputs": describe(self.session.get_inputs()), "outputs": describe(self.session.get_outputs())} != GRAPH
                or self.session.get_providers() != ["CPUExecutionProvider"] or "torch" in sys.modules):
            raise ValueError("Runtime graph/provider/framework differs from manifest")
        self.encode("预热")
        self.cold_start_ms = (time.perf_counter() - start) * 1000

    def submit(self, text):
        # Capacity belongs to real work, not the lifetime of the HTTP awaiter.
        with self.lock:
            if self.inflight >= 2:
                raise Refusal(429, "CAPACITY")
            self.inflight += 1
            self.high_water = max(self.high_water, self.inflight)
        try:
            future = self.pool.submit(self.encode, text)
        except BaseException:
            with self.lock:
                self.inflight -= 1
            raise
        future.add_done_callback(self.release)
        return future

    def release(self, future):
        with self.lock:
            self.inflight -= 1
            self.completed += 1

    def encode(self, text):
        batch = self.tokenizer(normalized(text), add_special_tokens=True, truncation=False,
                               padding=False, return_tensors="np")
        count = int(batch["input_ids"].shape[1])
        if count > 256:
            raise Refusal(422, "TOKEN_LIMIT_EXCEEDED", token_count=count)
        feed = {item["name"]: np.asarray(batch[item["name"]], dtype=np.int64) for item in GRAPH["inputs"]}
        with self.lock:
            self.forwards += 1
            self.last_token_ids_sha256 = hashlib.sha256(feed["input_ids"].astype("<i8").tobytes()).hexdigest()
        hidden = self.session.run(["last_hidden_state"], feed)[0]
        return EncodeResponse(binding_sha256=self.binding, token_count=count, vector=unit_cls(hidden, count))

    def diagnostics(self):
        with self.lock:
            return {"binding_sha256": self.binding, "ready": True, "inflight": self.inflight,
                    "max_inflight": 2, "high_water": self.high_water, "forward_count": self.forwards,
                    "completed": self.completed, "disconnected": self.disconnected,
                    "last_token_ids_sha256": self.last_token_ids_sha256,
                    "torch_imported": "torch" in sys.modules, "cold_start_ms": self.cold_start_ms,
                    "distribution_license": "not_declared", "production_license_cleared": False,
                    "rss_bytes": psutil.Process().memory_info().rss,
                    "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
                    "process_cpu_seconds": time.process_time()}


@asynccontextmanager
async def lifespan(app):
    assets = Path("/assets")
    app.state.encoder = Encoder(assets, assets / "encoding-manifest.json")
    try:
        yield
    finally:
        # Wait for uninterruptible work before releasing the single process/session.
        app.state.encoder.pool.shutdown(wait=True, cancel_futures=False)


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(Refusal)
async def refusal_handler(request, exc):
    return JSONResponse(status_code=exc.status, content={"code": exc.code, **exc.details})


@app.exception_handler(RequestValidationError)
async def invalid_request(request, exc):
    # Never echo input text into an error or request log.
    return JSONResponse(status_code=422, content={"code": "INVALID_REQUEST"})


@app.get("/readyz")
async def ready(request: Request):
    return request.app.state.encoder.diagnostics()


@app.post("/encode", response_model=EncodeResponse)
async def encode(body: EncodeRequest, request: Request):
    encoder = request.app.state.encoder
    if body.binding_sha256 != encoder.binding:
        raise Refusal(409, "BINDING_MISMATCH")
    future = asyncio.wrap_future(encoder.submit(body.text))
    # Consume detached failures without cancelling the underlying concurrent future.
    future.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
    try:
        while not future.done():
            if await request.is_disconnected():
                with encoder.lock:
                    encoder.disconnected += 1
                raise HTTPException(status_code=499, detail="CLIENT_DISCONNECTED")
            await asyncio.wait({future}, timeout=0.005)
        return future.result()
    except (Refusal, HTTPException, asyncio.CancelledError):
        raise
    except Exception:
        logger.exception("Fixed encoder failed")
        raise Refusal(500, "ENCODING_FAILED") from None
