#!/usr/bin/env bash

# 生产部署脚本：服务器只 pull 已发布的 GHCR 镜像，不构建、不接收应用源码。
set -Eeuo pipefail
umask 077

DEPLOY_DIR="${DEPLOY_DIR:-/opt/pv-ac-sim}"
NEW_TAG="${1:-}"
NEW_IMAGE_REF="${2:-}"
NEW_COMPOSE_FILE="${3:-}"

valid_tag() {
  [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?$ ]]
}

valid_image_ref() {
  [[ "$1" =~ ^ghcr\.io/.+@sha256:[a-f0-9]{64}$ ]]
}

if ! valid_tag "$NEW_TAG"; then
  echo "错误：版本号必须符合 vMAJOR.MINOR.PATCH 或 vMAJOR.MINOR.PATCH-rcN" >&2
  exit 2
fi

# 手动回滚只传 Tag：从本机保存的部署元数据恢复不可变镜像与 Compose 快照。
if [[ -z "$NEW_IMAGE_REF" ]]; then
  VERSION_DIR="$DEPLOY_DIR/deploy/versions/$NEW_TAG"
  [[ -f "$VERSION_DIR/image-ref" ]] || {
    echo "错误：未找到版本 $NEW_TAG 的镜像引用：$VERSION_DIR/image-ref" >&2
    exit 2
  }
  NEW_IMAGE_REF="$(tr -d '\r\n' < "$VERSION_DIR/image-ref")"
  NEW_COMPOSE_FILE="$VERSION_DIR/docker-compose.yml"
fi

if ! valid_image_ref "$NEW_IMAGE_REF"; then
  echo "错误：镜像必须是不可变 GHCR digest 引用（ghcr.io/...@sha256:...）" >&2
  exit 2
fi

NEW_COMPOSE_FILE="${NEW_COMPOSE_FILE:-$DEPLOY_DIR/docker-compose.yml}"
[[ -f "$DEPLOY_DIR/.env" ]] || { echo "错误：$DEPLOY_DIR/.env 不存在" >&2; exit 2; }
[[ -f "$NEW_COMPOSE_FILE" ]] || { echo "错误：Compose 文件不存在：$NEW_COMPOSE_FILE" >&2; exit 2; }

cd "$DEPLOY_DIR"
set -a
. ./.env
set +a
: "${APP_UID:?缺少 APP_UID}"
: "${APP_GID:?缺少 APP_GID}"

