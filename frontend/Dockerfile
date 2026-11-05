# FlowBoard frontend image: builds the Vite SPA with pnpm, then serves it with nginx.
# nginx also reverse-proxies /api, /admin and /static to the Django container, so the browser sees one origin.
# Build:  docker build -t flowboard-frontend ./frontend

FROM node:24-alpine AS build
WORKDIR /app
ENV CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:1.29-alpine AS runtime
# BACKEND_UPSTREAM is substituted into the template by the nginx image's entrypoint at start-up.
ENV BACKEND_UPSTREAM=backend:8000
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
    CMD wget -q --spider http://127.0.0.1/healthz || exit 1
