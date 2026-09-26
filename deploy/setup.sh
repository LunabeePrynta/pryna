#!/usr/bin/env bash
# One-time (and re-runnable) server setup for Ubuntu 24.04, e.g. a DigitalOcean droplet.
#
#   1. Upload and unzip the app on the server, then from inside the app folder run:
#        sudo bash deploy/setup.sh ship.yourstore.com
#   2. Put your Shopify API key/secret in /etc/indiapost-app.env and run:
#        sudo systemctl restart indiapost-app
#
# Re-run the same command after uploading a new version to update the app.
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: sudo bash deploy/setup.sh <domain pointing to this server, e.g. ship.yourstore.com>" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo." >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/indiapost-app
DATA_DIR=/var/lib/indiapost-app
ENV_FILE=/etc/indiapost-app.env
APP_USER=indiapost

echo "==> Swap (keeps small 1 GB droplets stable)"
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync ufw debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])\.'; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v caddy >/dev/null; then
  echo "==> Caddy (web server with automatic HTTPS)"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

echo "==> App user and folders"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR/labels"

echo "==> Copying app to $APP_DIR"
rsync -a --delete --exclude node_modules --exclude data --exclude .git --exclude dist --exclude .env "$SRC_DIR"/ "$APP_DIR"/
cd "$APP_DIR"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Creating $ENV_FILE"
  cat > "$ENV_FILE" <<ENV
# India Post Shipping app settings. After editing: sudo systemctl restart indiapost-app
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_APP_URL=https://$DOMAIN
SHOPIFY_API_VERSION=2026-07
SHOPIFY_APP_PROXY_PATH=/apps/track

INDIAPOST_BASE_URL=https://test.cept.gov.in/beextcustomer
INDIAPOST_WEBHOOK_SECRET=$(openssl rand -hex 24)
INDIAPOST_WEBHOOK_IPS=

ENCRYPTION_KEY=$(openssl rand -hex 32)

PORT=3000
TRUST_PROXY=loopback
DATABASE_PATH=$DATA_DIR/app.db
LABEL_DIR=$DATA_DIR/labels
TRACKING_POLL_MINUTES=30
ENV
  chmod 600 "$ENV_FILE"
else
  sed -i "s#^SHOPIFY_APP_URL=.*#SHOPIFY_APP_URL=https://$DOMAIN#" "$ENV_FILE"
fi

echo "==> Service"
install -m 644 "$APP_DIR/deploy/indiapost-app.service" /etc/systemd/system/indiapost-app.service
systemctl daemon-reload
systemctl enable indiapost-app >/dev/null

echo "==> Web server for https://$DOMAIN"
sed "s/__DOMAIN__/$DOMAIN/" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "==> Firewall (SSH, HTTP, HTTPS)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

if grep -qE '^SHOPIFY_API_KEY=.+' "$ENV_FILE" && grep -qE '^SHOPIFY_API_SECRET=.+' "$ENV_FILE"; then
  systemctl restart indiapost-app
  sleep 2
  systemctl --no-pager --lines=5 status indiapost-app || true
  echo
  echo "Done. Check: https://$DOMAIN/health"
else
  echo
  echo "Almost done. Next:"
  echo "  1. sudo nano $ENV_FILE   → fill SHOPIFY_API_KEY and SHOPIFY_API_SECRET"
  echo "  2. sudo systemctl restart indiapost-app"
  echo "  3. Open https://$DOMAIN/health — it should show {\"ok\":true}"
fi
echo
echo "Server public IP (give this to India Post for whitelisting): $(curl -fsS https://api.ipify.org || echo unknown)"
echo "India Post webhook URL: https://$DOMAIN/webhooks/indiapost?secret=$(grep '^INDIAPOST_WEBHOOK_SECRET=' "$ENV_FILE" | cut -d= -f2)"
