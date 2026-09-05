# Start from official Node.js LTS image
FROM node:22-bullseye-slim

# Install small set of system deps needed by native modules and curl for healthcheck
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package manifest and pnpm lock to leverage Docker layer cache
COPY package.json pnpm-lock.yaml ./


RUN corepack enable \
  && corepack prepare pnpm@10.5.2 --activate \
  && pnpm install --frozen-lockfile

# Copy application source
COPY . .

# Create a non-root user and take ownership of app files
RUN groupadd -r appuser && useradd -r -g appuser -m appuser \
  && chown -R appuser:appuser /app

USER appuser

# Environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start the app using the project's start script
CMD ["sh", "-c", "pnpm start"]
