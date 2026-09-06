#!/usr/bin/env bash
# Team-shell deployment: stage a standalone copy of this repository, install
# dependencies, and start (or restart) the three team-shell services from that
# copy — so development in the source checkout never leaks into production.
#
# Usage:
#   shell/deploy.sh install   # rsync the repo into $DEPLOY_ROOT and install deps
#   shell/deploy.sh sync      # rsync current source over the deploy copy (no deps)
#   shell/deploy.sh start     # start account + proxy + hub from the deploy copy
#   shell/deploy.sh stop      # stop the three services (graceful SIGTERM)
#   shell/deploy.sh restart   # stop + start (equivalent to sync + restart)
#   shell/deploy.sh status    # show the three services' process state
#
# Environment (all optional):
#   DEPLOY_ROOT           deploy directory        (default /srv/dsh-harness)
#   DSH_ENTRY_HOST        proxy entry LAN host    (default 10.33.2.56)
#   DSH_USERS_ROOT        per-user DSH_HOME root  (default /home/winslow/.dsh-users)
#   PROXY_PORT            proxy entry port        (default 3999)
#   ACCOUNT_PORT          account loopback port   (default 3900)
#   HUB_AGENT_PORT        hub agent port          (default 7101)
#   HUB_CONTROL_PORT      hub control port        (default 7100)
#   DSH_SHADOW_ROOT       hub shadow root         (default /tmp/dsh-shadow)
#
# The deploy copy runs in source mode (tsx) exactly like the dev checkout:
# dsh instances are spawned from apps/cli/src/bin.ts, so no build is required.

set -euo pipefail

# --- resolve paths and options ------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/dsh-harness}"
DSH_ENTRY_HOST="${DSH_ENTRY_HOST:-10.33.2.56}"
DSH_USERS_ROOT="${DSH_USERS_ROOT:-/home/winslow/.dsh-users}"
PROXY_PORT="${PROXY_PORT:-3999}"
ACCOUNT_PORT="${ACCOUNT_PORT:-3900}"
HUB_AGENT_PORT="${HUB_AGENT_PORT:-7101}"
HUB_CONTROL_PORT="${HUB_CONTROL_PORT:-7100}"
DSH_SHADOW_ROOT="${DSH_SHADOW_ROOT:-/tmp/dsh-shadow}"

ACCOUNT_URL="http://127.0.0.1:${ACCOUNT_PORT}"
LOG_DIR="${DEPLOY_ROOT}/.run"
ACCOUNT_LOG="${LOG_DIR}/account.log"
PROXY_LOG="${LOG_DIR}/proxy.log"
HUB_LOG="${LOG_DIR}/hub.log"

RSYNC_EXCLUDES=(
  --exclude=.git
  --exclude=node_modules
  --exclude=shell/.env
  --exclude='*.log'
  --exclude='*.tsbuildinfo'
  --exclude=lib
  --exclude=dist
  --exclude=dist-exe
  --exclude=coverage
  --exclude=.cache
  --exclude=.storages
  --exclude=.sessions
  --exclude=.playwright-mcp
  --exclude=.dsh-build
)

# --- helpers ------------------------------------------------------------------
log() { printf '%s\n' "$*"; }

pids() {
  # Return the account/proxy/hub PIDs currently running from DEPLOY_ROOT, if any.
  pgrep -f "bin.ts account"       2>/dev/null | head -1 || true
  pgrep -f "proxy ${PROXY_PORT} --account" 2>/dev/null | head -1 || true
  pgrep -f "remote hub .*--control-port ${HUB_CONTROL_PORT}" 2>/dev/null | head -1 || true
}

require_deploy_root() {
  if [ ! -f "${DEPLOY_ROOT}/package.json" ]; then
    log "error: ${DEPLOY_ROOT} is not a deploy copy; run 'install' first" >&2
    exit 1
  fi
}

require_env() {
  if [ ! -f "${DEPLOY_ROOT}/shell/.env" ]; then
    log "error: ${DEPLOY_ROOT}/shell/.env is missing; copy shell/.env.example to shell/.env and fill TEAM_DB_URL / TEAM_REDIS_URL" >&2
    exit 1
  fi
}

