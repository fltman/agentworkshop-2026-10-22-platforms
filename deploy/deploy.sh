#!/usr/bin/env bash
# Deploys The Square (board/) to the server. Run from the repo root: deploy/deploy.sh
#
# The server is taken from, in this order:  HOST=root@<ip>  ->  the file .deploy-host (gitignored)  ->  abort.
# The domain is read from .board-url. Port, service name and directories were stamped in when this repo was
# built from the workshop template, and can be overridden with an environment variable for a single run.
# No address and no key is stored in the repo: this script is a template, not a configuration.
#
# Secrets (LEAD_TOKEN) are NOT handled here. They live in /etc/torget/<service>.env on the server, written by
# the organiser's tooling, and the systemd unit reads them with EnvironmentFile=. This repo is public.
#
# Requires: ssh to the server works, node and Caddy are installed there.
# DNS (the domain -> the server's IP) must exist before Caddy can fetch a certificate.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${HOST:-$( [ -f .deploy-host ] && tr -d '[:space:]' < .deploy-host || echo '' )}"
[ -n "$HOST" ] || { cat >&2 <<'TXT'
No server given. Two ways:
  HOST=root@<ip> deploy/deploy.sh
  printf 'root@<ip>\n' > .deploy-host      (gitignored, stays for next time)
If you run release rounds during the day, .deploy-host must exist in the repo root you run them from.
TXT
exit 2; }
BOARD_URL="$(tr -d '[:space:]' < .board-url 2>/dev/null || echo '')"
DOMAN="${DOMAN:-$(printf %s "$BOARD_URL" | sed -E 's#^https?://##; s#/.*##')}"
# The values below are stamped in by the workshop template builder. If a placeholder is still there, the
# repo was not built from the template, and the same fallbacks as the server provisioning apply.
PORT="${PORT:-8185}";                            case "$PORT"          in *[!0-9]*|'') PORT=8180;; esac
TJANST="${TJANST:-torget-platforms}";                      case "$TJANST"        in *_*|'')     TJANST=torget;; esac
SERVERKATALOG="${SERVERKATALOG:-/opt/torget-platforms}"; case "$SERVERKATALOG" in /*) ;; *)   SERVERKATALOG=/opt/torget;; esac
DATAKATALOG="${DATAKATALOG:-/var/lib/torget-platforms}";       case "$DATAKATALOG"   in /*) ;; *)   DATAKATALOG=/var/lib/torget;; esac
DELAD="${DELAD_DATAKATALOG:-/var/www/torget-data}"; case "$DELAD"         in /*) ;; *)   DELAD="";; esac
[ -n "$DOMAN" ] || { echo "No domain in .board-url. Put the board's address there, for example https://board.example.com" >&2; exit 2; }

echo "-> $HOST  ($DOMAN, port $PORT, service $TJANST)"
# The qr code is gitignored and therefore missing from a fresh clone. Without the exclusion below, --delete
# would remove it from the server on the first release deploy of the day, and the big screen would lose it.
rsync -az --delete --exclude /data --exclude qr.png --exclude qr.svg board/ "$HOST:$SERVERKATALOG/"
# The unit file is already stamped. Do not sed it here: a placeholder once stood as a search pattern on this
# line, got stamped itself, and then overwrote the port with another value.
scp -q deploy/torget.service "$HOST:/etc/systemd/system/$TJANST.service"
# The Caddy site block, used only if the organiser's provisioning has not already written one for this domain.
DATABLOCK=""
[ -z "$DELAD" ] || DATABLOCK="        handle_path /data/* {
                root * $DELAD
                file_server browse
        }
"
ssh "$HOST" "set -e
  mkdir -p $DATAKATALOG && chown www-data:www-data $DATAKATALOG
  [ -f /etc/torget/$TJANST.env ] || echo 'NOTE: /etc/torget/$TJANST.env is missing, so LEAD_TOKEN is not set. The organiser creates it (workshopladan: verktyg/deploya.sh).' >&2
  systemctl daemon-reload && systemctl enable --now $TJANST && systemctl restart $TJANST
  if ! grep -qxF '$DOMAN {' /etc/caddy/Caddyfile 2>/dev/null; then
    cat >> /etc/caddy/Caddyfile <<CADDY

$DOMAN {
$DATABLOCK        handle {
                reverse_proxy localhost:$PORT {
                        flush_interval -1
                }
        }
}
CADDY
    systemctl reload caddy
  fi
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do sleep 1; curl -sf localhost:$PORT/api/health && exit 0; done; echo 'the server did not answer on /api/health within 15 s' >&2; exit 1"
echo
echo "Done: $HOST"
