#!/bin/bash
# Volume name = <directory>_claude-home (compose default)
PROJECT_DIR=$(basename "$(cd "$(dirname "$0")" && pwd)")
VOLUME="${PROJECT_DIR}_claude-home"
CONFIG_FILE=".localcc-flavor"

# Check if already running
if docker compose ps --status running --quiet 2>/dev/null | grep -q .; then
  echo "Claude Code is already running at http://localhost:23411"
  exit 0
fi

# Build if needed
echo "Building container..."
docker compose build --quiet

# Check if credentials exist in the volume
if ! docker run --rm -v "$VOLUME:/data" alpine test -f /data/.claude/.credentials.json 2>/dev/null; then
  echo ""
  echo "No login credentials found. Starting login..."
  echo ""
  docker compose run --rm claude claude
  echo ""
fi

# Choose API flavor on first run
if [ ! -f "$CONFIG_FILE" ]; then
  echo ""
  echo "Which API flavor should localcc use?"
  echo ""
  echo "  1) OpenAI      - /v1/chat/completions, /v1/responses"
  echo "  2) Anthropic   - /v1/messages"
  echo "  3) OpenRouter  - /api/v1/chat/completions + extras"
  echo ""
  read -rp "Choose [1-3] (default: 1): " choice
  case "$choice" in
    2) flavor="anthropic" ;;
    3) flavor="openrouter" ;;
    *) flavor="openai" ;;
  esac
  echo "$flavor" > "$CONFIG_FILE"
  echo "Saved: $flavor"
fi

FLAVOR=$(cat "$CONFIG_FILE")
LOCALCC_FLAVOR="$FLAVOR" docker compose up -d
echo "Ready at http://localhost:23411 ($FLAVOR)"
