#!/usr/bin/env bash
# e2e/cluster.sh
set -euo pipefail
BASE="${TMPDIR:-/tmp}/indexstats-e2e"
PORTS=(27021 27022 27023)

start() {
  mkdir -p "$BASE"
  for p in "${PORTS[@]}"; do
    mkdir -p "$BASE/$p"
    mongod --replSet rsIndexStats --port "$p" --dbpath "$BASE/$p" \
      --logpath "$BASE/$p/mongod.log" --bind_ip 127.0.0.1 \
      --wiredTigerCacheSizeGB 0.25 --fork > /dev/null
  done
  sleep 2
  mongosh "mongodb://127.0.0.1:27021/?directConnection=true" --quiet --eval '
    rs.initiate({ _id: "rsIndexStats", members: [
      { _id: 0, host: "127.0.0.1:27021", priority: 2 },
      { _id: 1, host: "127.0.0.1:27022" },
      { _id: 2, host: "127.0.0.1:27023", priority: 0, hidden: true }
    ]});'
  for _ in $(seq 30); do
    if mongosh "mongodb://127.0.0.1:27021/?directConnection=true" --quiet \
         --eval 'db.hello().isWritablePrimary' | grep -q true; then
      echo "primary ready"; return 0
    fi
    sleep 1
  done
  echo "primary never came up" >&2
  exit 1
}

stop() {
  for p in "${PORTS[@]}"; do
    mongosh "mongodb://127.0.0.1:$p/?directConnection=true" --quiet \
      --eval 'db.getSiblingDB("admin").shutdownServer()' > /dev/null 2>&1 || true
  done
  sleep 1
  rm -rf "$BASE"
  echo "cluster stopped and data removed"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 {start|stop}" >&2; exit 2 ;;
esac
