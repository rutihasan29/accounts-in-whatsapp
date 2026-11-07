FROM node:22-bookworm-slim

# Install system dependencies required for Puppeteer / Chromium & audio tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
    ffmpeg \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libgbm1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# Copy dependency manifests first for build caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Expose web dashboard port
EXPOSE 3050

CMD ["node", "index.js"]
