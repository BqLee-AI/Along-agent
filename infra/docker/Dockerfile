FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad AS harness-toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl unzip binutils gcc g++ libc6-dev libssl3t64 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY apps/harness/artifacts.lock apps/harness/artifacts.lock
COPY scripts/prepare-harness.sh scripts/prepare-harness.sh
RUN bash scripts/prepare-harness.sh

FROM harness-toolchain AS harness-native
COPY apps/harness/cjpm.toml apps/harness/cjpm.lock apps/harness/
COPY apps/harness/src apps/harness/src
COPY scripts/build-harness.sh scripts/build-harness.sh
RUN bash scripts/build-harness.sh --inside-builder

FROM scratch AS harness-artifact
COPY --from=harness-native /out/ /

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895

WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/stream-protocol/package.json packages/stream-protocol/
COPY packages/time-core/package.json packages/time-core/
COPY packages/scheduler-core/package.json packages/scheduler-core/
COPY packages/notifier-core/package.json packages/notifier-core/
COPY scripts/package.json scripts/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:api
COPY --from=harness-native /out/ /app/harness/
ENV HARNESS_BINARY=/app/harness/bin/along-harness
ENV HARNESS_LIBRARY_PATH=/app/harness/lib

ENV ROLE=all
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "apps/api/dist/main.js"]
