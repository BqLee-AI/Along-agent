"""Fixed service invocation. The image contains no model weights or business secrets."""

import sys

import uvicorn

if len(sys.argv) != 1:
    raise SystemExit("This service does not accept runtime/model arguments")
# One Uvicorn process owns exactly one ORT CPU session. No worker/reload knobs.
uvicorn.run("service:app", host="0.0.0.0", port=8080, workers=1, reload=False,
            access_log=False, log_level="info", timeout_graceful_shutdown=30)
