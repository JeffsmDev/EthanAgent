# syntax=docker/dockerfile:1
# Ethan — imagen de producción: compila frontend + backend con pnpm y corre solo el backend (que sirve el frontend)

# ---------- base: Node 22 + pnpm vía corepack (versión fijada en package.json → packageManager) ----------
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---------- build: dependencias completas + compilación ----------
FROM base AS build
# Primero solo manifiestos: la capa de dependencias se cachea mientras no cambie el lockfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm build

# ---------- prod-deps: solo dependencias de runtime del backend ----------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter backend

# ---------- runtime: imagen mínima, usuario sin privilegios ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/app/packages/backend/data \
    FRONTEND_DIST=/app/packages/frontend/dist
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/backend/node_modules ./packages/backend/node_modules
COPY packages/backend/package.json ./packages/backend/
COPY --from=build /app/packages/backend/dist ./packages/backend/dist
COPY --from=build /app/packages/frontend/dist ./packages/frontend/dist

# La carpeta de datos se monta como volumen; debe pertenecer al usuario no-root
RUN mkdir -p /app/packages/backend/data && chown -R node:node /app/packages/backend/data
USER node

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/health > /dev/null || exit 1

CMD ["node", "packages/backend/dist/server.js"]
