#!/bin/bash

# The purpose of this script is to deploy a Harper component using the Harper CLI.
# It requires the Harper admin username and password, target URL, and options for replication and restart.

set -e

HDB_ADMIN_USERNAME=${1:-"HDB_ADMIN"}
HDB_ADMIN_PASSWORD=${2:-"password"}
TARGET=${3:-"http://localhost:9925"}
REPLICATED=${REPLICATED:-"false"}
RESTART=${RESTART:-"true"}
CONTAINER_NAME=${4:-"harperdb"}

if [ -z "$HDB_ADMIN_USERNAME" ] || [ -z "$HDB_ADMIN_PASSWORD" ] || [ -z "$TARGET" ] || [ -z "$REPLICATED" ] || [ -z "$RESTART" ] || [ -z "$CONTAINER_NAME" ]; then
  echo "Usage: deploy_harper_cli.sh <hdb_admin_username> <hdb_admin_password> <target> <replicated> <restart> <container_name>"
  exit 1
fi

echo "Deploying Harper component to target: $TARGET"

# Deploy component to docker
export CLI_TARGET_USERNAME="$HDB_ADMIN_USERNAME"
export CLI_TARGET_PASSWORD="$HDB_ADMIN_PASSWORD"
harperdb deploy target=$TARGET replicated=$REPLICATED restart=$RESTART

# Wait for the container to be ready after restart
.github/scripts/wait_harper_ready.sh "$CONTAINER_NAME"
