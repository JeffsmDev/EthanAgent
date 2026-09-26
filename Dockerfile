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

# ---------- whisper: voz → texto en el propio servidor (funciona en cualquier navegador, sin API ni coste) ----------
# Misma base que el runtime para enlazar la misma musl/libstdc++. AVX2 explícito (GGML_NATIVE=OFF) para que el
# binario no dependa de la CPU donde se compila. Modelo: base.en (rápido en 2 vCPU); small.en = más preciso y ~3× lento
FROM node:22-alpine AS whisper
ARG WHISPER_CPP_VERSION=v1.9.4
ARG WHISPER_MODEL=base.en
RUN apk add --no-cache build-base cmake git bash curl
RUN git clone --depth 1 --branch ${WHISPER_CPP_VERSION} https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
      -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_OPENMP=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
 && cmake --build build -j"$(nproc)" --target whisper-cli \
 && mkdir -p /models \
 && bash ./models/download-ggml-model.sh ${WHISPER_MODEL} /models \
 && mv /models/ggml-${WHISPER_MODEL}.bin /models/whisper-model.bin

# ---------- runtime: imagen mínima, usuario sin privilegios ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/app/packages/backend/data \
    FRONTEND_DIST=/app/packages/frontend/dist \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    DISABLE_AUTOUPDATER=1
WORKDIR /app

# Claude Code CLI: motor "claude" (usa la suscripción vía CLAUDE_CODE_OAUTH_TOKEN). Versión fijada: se actualiza
# reconstruyendo con --build-arg CLAUDE_CODE_VERSION=x.y.z. El paquete trae el binario nativo (incluye musl)
ARG CLAUDE_CODE_VERSION=2.1.283
# (aquí aún no hay package.json: se fija la versión de pnpm o corepack usaría la última)
RUN corepack enable \
 && corepack install -g pnpm@10.31.0 \
 && pnpm add -g --allow-build=@anthropic-ai/claude-code @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && claude --version

COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /models/whisper-model.bin /opt/whisper/whisper-model.bin
ENV WHISPER_BIN=/usr/local/bin/whisper-cli \
    WHISPER_MODEL_PATH=/opt/whisper/whisper-model.bin

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
