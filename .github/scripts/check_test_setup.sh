#!/bin/bash

# The purpose of this script is to ensure that Supertest or built-in Node test is set up correctly
# and that at least one integration test file exists in the specified directory.
# Returns either 'supertest' or 'c8' based on the test setup found to trigger appropriate workflow.
# Integration testing is important for all client projects to ensure API reliability.

set -e

TEST_DIR=${1:-"tests/integration"}
echo "Checking integration test setup in $TEST_DIR..."

# Flag to determine the type of test runner
TEST_TYPE=""

# Look for test files
for file in "$TEST_DIR"/*.test.js; do
  if [[ -f "$file" ]]; then
    if grep -qE "from ['\"]supertest['\"]" "$file"; then
      TEST_TYPE="supertest"
      break
    elif grep -qE "from ['\"]node:test['\"]" "$file"; then
      TEST_TYPE="node"
      break
    fi
  fi
done

if [[ -z "$TEST_TYPE" ]]; then
  echo "No integration test using Supertest or Node test runner found in $TEST_DIR."
  exit 1
fi

# Install required dependencies based on test type
if [[ "$TEST_TYPE" == "supertest" ]]; then
  echo "Detected Supertest integration test."
  if ! grep -q '"supertest"' package.json || \
     ! grep -q '"vitest"' package.json || \
     ! grep -q '"@vitest/coverage-v8"' package.json; then
    echo "Installing missing devDependencies for Supertest/Vitest..."
    npm install --save-dev supertest vitest @vitest/coverage-v8 --legacy-peer-deps
  fi
  echo "Supertest setup complete."
  echo "supertest"
elif [[ "$TEST_TYPE" == "node" ]]; then
  echo "Detected Node test runner."
  if ! grep -q '"c8"' package.json; then
    echo "Installing c8 for coverage reporting..."
    npm install --save-dev c8 --legacy-peer-deps
  fi
  echo "Node test + c8 setup complete."
  echo "c8"
fi
