#!/bin/bash

set -e

echo "Detecting global Harper and Node.js versions..."

# Output file
VERSION_FILE=".github/config/versions.txt"

# Get Node version
NODE_VERSION_FULL=$(node -v 2>/dev/null || echo "unknown")
NODE_VERSION=${NODE_VERSION_FULL#v}

# Get global Harper version (v5 package/CLI is `harper`, was `harperdb` in v4)
HDB_VERSION=$(npm list -g harper --depth=0 2>/dev/null | grep 'harper@' | sed -E 's/.*harper@([^ ]+).*/\1/' || echo "not_found")

# Write to versions.txt
cat <<EOF > "$VERSION_FILE"
NODE_VERSION=$NODE_VERSION
HDB_VERSION=$HDB_VERSION
EOF

echo "✅ Created: .github/config/versions.txt"
cat "$VERSION_FILE"
