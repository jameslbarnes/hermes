FROM node:20-alpine AS builder

WORKDIR /app/server

# Copy package files
COPY server/package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source and build
COPY server/src/ ./src/
COPY server/tsconfig.json ./
RUN npm run build

# Build Astro frontend (index route migration)
FROM node:20-alpine AS web-builder

WORKDIR /app/web

COPY web/package.json ./
RUN npm install --no-audit --no-fund

COPY web/ ./
RUN npm run build

# Production image
FROM node:20-alpine

WORKDIR /app/server

# Copy package files and install production deps only
COPY server/package*.json ./
RUN npm ci --only=production

# Copy built files
COPY --from=builder /app/server/dist ./dist

# Copy legacy static files (except index, now built by Astro)
COPY prompt.html setup.html profile.html entry.html dashboard.html join.html settings.html connect.html release.html RELEASE_NOTES.md /app/

# Copy Astro-built index + static assets
COPY --from=web-builder /app/web/dist/index.html /app/index.html
COPY --from=web-builder /app/web/dist/styles /app/styles
COPY --from=web-builder /app/web/dist/scripts /app/scripts

EXPOSE 3000

CMD ["node", "dist/http.js"]
