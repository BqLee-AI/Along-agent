"""Build the canonical fixed-asset manifest inside the pinned Linux dependency image."""

import argparse
import hashlib
import json
from importlib.metadata import distributions
from pathlib import Path

from manifest import ASSETS, ENCODING, GRAPH, MODEL_ID, REVISION, canonical, sha256, verify_assets


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", type=Path, required=True)
    args = parser.parse_args()
    verify_assets(args.assets)
    evidence = args.assets / "license-evidence.json"
    manifest = {
        "revision": "r2b-encoding/1",
        "model": {"id": MODEL_ID, "revision": REVISION},
        "files": [{"path": name, "bytes": size, "sha256": digest,
                   "license_evidence": "license-evidence.json"}
                  for name, (size, digest) in sorted(ASSETS.items())],
        "graph": GRAPH, "encoding": ENCODING,
        "dependencies": dict(sorted((dist.metadata["Name"], dist.version) for dist in distributions())),
        "license_evidence_sha256": sha256(evidence),
        "license_status": {"base_model": "MIT", "quantized_distribution": "not_declared",
                           "production_distribution_cleared": False},
        "dependency_licenses_sha256": sha256(Path(__file__).parent / "dependency-licenses.json"),
    }
    binding = hashlib.sha256(canonical(manifest)).hexdigest()
    (args.assets / "encoding-manifest.json").write_bytes(canonical(manifest) + b"\n")
    print(json.dumps({"binding_sha256": binding, "manifest": str(args.assets / "encoding-manifest.json")}))


if __name__ == "__main__":
    main()
