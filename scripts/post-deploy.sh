#!/bin/bash
# Post-deployment script: Updates frontend config and prepares for Vercel
# Usage: ./scripts/post-deploy.sh

set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"

echo "=== Post-Deploy: Frontend Config Update ==="
echo ""

# 1. Run bind-frontend.sh
echo "[1/5] Running bind-frontend.sh..."
cd "$ROOT_DIR/casper/scripts"
./bind-frontend.sh testnet
cd "$ROOT_DIR"
echo ""

# 2. Force update .env.local (delete old one first)
echo "[2/5] Updating .env.local..."
if [ -f "$FRONTEND_DIR/.env.local" ]; then
    rm "$FRONTEND_DIR/.env.local"
    echo "  Deleted old .env.local"
fi
if [ -f "$FRONTEND_DIR/.env.local.example" ]; then
    cp "$FRONTEND_DIR/.env.local.example" "$FRONTEND_DIR/.env.local"
    echo "  Created new .env.local from example"
fi
echo ""

# 3. Clear Next.js cache
echo "[3/5] Clearing Next.js cache..."
if [ -d "$FRONTEND_DIR/.next" ]; then
    rm -rf "$FRONTEND_DIR/.next"
    echo "  Deleted .next cache"
else
    echo "  No .next cache found"
fi
echo ""

# 4. Show updated config
echo "[4/5] New contract addresses:"
cat "$FRONTEND_DIR/public/config/casper-testnet.json" | grep -E '"(registry|router|stablecoin|branchCspr|branchSCSPR)"' | head -5
echo "  ..."
echo ""

# 5. Git status
echo "[5/5] Files to commit for Vercel:"
git status --short "$ROOT_DIR/config/" "$FRONTEND_DIR/public/config/" 2>/dev/null || true
echo ""

echo "=== Post-Deploy Complete ==="
echo ""
echo "Next steps:"
echo "  1. Test locally:  cd frontend && npm run dev"
echo "  2. Commit config: git add config/ frontend/public/config/ && git commit -m 'chore: update contract addresses'"
echo "  3. Push to Vercel: git push"
echo ""