# --- commands -----------------------------------------------------------------
cmd_install() {
  if [ -e "${DEPLOY_ROOT}" ] && [ ! -d "${DEPLOY_ROOT}" ]; then
    log "error: ${DEPLOY_ROOT} exists and is not a directory" >&2
    exit 1
  fi
  mkdir -p "${DEPLOY_ROOT}"
  log "rsync ${REPO_ROOT} -> ${DEPLOY_ROOT}"
  rsync -a "${RSYNC_EXCLUDES[@]}" "${REPO_ROOT}/" "${DEPLOY_ROOT}/"
  # Install workspace deps in the copy (never in the dev checkout).
  ( cd "${DEPLOY_ROOT}" && pnpm install )
  ( cd "${DEPLOY_ROOT}/shell" && npm install )
  # Bootstrap the runtime env if the operator has not written one yet.
  if [ ! -f "${DEPLOY_ROOT}/shell/.env" ]; then
    cp "${DEPLOY_ROOT}/shell/.env.example" "${DEPLOY_ROOT}/shell/.env"
    log "created ${DEPLOY_ROOT}/shell/.env from .env.example — EDIT IT before 'start'"
  fi
  log "installed into ${DEPLOY_ROOT}"
}

cmd_sync() {
  require_deploy_root
  log "rsync ${REPO_ROOT} -> ${DEPLOY_ROOT} (source only)"
  rsync -a --delete "${RSYNC_EXCLUDES[@]}" "${REPO_ROOT}/" "${DEPLOY_ROOT}/"
  log "synced"
}

cmd_start() {
  require_deploy_root
  require_env
  mkdir -p "${LOG_DIR}"
  ( cd "${DEPLOY_ROOT}/shell" && \
    nohup node --env-file-if-exists=.env --import tsx/esm src/bin.ts account \
      > "${ACCOUNT_LOG}" 2>&1 & echo $! > "${LOG_DIR}/account.pid" )
  ( cd "${DEPLOY_ROOT}/shell" && \
    nohup node --import tsx/esm src/bin.ts proxy "${PROXY_PORT}" --account "${ACCOUNT_URL}" \
      > "${PROXY_LOG}" 2>&1 & echo $! > "${LOG_DIR}/proxy.pid" )
  ( cd "${DEPLOY_ROOT}/shell" && \
    nohup node --import tsx/esm src/bin.ts remote hub --account "${ACCOUNT_URL}" \
      --agent-port "${HUB_AGENT_PORT}" --control-port "${HUB_CONTROL_PORT}" \
      --no-auto-inject --shadow-root "${DSH_SHADOW_ROOT}" \
      > "${HUB_LOG}" 2>&1 & echo $! > "${LOG_DIR}/hub.pid" )
  sleep 2
  log "started account (${ACCOUNT_URL}), proxy (0.0.0.0:${PROXY_PORT}), hub (0.0.0.0:${HUB_AGENT_PORT})"
  log "logs: ${LOG_DIR}"
}

cmd_stop() {
  local any=0
  while IFS= read -r pid; do
    [ -z "${pid}" ] && continue
    kill "${pid}" 2>/dev/null || true
    any=1
  done < <(pids)
  [ "${any}" = "1" ] && sleep 2
  log "stopped"
}

cmd_status() {
  local account proxy hub
  account="$(pgrep -f 'bin.ts account' 2>/dev/null | head -1 || true)"
  proxy="$(pgrep -f "proxy ${PROXY_PORT} --account" 2>/dev/null | head -1 || true)"
  hub="$(pgrep -f "remote hub .*--control-port ${HUB_CONTROL_PORT}" 2>/dev/null | head -1 || true)"
  printf '%-10s %s\n' account "${account:-down}"
  printf '%-10s %s\n' proxy "${proxy:-down}"
  printf '%-10s %s\n' hub "${hub:-down}"
}

# --- dispatch -----------------------------------------------------------------
case "${1:-}" in
  install) cmd_install ;;
  sync)    cmd_sync ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status)  cmd_status ;;
  *)
    log "usage: $0 <install|sync|start|stop|restart|status>" >&2
    exit 1
    ;;
esac