mkdir -p scenarios backups deploy/versions
BACKUP_FILE="$DEPLOY_DIR/backups/scenarios-pre-${NEW_TAG}-$(date +%Y%m%d-%H%M%S).tar.gz"
tar --exclude='scenarios/*.tmp' -czf "$BACKUP_FILE" scenarios
mapfile -t OLD_BACKUPS < <(ls -1t backups/scenarios-pre-*.tar.gz 2>/dev/null | tail -n +11 || true)
(( ${#OLD_BACKUPS[@]} == 0 )) || rm -f -- "${OLD_BACKUPS[@]}"

OLD_TAG=""
OLD_IMAGE_REF=""
if [[ -f current-release && -f current-image ]]; then
  OLD_TAG="$(tr -d '\r\n' < current-release)"
  OLD_IMAGE_REF="$(tr -d '\r\n' < current-image)"
fi
OLD_HEALTH="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{end}}' pv-ac-sim-web 2>/dev/null || true)"
if [[ "$OLD_HEALTH" != "healthy" ]] || ! valid_tag "$OLD_TAG" || ! valid_image_ref "$OLD_IMAGE_REF"; then
  OLD_TAG=""
  OLD_IMAGE_REF=""
fi

compose() {
  local compose_file="$1"
  local image_ref="$2"
  shift 2
  IMAGE_REF="$image_ref" \
    SCENARIOS_DIR="$DEPLOY_DIR/scenarios" \
    docker compose --project-name pv-ac-sim --env-file "$DEPLOY_DIR/.env" \
      -f "$compose_file" --project-directory "$DEPLOY_DIR" "$@"
}

wait_healthy() {
  local i status
  for i in {1..90}; do
    status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' pv-ac-sim-web 2>/dev/null || true)"
    if [[ "$status" == "healthy" ]]; then
      docker exec pv-ac-sim-web wget -q -O- http://localhost:8080/health >/dev/null
      docker exec pv-ac-sim-web wget -q -O- http://localhost:8080/ >/dev/null
      docker exec pv-ac-sim-web node -e \
        'const fs=require("node:fs");const p=`/app/scenarios/.health-${process.pid}`;fs.writeFileSync(p,"ok");fs.unlinkSync(p)'
      return 0
    fi
    [[ "$status" != "unhealthy" && "$status" != "exited" && "$status" != "dead" ]] || return 1
    sleep 1
  done
  return 1
}

rollback() {
  local exit_code=$?
  trap - ERR
  echo "部署失败，开始恢复上一健康版本：${OLD_TAG:-无}" >&2
  if [[ -n "$OLD_TAG" ]]; then
    local old_version_dir="$DEPLOY_DIR/deploy/versions/$OLD_TAG"
    if [[ -f "$old_version_dir/docker-compose.yml" ]] && \
       compose "$old_version_dir/docker-compose.yml" "$OLD_IMAGE_REF" pull web && \
       compose "$old_version_dir/docker-compose.yml" "$OLD_IMAGE_REF" up -d --remove-orphans && \
       wait_healthy; then
      echo "已恢复并验证旧版本：$OLD_TAG" >&2
    else
      echo "严重：旧版本 $OLD_TAG 也未能恢复健康，需要立即人工处理" >&2
    fi
  else
    echo "首次部署没有可回滚的健康版本" >&2
  fi
  docker logs pv-ac-sim-web --tail 100 2>/dev/null || true
  exit "$exit_code"
}
trap rollback ERR

compose "$NEW_COMPOSE_FILE" "$NEW_IMAGE_REF" config --quiet
compose "$NEW_COMPOSE_FILE" "$NEW_IMAGE_REF" pull web
compose "$NEW_COMPOSE_FILE" "$NEW_IMAGE_REF" up -d --remove-orphans
wait_healthy

VERSION_DIR="$DEPLOY_DIR/deploy/versions/$NEW_TAG"
rm -rf "$VERSION_DIR"
mkdir -p "$VERSION_DIR"
cp "$NEW_COMPOSE_FILE" "$VERSION_DIR/docker-compose.yml"
printf '%s\n' "$NEW_IMAGE_REF" > "$VERSION_DIR/image-ref"
chmod 600 "$VERSION_DIR/image-ref"

cp "$NEW_COMPOSE_FILE" "$DEPLOY_DIR/docker-compose.yml"
CURRENT_TMP="$(mktemp "$DEPLOY_DIR/current-release.XXXXXX")"
printf '%s\n' "$NEW_TAG" > "$CURRENT_TMP"
chmod 600 "$CURRENT_TMP"
mv "$CURRENT_TMP" "$DEPLOY_DIR/current-release"
IMAGE_TMP="$(mktemp "$DEPLOY_DIR/current-image.XXXXXX")"
printf '%s\n' "$NEW_IMAGE_REF" > "$IMAGE_TMP"
chmod 600 "$IMAGE_TMP"
mv "$IMAGE_TMP" "$DEPLOY_DIR/current-image"
mkdir -p "$DEPLOY_DIR/deploy"
if [[ "$0" != "$DEPLOY_DIR/deploy/deploy.sh" ]]; then
  cp "$0" "$DEPLOY_DIR/deploy/deploy.sh"
fi
chmod 700 "$DEPLOY_DIR/deploy/deploy.sh"

echo "部署成功：${NEW_TAG}"
echo "镜像：${NEW_IMAGE_REF}"
docker ps --filter name=pv-ac-sim-web --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
trap - ERR
