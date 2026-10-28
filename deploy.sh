#!/bin/bash
set -e

echo "=========================================="
echo "🚀 News Voice Bot: Pulling Latest Updates"
echo "=========================================="

# 1. Pull latest code from GitHub
git pull

# 2. Rebuild and restart the Docker container without downtime
docker compose up -d --build

echo ""
echo "✅ Container successfully updated & running!"
echo "📋 Showing live logs (Press Ctrl+C to exit):"
echo ""

# 3. Stream live logs
docker compose logs --tail=50 -f
