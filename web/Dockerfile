# Build and package the web portal as a self-contained standalone server.
# The builder stage compiles the app; the runner only ships .next/standalone,
# which Next.js produces with `output: "standalone"` (see next.config.ts).
FROM node:22-alpine AS base
WORKDIR /app

# Install production dependencies (package.json + lockfile only, so this layer
# is cached until the manifest changes).
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# Compile the app.
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Minimal runtime image.
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
# Standalone output bundles the traced server and node_modules; public and
# static must be copied alongside it (see output.md in the Next.js docs).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Run the standalone server as the non-root `node` user built into node:alpine.
USER node
EXPOSE 3000
CMD ["node", "server.js"]
