#!/usr/bin/env bash
# e2e/sharded.sh - a real sharded cluster of plain forked processes, no containers.
# Ports are deliberately disjoint from cluster.sh's 27021-27023 so both suites can
# run without interfering with each other.
set -euo pipefail
BASE="${TMPDIR:-/tmp}/indexstats-e2e-sharded"
CONFIG_PORT=27019
MONGOS_PORT=27030
SHARD_A=(27031 27032)
SHARD_B=(27033 27034)
MONGOD_PORTS=(27019 27031 27032 27033 27034)

# --pidfilepath is what makes `stop` deterministic: --fork daemonises, so the
# shell never learns the real pid, and a mongod closes its listening socket well
# before it has finished flushing WiredTiger and exited. Polling the port would
# therefore report "stopped" while the process is still alive and still holding
# its dbpath, which is exactly how a forked mongod gets left behind.
fork_mongod() {
  local port="$1"; shift
  mkdir -p "$BASE/$port"
  mongod --port "$port" --dbpath "$BASE/$port" \
    --logpath "$BASE/$port/mongod.log" --pidfilepath "$BASE/$port/mongod.pid" \
    --bind_ip 127.0.0.1 --wiredTigerCacheSizeGB 0.25 --fork "$@" > /dev/null
}

wait_primary() { # port, label
  local port="$1" label="$2"
  for _ in $(seq 30); do
    if mongosh "mongodb://127.0.0.1:$port/?directConnection=true" --quiet \
         --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -q true; then
      echo "$label primary ready"; return 0
    fi
    sleep 1
  done
  echo "$label primary never came up" >&2
  exit 1
}

start() {
  mkdir -p "$BASE"

  fork_mongod "$CONFIG_PORT" --configsvr --replSet cfgIndexStats
  for p in "${SHARD_A[@]}" "${SHARD_B[@]}"; do
    fork_mongod "$p" --shardsvr --replSet "$( [ "$p" -le 27032 ] && echo shardA || echo shardB )"
  done
  sleep 2

  mongosh "mongodb://127.0.0.1:$CONFIG_PORT/?directConnection=true" --quiet --eval '
    rs.initiate({ _id: "cfgIndexStats", configsvr: true, members: [
      { _id: 0, host: "127.0.0.1:27019" }
    ]});' > /dev/null
  mongosh "mongodb://127.0.0.1:27031/?directConnection=true" --quiet --eval '
    rs.initiate({ _id: "shardA", members: [
      { _id: 0, host: "127.0.0.1:27031", priority: 2 },
      { _id: 1, host: "127.0.0.1:27032" }
    ]});' > /dev/null
  mongosh "mongodb://127.0.0.1:27033/?directConnection=true" --quiet --eval '
    rs.initiate({ _id: "shardB", members: [
      { _id: 0, host: "127.0.0.1:27033", priority: 2 },
      { _id: 1, host: "127.0.0.1:27034" }
    ]});' > /dev/null

  wait_primary "$CONFIG_PORT" "config server"
  wait_primary 27031 "shardA"
  wait_primary 27033 "shardB"

  mkdir -p "$BASE/$MONGOS_PORT"
  mongos --configdb "cfgIndexStats/127.0.0.1:$CONFIG_PORT" --port "$MONGOS_PORT" \
    --logpath "$BASE/$MONGOS_PORT/mongos.log" --pidfilepath "$BASE/$MONGOS_PORT/mongos.pid" \
    --bind_ip 127.0.0.1 --fork > /dev/null

  for _ in $(seq 30); do
    if mongosh "mongodb://127.0.0.1:$MONGOS_PORT" --quiet \
         --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null | grep -q 1; then
      break
    fi
    sleep 1
  done

  mongosh "mongodb://127.0.0.1:$MONGOS_PORT" --quiet --eval '
    sh.addShard("shardA/127.0.0.1:27031,127.0.0.1:27032");
    sh.addShard("shardB/127.0.0.1:27033,127.0.0.1:27034");' > /dev/null

  for _ in $(seq 30); do
    if mongosh "mongodb://127.0.0.1:$MONGOS_PORT" --quiet \
         --eval 'db.adminCommand({listShards:1}).shards.map(s=>s._id).sort().join(",")' \
         2>/dev/null | grep -q 'shardA,shardB'; then
      echo "both shards registered"; return 0
    fi
    sleep 1
  done
  echo "shards never registered" >&2
  exit 1
}

stop() {
  # Order follows the dependency direction, and it matters: observed on this
  # machine, shutting the CONFIG SERVER down before the shards left both shard
  # secondaries alive for over a minute, because a --shardsvr mongod whose
  # config server has already gone blocks during shutdown. Router first (so no
  # shard is pulled out from under live routing), then the shard members, then
  # the config server last.
  mongosh "mongodb://127.0.0.1:$MONGOS_PORT" --quiet \
    --eval 'db.getSiblingDB("admin").shutdownServer({ force: true, timeoutSecs: 1 })' > /dev/null 2>&1 || true
  for p in "${SHARD_A[@]}" "${SHARD_B[@]}" "$CONFIG_PORT"; do
    mongosh "mongodb://127.0.0.1:$p/?directConnection=true" --quiet \
      --eval 'db.getSiblingDB("admin").shutdownServer({ force: true, timeoutSecs: 1 })' > /dev/null 2>&1 || true
  done
  # Wait on the real processes, not on their ports - see fork_mongod. Observed
  # on this machine: `sharded.sh stop` reported success while two shard
  # secondaries were still alive, because they had closed their sockets and
  # were still flushing.
  pids=""
  for f in "$BASE/$MONGOS_PORT/mongos.pid" "$BASE"/*/mongod.pid; do
    [ -f "$f" ] && pids="$pids $(cat "$f")"
  done
  wait_gone() { # seconds
    local n="$1"
    for _ in $(seq "$n"); do
      still_up=0
      for pid in $pids; do
        kill -0 "$pid" 2>/dev/null && still_up=1
      done
      [ "$still_up" -eq 0 ] && return 0
      sleep 1
    done
    return 1
  }
  # Last resort, and deliberately narrow: SIGTERM then SIGKILL, aimed only at
  # the pids THIS script forked and recorded. Never a broad `pkill mongod` -
  # that would take down any other mongod on the machine, including the
  # developer's own.
  if ! wait_gone 30; then
    for pid in $pids; do kill "$pid" 2>/dev/null || true; done
    if ! wait_gone 15; then
      for pid in $pids; do kill -9 "$pid" 2>/dev/null || true; done
      wait_gone 10 || echo "warning: processes still alive:$pids" >&2
    fi
  fi
  rm -rf "$BASE"
  echo "sharded cluster stopped and data removed"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 {start|stop}" >&2; exit 2 ;;
esac
