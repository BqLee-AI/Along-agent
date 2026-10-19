FROM node:22-alpine

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/stream-protocol/package.json packages/stream-protocol/
COPY packages/time-core/package.json packages/time-core/
COPY packages/scheduler-core/package.json packages/scheduler-core/
COPY packages/notifier-core/package.json packages/notifier-core/
COPY scripts/package.json scripts/
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

ENV ROLE=all
ENV PORT=3000
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
