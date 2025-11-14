#!/bin/bash

CDP_PORT=${CDP_PORT:-9222}
MCP_PORT=${MCP_PORT:-8931}

cleanup() {
  echo "Received interrupt signal. Terminating processes..."
  kill $(jobs -p)
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "--- STEP 1: Launching Browser (Background) ---"

node launch_browser.js & 
BROWSER_PID=$!

echo "Browser PID: $BROWSER_PID. Waiting for DevTools Protocol..."
echo "--- STEP 2: Polling HTTP for CDP URL (/json/version) ---"

CDP_ENDPOINT_URL="http://127.0.0.1:$CDP_PORT/json/version"
CDP_WEBSOCKET_URL=""
TIMEOUT=40 

for (( i=0; i<$TIMEOUT; i++ )); do
    CDP_JSON=$(curl -s $CDP_ENDPOINT_URL)
    CDP_WEBSOCKET_URL=$(echo "$CDP_JSON" | jq -r '."webSocketDebuggerUrl"')

    if [ -n "$CDP_WEBSOCKET_URL" ]; then
        echo "✅ CDP endpoint found after $((i+1)) seconds."
        break
    fi

    if ! kill -0 $BROWSER_PID 2>/dev/null; then
        echo "❌ Browser process terminated before providing CDP URL."
        exit 1
    fi

    sleep 1
done

if [ -z "$CDP_WEBSOCKET_URL" ]; then
    echo "❌ Timeout of $TIMEOUT seconds reached. Unable to obtain CDP URL."
    kill $BROWSER_PID
    exit 1
fi

echo "--- STEP 3: Launching MCP Server ---"
CDP_ENDPOINT_MODIFIED=$(echo $CDP_WEBSOCKET_URL | sed 's/127.0.0.1/localhost/g')
echo "🔗 Corrected CDP URL for MCP: $CDP_ENDPOINT_MODIFIED"

exec npx @playwright/mcp \
    --cdp-endpoint "$CDP_ENDPOINT_MODIFIED" \
    --port $MCP_PORT

echo "❌ MCP server terminated unexpectedly."

cleanup
