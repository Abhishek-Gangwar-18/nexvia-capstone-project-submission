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
# CSP hashes for the inline <style> elements created at runtime (sonner's toasts), from the installed package.
# Fails the build if they can't be extracted, rather than shipping a CSP that breaks the toasts.
RUN node scripts/csp-style-hashes.mjs > /app/csp-style-hashes.txt

FROM nginx:1.29-alpine AS runtime
# BACKEND_UPSTREAM is substituted into the templates by the nginx image's entrypoint at start-up.
# Secure defaults: no admin access (ADMIN_ALLOWLIST empty), no trusted proxies, CSP enforced.
ENV BACKEND_UPSTREAM=backend:8000     ADMIN_ALLOWLIST=""     TRUSTED_PROXY_CIDRS=""     CSP_HEADER=Content-Security-Policy
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY proxy-backend.inc.template /etc/nginx/templates/proxy-backend.inc.template
COPY --chmod=755 docker/40-security-snippets.sh /docker-entrypoint.d/40-security-snippets.sh
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=build /app/csp-style-hashes.txt /etc/nginx/csp-style-hashes.txt
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
    CMD wget -q --spider http://127.0.0.1/healthz || exit 1
