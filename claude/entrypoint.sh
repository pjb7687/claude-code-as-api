#!/bin/bash
mkdir -p ~/.claude

cat > ~/.claude/.mcp.json <<'MCPEOF'
{
  "mcpServers": {
    "localcc": {
      "command": "bun",
      "args": ["run", "--cwd", "/opt/localcc", "--shell=bun", "--silent", "start"]
    }
  }
}
MCPEOF

cat > ~/.claude/settings.json <<'SETEOF'
{
  "skipDangerousModePermissionPrompt": true
}
SETEOF

socat TCP-LISTEN:8788,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:8686 &
exec "$@"
