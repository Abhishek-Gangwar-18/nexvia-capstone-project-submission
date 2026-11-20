# Vendora API image
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

# Install production dependencies first so this layer is cached between code changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p uploads && chown node:node uploads
USER node
EXPOSE 5050
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://127.0.0.1:${PORT:-5050}/health || exit 1
CMD ["node", "src/index.ts"]
