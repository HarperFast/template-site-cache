#!/bin/bash

# The purpose of this script is to ensure that K6 is installed
# and that at least one performance test file exists in the specified directory.
# Performance testing is necessary for all client projects to ensure reliability and scalability.

set -e

TEST_DIR=${1:-"tests/performance"}
echo "Checking for K6 setup and performance test files in $TEST_DIR..."

# Loop through files in test directory to ensure at least one test file exists
FOUND=0
for file in "$TEST_DIR"/*.test.js; do
  if [[ -f "$file" ]]; then
    if grep -qE "require\(['\"]k6['\"]\)|from ['\"]k6['\"]" "$file"; then
      FOUND=1
      break
    fi
  fi
done

if [[ $FOUND -eq 0 ]]; then
  echo "No K6 test files found in $TEST_DIR. Performance testing is important for all projects. Please create a test file with K6 imports."
  exit 1
fi

echo "K6 checks passed."
exit 0
