#!/bin/bash

# The purpose of this script is to start a Harper instance in a Docker container
# for testing and development purposes. It allows specifying the container name,
# Harper version, admin username, and password.

set -e

CONTAINER_NAME=${1:-"harperdb"}
HDB_VERSION=${2:-"latest"}
HDB_ADMIN_USERNAME=${3:-"HDB_ADMIN"}
HDB_ADMIN_PASSWORD=${4:-"password"}
CACHE_DEFAULT_ORIGIN_OVERRIDE=${CACHE_DEFAULT_ORIGIN_OVERRIDE:-""}
CACHE_API_ORIGIN_OVERRIDE=${CACHE_API_ORIGIN_OVERRIDE:-""}
ENVIRONMENT=${ENVIRONMENT:-"stage"}

if [ -z "$CONTAINER_NAME" ] || [ -z "$HDB_VERSION" ] || [ -z "$HDB_ADMIN_USERNAME" ] || [ -z "$HDB_ADMIN_PASSWORD" ]; then
  echo "Usage: deploy_harper_docker.sh <container_name> <hdb_version> <hdb_admin_username> <hdb_admin_password>"
  exit 1
fi

IMAGE_TAG="harperdb/harperdb:$HDB_VERSION"
echo "Starting Docker with Harper version: $HDB_VERSION"

# Run Harper container
docker run -d \
  --name "$CONTAINER_NAME" \
  --add-host=host.docker.internal:host-gateway \
  -e HDB_ADMIN_USERNAME="$HDB_ADMIN_USERNAME" \
  -e HDB_ADMIN_PASSWORD="$HDB_ADMIN_PASSWORD" \
  -e ENVIRONMENT="$ENVIRONMENT" \
  -e CACHE_DEFAULT_ORIGIN_OVERRIDE="$CACHE_DEFAULT_ORIGIN_OVERRIDE" \
  -e CACHE_API_ORIGIN_OVERRIDE="$CACHE_API_ORIGIN_OVERRIDE" \
  -e OPERATIONSAPI_NETWORK_PORT=9925 \
  -p 9925:9925 \
  -p 9926:9926 \
  "$IMAGE_TAG"

# Wait for the container to be ready
.github/scripts/wait_harper_ready.sh "$CONTAINER_NAME"
