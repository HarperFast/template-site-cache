#!/bin/bash

set -e

echo "Detecting global HarperDB and Node.js versions..."

# Output file
VERSION_FILE=".github/config/versions.txt"

# Get Node version
NODE_VERSION_FULL=$(node -v 2>/dev/null || echo "unknown")
NODE_VERSION=${NODE_VERSION_FULL#v}

# Get global HarperDB version
HDB_VERSION=$(npm list -g harperdb --depth=0 2>/dev/null | grep 'harperdb@' | sed -E 's/.*harperdb@([^ ]+).*/\1/' || echo "not_found")

# Write to versions.txt
cat <<EOF > "$VERSION_FILE"
NODE_VERSION=$NODE_VERSION
HDB_VERSION=$HDB_VERSION
EOF

echo "✅ Created: .github/config/versions.txt"
cat "$VERSION_FILE"
