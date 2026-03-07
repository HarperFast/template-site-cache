#!/bin/bash

# The purpose of this script is to install the Harper CLI tool globally within a Github
# Action runner environment using npm to facilitate testing and deployment of components

set -e

HDB_VERSION=${1:-"latest"}
HDB_ADMIN_USERNAME=${2:-"HDB_ADMIN"}
HDB_ADMIN_PASSWORD=${3:-"password"}

if [ -z "$HDB_VERSION" ] || [ -z "$HDB_ADMIN_USERNAME" ] || [ -z "$HDB_ADMIN_PASSWORD" ]; then
  echo "Usage: install_harper.sh <hdb_version> <hdb_admin_username> <hdb_admin_password>"
  exit 1
fi

echo "Installing Harper version: $HDB_VERSION"
npm install -g harperdb@$HDB_VERSION

mkdir -p /tmp/hdb

export TC_AGREEMENT=yes
export ROOTPATH=/tmp/hdb
export HDB_ADMIN_USERNAME=$HDB_ADMIN_USERNAME
export HDB_ADMIN_PASSWORD=$HDB_ADMIN_PASSWORD
export OPERATIONSAPI_NETWORK_PORT=9925
harperdb install
