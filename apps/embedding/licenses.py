"""Capture exact installed-package license metadata and bundled notice hashes."""

import hashlib
import json
from importlib.metadata import distributions
from pathlib import Path


def inventory():
    result = []
    for dist in sorted(distributions(), key=lambda item: item.metadata["Name"].lower()):
        notices = []
        for item in dist.files or []:
            name = str(item)
            upper = name.upper()
            if ".DIST-INFO/" not in upper or not any(word in upper for word in ("LICENSE", "COPYING", "NOTICE")):
                continue
            path = Path(dist.locate_file(item))
            if path.is_file():
                data = path.read_bytes()
                notices.append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        result.append({"name": dist.metadata["Name"], "version": dist.version,
                       "license_expression": dist.metadata.get("License-Expression"),
                       "license": dist.metadata.get("License"),
                       "classifiers": [value for value in dist.metadata.get_all("Classifier", [])
                                       if value.startswith("License ::")], "notices": notices})
    return result


if __name__ == "__main__":
    print(json.dumps(inventory(), ensure_ascii=False, indent=2))
