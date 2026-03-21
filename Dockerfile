# Stage 1: build
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npm run build

# Stage 2: runtime (production deps only)
FROM node:20-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV MCP_HTTP_PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/mcp-server.js"]
