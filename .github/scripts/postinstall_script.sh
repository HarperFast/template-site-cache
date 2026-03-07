#!/bin/bash

# This is a copy of the postinstall script added to package.json for consuming repos
# In the consuming repo, this script should be placed at the root level
# The script will auto remove itself after running the first time to avoid conflicts with future updates
# "postinstall": "test -f ./postinstall_script.sh && (bash ./postinstall_script.sh && rm -f ./postinstall_script.sh) || echo 'No postinstall script found.'"

set -eo pipefail

# Go to repo root
cd "$(git rev-parse --show-toplevel)"

TEMPLATE_REMOTE=delivery-workflow-template
TEMPLATE_REPO=https://github.com/HarperFast/delivery-workflow-template.git
TEMPLATE_BRANCH=github-only
TARGET_DIR=.github

echo "Updating workflows subtree..."

# --- Trap setup ---
cleanup() {
    if [ "$STASHED" = true ]; then
        echo -e "\nRestoring stashed changes...\n"
        git stash pop || echo "Could not apply stashed changes cleanly. Please resolve manually."
    fi
}
trap cleanup EXIT
# ------------------

# Fully stash everything, including untracked and ignored files or git subtree commands may fail
if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    echo "Stashing all changes (tracked, untracked, ignored)..."
    git stash push -u -a -m "Auto-stash before subtree update" 2>/dev/null || true
    STASHED=true
else
    STASHED=false
fi

# Ensure the remote exists
if ! git remote get-url "$TEMPLATE_REMOTE" &>/dev/null; then
    echo "Remote '$TEMPLATE_REMOTE' not found. Setting up first."
    git remote add "$TEMPLATE_REMOTE" "$TEMPLATE_REPO"
fi

# Fetch the latest changes
git fetch "$TEMPLATE_REMOTE" "$TEMPLATE_BRANCH"
REMOTE_HASH=$(git rev-parse FETCH_HEAD)

# Add or pull the subtree
if [ ! -d "$TARGET_DIR" ]; then
    echo "Directory '$TARGET_DIR' does not exist. Adding subtree for the first time..."
    git subtree add --prefix="$TARGET_DIR" "$TEMPLATE_REMOTE" "$TEMPLATE_BRANCH" --squash --message="Update workflows subtree ($TEMPLATE_REMOTE) to commit $REMOTE_HASH"
else
    echo "Pulling subtree changes into $TARGET_DIR..."
    git subtree pull --prefix="$TARGET_DIR" "$TEMPLATE_REMOTE" "$TEMPLATE_BRANCH" --squash --message="Update workflows subtree ($TEMPLATE_REMOTE) to commit $REMOTE_HASH"
fi

# Remove update-github-only.yaml (for parent repo only)
rm -f "$TARGET_DIR/workflows/update-github-only.yaml"

echo -e "✅ Workflows synced into $TARGET_DIR\n"

# Run additional post-install scripts
if [ -d "$TARGET_DIR" ]; then
    echo -e "Running additional post-install scripts...\n"
    [ -f "$TARGET_DIR/scripts/detect_global_versions.sh" ] && bash "$TARGET_DIR/scripts/detect_global_versions.sh"
    [ -f "$TARGET_DIR/scripts/check_sonarqube.sh" ] && bash "$TARGET_DIR/scripts/check_sonarqube.sh"
fi
