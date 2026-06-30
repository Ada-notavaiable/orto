# syntax=docker/dockerfile:1.6
# Immagine multi-arch (linux/amd64, linux/arm64, linux/arm/v7).
# Target: Orange Pi Zero (Allwinner H2+, 256-512MB RAM).
FROM node:20-alpine

LABEL org.opencontainers.image.title="OrtPWA" \
      org.opencontainers.image.description="PWA per tracciare il peso degli ortaggi raccolti" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# su-exec (~10KB) per drop-privileges dal root di boot all'utente "node"
RUN apk add --no-cache su-exec

# Dipendenze npm in layer separato (cache-friendly sui rebuild)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev \
 && npm cache clean --force

# Codice applicativo + entrypoint
COPY server.js entrypoint.sh ./
COPY public/ ./public/
RUN chmod +x entrypoint.sh

# Directory dati (a runtime montata dal volume Docker)
RUN mkdir -p /data

# Default user dell'immagine: node (uid 1000)
# L'entrypoint fa il chown di /data e poi droppa a "node"

# Defaults sovrascrivibili da docker-compose / Portainer
ENV PORT=3000 \
    DB_PATH=/data/orto.db \
    NODE_ENV=production

EXPOSE 3000

# Healthcheck: GET /api/stats via Node stesso (no extra deps).
# Verifica anche che il DB sia raggiungibile (lo 200 implica DB ok).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/api/stats',r=>process.exit(r.statusCode?0:1)).on('error',()=>process.exit(1))"

# Entrypoint: chown /data poi drop a node (gestisce volume freschi)
ENTRYPOINT ["/app/entrypoint.sh"]

# Limite heap V8 = 128MB. Su Orange Pi Zero (256MB) lascia headroom per OS/Dockerd.
CMD ["node", "--max-old-space-size=128", "server.js"]
