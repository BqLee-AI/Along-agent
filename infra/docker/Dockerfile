FROM oven/bun:1.4.2

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

ENV ROLE=all
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "apps/api/dist/main.js"]
