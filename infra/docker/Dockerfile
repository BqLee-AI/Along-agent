FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad AS harness-toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl unzip binutils gcc g++ libc6-dev libssl3t64 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY apps/harness/artifacts.lock apps/harness/artifacts.lock
COPY scripts/prepare-harness.sh scripts/prepare-harness.sh
RUN --mount=type=cache,id=along-harness-downloads,target=/opt/along-toolchain/downloads,sharing=locked \
    bash scripts/prepare-harness.sh

FROM harness-toolchain AS harness-native
COPY apps/harness/cjpm.toml apps/harness/cjpm.lock apps/harness/
COPY apps/harness/src apps/harness/src
COPY scripts/build-harness.sh scripts/build-harness.sh
RUN bash scripts/build-harness.sh

FROM scratch AS harness-artifact
COPY --from=harness-native /out/ /

FROM harness-toolchain AS host-native
COPY apps/host/cjpm.toml apps/host/cjpm.lock apps/host/
COPY apps/host/src apps/host/src
COPY apps/host/signal.c apps/host/signal.c
RUN bash -ec '\
    source /opt/along-toolchain/cangjie/envsetup.sh; \
    cd /src/apps/host; \
    gcc -O2 -c signal.c -o /tmp/along_host_signal.o; \
    ar rcs /tmp/libalong_host_signal.a /tmp/along_host_signal.o; \
    cjpm build --skip-script -o along-host; \
    install -Dm755 target/release/bin/along-host /out/bin/along-host; \
    mkdir -p /out/lib; \
    export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:/opt/along-toolchain/stdx/linux_x86_64_cjnative/dynamic/stdx"; \
    ldd /out/bin/along-host | while read -r lib arrow path rest; do \
      if [[ "$arrow" == "=>" && "$path" == /opt/along-toolchain/* ]]; then cp -L "$path" "/out/lib/$lib"; fi; \
    done'

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS api-runtime

WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/web/vendor apps/web/vendor
COPY packages/contracts/package.json packages/contracts/
COPY packages/stream-protocol/package.json packages/stream-protocol/
COPY packages/time-core/package.json packages/time-core/
COPY packages/scheduler-core/package.json packages/scheduler-core/
COPY packages/notifier-core/package.json packages/notifier-core/
COPY scripts/package.json scripts/
RUN --mount=type=cache,id=along-bun-downloads,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile
# Only compiler inputs invalidate the API build; runtime assets/tests follow it.
COPY tsconfig.base.json ./
COPY packages/contracts/tsconfig.json packages/contracts/
COPY packages/contracts/src packages/contracts/src
COPY packages/stream-protocol/tsconfig.json packages/stream-protocol/
COPY packages/stream-protocol/src packages/stream-protocol/src
COPY packages/time-core/tsconfig.json packages/time-core/
COPY packages/time-core/src packages/time-core/src
COPY packages/scheduler-core/tsconfig.json packages/scheduler-core/
COPY packages/scheduler-core/src packages/scheduler-core/src
COPY packages/notifier-core/tsconfig.json packages/notifier-core/
COPY packages/notifier-core/src packages/notifier-core/src
COPY apps/api/tsconfig.json apps/api/
COPY apps/api/src apps/api/src
RUN bun run build:api
COPY . .
COPY --from=harness-native /out/ /app/harness/
ENV HARNESS_BINARY=/app/harness/bin/along-harness
ENV HARNESS_LIBRARY_PATH=/app/harness/lib

ENV ROLE=all
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "apps/api/dist/main.js"]

FROM api-runtime AS host-runtime
COPY --from=host-native /out/ /app/host/
# stdx loads the unversioned OpenSSL name dynamically.
RUN ln -s /usr/lib/x86_64-linux-gnu/libssl.so.3 /app/host/lib/libssl.so
ENV LD_LIBRARY_PATH=/app/host/lib
CMD ["sh", "/app/apps/host/container-start.sh"]

FROM host-runtime AS release
