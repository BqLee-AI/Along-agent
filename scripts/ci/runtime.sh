#!/usr/bin/env bash
# Own one current-tree image; consumers own their separate databases and containers.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
mode="${1:-all}"
if [[ "$mode" != all && "$mode" != contracts ]]; then
  echo 'Usage: bash scripts/ci/runtime.sh [all|contracts]' >&2
  exit 1
fi
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'Runtime checks require Linux x64 Docker; on Windows use WSL.' >&2
  exit 1
fi
owned="$(mktemp -d "${TMPDIR:-/tmp}/along-runtime.XXXXXX")"
image="along-runtime:$(basename "$owned")"
host_image="$image-host"
pids=()
cleanup() {
  local result=$?
  trap - EXIT
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  if docker image inspect "$host_image" >/dev/null 2>&1; then
    docker image rm "$host_image" >/dev/null || result=1
  fi
  if docker image inspect "$image" >/dev/null 2>&1; then
    docker image rm "$image" >/dev/null || result=1
  fi
  rmdir "$owned" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
echo '== current-tree production native build =='
if [[ -n "${CI_DOCKER_CACHE:-}" ]]; then
  cache_args=()
  if [[ -f "$CI_DOCKER_CACHE/index.json" ]]; then
    cache_args+=(--cache-from "type=local,src=$CI_DOCKER_CACHE")
  fi
  docker buildx build --load --tag "$image" --file infra/docker/Dockerfile \
    "${cache_args[@]}" --cache-to "type=local,dest=$CI_DOCKER_CACHE-next,mode=max" .
  rm -rf "$CI_DOCKER_CACHE"
  mv "$CI_DOCKER_CACHE-next" "$CI_DOCKER_CACHE"
else
  docker build --tag "$image" --file infra/docker/Dockerfile .
fi
bash scripts/ci/contracts.sh "$image" &
pids+=("$!")
if [[ "$mode" == all ]]; then
  docker build --target host-runtime --tag "$host_image" --file infra/docker/Dockerfile .
  bash scripts/ci/host-smoke.sh "$host_image" "$image" &
  pids+=("$!")
  env -u DATABASE_URL -u TZDB_VERSION \
    COMPOSE_PROJECT_NAME="along-ci-smoke-$(basename "$owned" | tr '[:upper:].' '[:lower:]-')" \
    bash scripts/ci/compose-smoke.sh "$image" &
  pids+=("$!")
fi
result=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then result=1; fi
done
pids=()
exit "$result"
