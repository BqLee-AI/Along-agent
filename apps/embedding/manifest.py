"""Frozen BGE encoding contract; no request-selectable assets or backends."""

import hashlib
import json
from importlib.metadata import version
from pathlib import Path

MODEL_ID = "Xenova/bge-small-zh-v1.5"
REVISION = "75c43b069aac4d136ba6bc1122f995fedcfd2781"
ASSETS = {
    "config.json": (716, "d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f"),
    "onnx/model_int8.onnx": (23903394, "b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5"),
    "quantize_config.json": (674, "2cc488b20fa05fe86aba2fdc2be44d24827e11e2b7c7a0753d1427da6797b46f"),
    "special_tokens_map.json": (125, "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3"),
    "tokenizer.json": (439125, "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26"),
    "tokenizer_config.json": (367, "e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a"),
    "vocab.txt": (109540, "45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c"),
}
AUXILIARY_FILES = {"encoding-manifest.json", "license-evidence.json", "quantized-repository.json",
                   "quantized-card.txt", "base-repository.json", "base-card.txt"}
GRAPH = {
    "inputs": [{"name": name, "type": "tensor(int64)", "shape": ["batch_size", "sequence_length"]}
               for name in ("input_ids", "attention_mask", "token_type_ids")],
    "outputs": [{"name": "last_hidden_state", "type": "tensor(float)",
                 "shape": ["batch_size", "sequence_length", 512]}],
}
ENCODING = {
    "normalization": ["CRLF_to_LF", "NFC", "strip_ecmascript_whitespace"],
    "prefix": "", "special_tokens": True, "max_tokens": 256, "truncate": False,
    "pooling": "last_hidden_state[:,0,:]", "dtype": "float32", "dimension": 512,
    "normalization_output": "L2_float32", "batch_size": 1,
    "provider": "CPUExecutionProvider", "execution_mode": "ORT_SEQUENTIAL",
    "intra_op_threads": 4, "inter_op_threads": 1, "sessions": 1, "max_inflight": 2,
}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_assets(root):
    root = Path(root).resolve(strict=True)
    allowed = set(ASSETS) | AUXILIARY_FILES
    for path in root.rglob("*"):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink() or (not path.is_dir() and relative not in allowed):
            raise ValueError(f"Unmanifested asset: {relative}")
    for name, (size, digest) in ASSETS.items():
        path = root / name
        if path.is_symlink() or not path.resolve(strict=True).is_relative_to(root):
            raise ValueError(f"Unsafe asset: {name}")
        if path.stat().st_size != size or sha256(path) != digest:
            raise ValueError(f"Asset hash/size mismatch: {name}")


def verify_manifest(manifest_path, asset_root):
    manifest = json.loads(Path(manifest_path).read_text("utf-8"))
    verify_assets(asset_root)
    expected_files = [{"path": name, "bytes": size, "sha256": digest,
                       "license_evidence": "license-evidence.json"}
                      for name, (size, digest) in sorted(ASSETS.items())]
    if (manifest["model"] != {"id": MODEL_ID, "revision": REVISION}
            or manifest["files"] != expected_files or manifest["graph"] != GRAPH
            or manifest["encoding"] != ENCODING):
        raise ValueError("Manifest does not describe the fixed encoding")
    if manifest["dependencies"] != {name: version(name) for name in manifest["dependencies"]}:
        raise ValueError("Runtime dependency versions differ from manifest")
    from licenses import inventory
    license_inventory = Path(__file__).parent / "dependency-licenses.json"
    if (sha256(license_inventory) != manifest["dependency_licenses_sha256"]
            or json.loads(license_inventory.read_text("utf-8")) != inventory()):
        raise ValueError("Dependency license metadata/notices differ from manifest")
    evidence_path = Path(asset_root) / "license-evidence.json"
    if sha256(evidence_path) != manifest["license_evidence_sha256"]:
        raise ValueError("License evidence hash mismatch")
    evidence = json.loads(evidence_path.read_text("utf-8"))
    if evidence["distribution"]["revision"] != REVISION or evidence["distribution"]["license"] != "not_declared":
        raise ValueError("Unexpected distribution license evidence")
    for item in evidence["sources"]:
        path = Path(asset_root) / item["path"]
        if not path.resolve(strict=True).is_relative_to(Path(asset_root).resolve()):
            raise ValueError("Unsafe license evidence path")
        if sha256(path) != item["sha256"] or path.stat().st_size != item["bytes"]:
            raise ValueError("License source hash/size mismatch")
    return manifest, hashlib.sha256(canonical(manifest)).hexdigest()
