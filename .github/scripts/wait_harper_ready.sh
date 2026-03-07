#!/bin/bash

# The purpose of this script is to periodically check if
# a Harper instance in a Docker container is ready to accept connections.

set -e

CONTAINER_NAME=${1:-"harperdb"}
if [ -z "$CONTAINER_NAME" ]; then
  echo "Usage: wait_harper_ready.sh <container_name>"
  exit 1
fi

# Wait for the container to be ready
echo "Waiting for Harper container to be ready..."
TIMEOUT=60  # seconds
INTERVAL=10   # seconds
ELAPSED=0

while [[ $ELAPSED -lt $TIMEOUT ]]; do
    LOGS=$(docker logs "$CONTAINER_NAME" 2>&1)

    if echo "$LOGS" | grep -q "successfully started"; then
        echo "Harper container is ready."
        sleep 10 # Extra wait to ensure readiness
        exit 0
    fi

    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
done

echo "Timeout: Harper container did not start within $TIMEOUT seconds."
echo "Logs from the container:"
echo "$LOGS"
exit 1
