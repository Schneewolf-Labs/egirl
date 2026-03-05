#!/usr/bin/env bash
exec python "$(dirname "$0")/../embedding-server/serve-embedding.py" "$@"
