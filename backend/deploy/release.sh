#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

archive=${1:?release archive required}
application=${2:?application directory required}
service=${3:?service name required}
port=${4:?API port required}
[[ "$archive" == /tmp/stickman-release-*.tar.gz && -f "$archive" ]]
[[ "$application" == /* && "$application" != / && -d "$application/backend/data" ]]
[[ -f "$application/backend/.env" ]]
[[ "$service" =~ ^[a-zA-Z0-9_.-]+\.service$ && "$port" =~ ^[0-9]+$ ]]

work=$(mktemp -d /tmp/stickman-deploy.XXXXXX)
backup="$application/.releases/$(date -u +%Y%m%dT%H%M%SZ)-$$"
stopped=0
paths=(backend/src backend/db backend/node_modules backend/package.json backend/package-lock.json fonts invoice_template)
touched=()

cleanup() {
    rm -rf -- "$work"
    rm -f -- "$archive"
}

rollback() {
    status=$?
    trap - ERR
    set +e
    printf 'Release failed; restoring application files from %s\n' "$backup" >&2
    for relative in "${touched[@]}"; do
        if [[ -e "$application/$relative" ]]; then
            mkdir -p -- "$work/failed/$(dirname "$relative")"
            mv -- "$application/$relative" "$work/failed/$relative"
        fi
        if [[ -e "$backup/$relative" ]]; then
            mv -- "$backup/$relative" "$application/$relative"
        fi
    done
    if (( stopped )); then
        sudo -n systemctl restart "$service"
    fi
    printf 'Runtime data and .env were not replaced. Check the service and retained backup before retrying.\n' >&2
    exit "$status"
}

trap cleanup EXIT
trap rollback ERR

while IFS= read -r entry; do
    [[ "$entry" != /* && "/$entry/" != *'/../'* ]]
    case "$entry" in
        backend/src|backend/src/|backend/src/*|backend/db|backend/db/|backend/db/*|backend/package.json|backend/package-lock.json|fonts|fonts/|fonts/*|invoice_template|invoice_template/|invoice_template/*) ;;
        *) printf 'Unexpected release archive member: %s\n' "$entry" >&2; exit 1 ;;
    esac
done < <(tar -tzf "$archive")
tar --no-same-owner -xzf "$archive" -C "$work"
(
    cd "$work/backend"
    npm ci --omit=dev --no-audit --no-fund
)
while IFS= read -r -d '' source; do
    node --check "$source"
done < <(find "$work/backend/src" -type f -name '*.js' -print0)

mkdir -p -- "$backup"
sudo -n systemctl stop "$service"
stopped=1
cp -a -- "$application/backend/data" "$backup/runtime-data"
if [[ -d "$application/invoices" ]]; then
    cp -a -- "$application/invoices" "$backup/invoices"
fi
for relative in "${paths[@]}"; do
    mkdir -p -- "$backup/$(dirname "$relative")"
    if [[ -e "$application/$relative" ]]; then
        mv -- "$application/$relative" "$backup/$relative"
    fi
    touched+=("$relative")
    mv -- "$work/$relative" "$application/$relative"
done
sudo -n systemctl restart "$service"
systemctl is-active --quiet "$service"
curl --fail --silent --show-error --retry 10 --retry-delay 1 --retry-connrefused --retry-max-time 45 --max-time 10 \
    "http://127.0.0.1:$port/health" > "$work/health.json"
node -e 'const fs = require("node:fs"); if (JSON.parse(fs.readFileSync(process.argv[1], "utf8")).ok !== true) process.exit(1);' "$work/health.json"
printf 'Backend active and healthy. Backup: %s\n' "$backup"