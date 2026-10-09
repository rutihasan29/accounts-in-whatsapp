#!/usr/bin/env bash
# Build script for Render.com Native Node.js Environment
set -o errexit

echo "📦 Installing project dependencies..."
npm install

echo "🌐 Installing Chromium for Puppeteer in Render environment..."
npx puppeteer browsers install chrome || true

echo "✅ Build completed successfully!"
