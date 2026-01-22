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

# Production image
FROM node:20-alpine

WORKDIR /app/server

# Copy package files and install production deps only
COPY server/package*.json ./
RUN npm ci --only=production

# Copy built files
COPY --from=builder /app/server/dist ./dist

# Copy static files to parent dir (where http.ts expects them)
COPY index.html prompt.html setup.html profile.html entry.html dashboard.html join.html settings.html connect.html /app/

EXPOSE 3000

CMD ["node", "dist/http.js"]
