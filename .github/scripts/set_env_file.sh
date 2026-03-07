#!/bin/bash

# The purpose of this script is to set the appropriate .env file based on the provided environment argument.
# It looks for files named .env.<type> (e.g., .env.dev, .env.prod) and copies the matching file to .env.
# If only one .env file is found, it renames it to .env.
# This ensures that the correct environment configuration is used for the specified environment.

set -e

ENVIRONMENT="${1:-dev}"

if [ -z "$ENVIRONMENT" ]; then
  echo "Usage: set_env_file.sh <environment>"
  exit 1 # Exit with error if no environment is provided
fi

ENV_TYPE=$(echo "$ENVIRONMENT" | cut -d'-' -f1)
ENV_FILES=($(ls .env* 2>/dev/null || true))
ENV_FILE_COUNT=${#ENV_FILES[@]}

echo "Setting environment file for type: $ENV_TYPE"
if [ "$ENV_FILE_COUNT" -eq 0 ]; then
  echo "No .env files found."
  echo "none" # Exit gracefully if no env files exist
elif [ "$ENV_FILE_COUNT" -eq 1 ]; then
  ONLY_FILE="${ENV_FILES[0]}"
  if [ "$ONLY_FILE" != ".env" ]; then
    echo "Only one env file found ($ONLY_FILE), renaming to .env"
    cp "$ONLY_FILE" .env
  else
    echo "Only .env file found, no action needed."
  fi
  echo "success" # Exit successfully if only one env file exists
else
  TARGET_ENV_FILE=".env.$ENV_TYPE"
  if [ -f "$TARGET_ENV_FILE" ]; then
    echo "Found matching env file: $TARGET_ENV_FILE"
    cp "$TARGET_ENV_FILE" .env
    echo "success" # Exit successfully if matching env file is found and copied
  else
    echo "No matching env file for ENV_TYPE=$ENV_TYPE"
    exit 1 # Exit with error if no matching env file is found
  fi
fi
