#!/usr/bin/env bash
# One-shot setup for a fresh Hetzner (Debian/Ubuntu) box.
# Run as root:  bash setup.sh https://github.com/<you>/<repo>.git
set -euo pipefail

REPO="${1:?usage: setup.sh <git-repo-url>}"
BASE=/opt/newsedge

echo "[1/6] packages"
apt-get update -qq
apt-get install -y -qq python3-venv git curl >/dev/null

echo "[2/6] user + clone"
id newsedge >/dev/null 2>&1 || useradd -r -m -d "$BASE" -s /usr/sbin/nologin newsedge
if [ ! -d "$BASE/repo" ]; then
  git clone --depth 1 "$REPO" "$BASE/repo"
fi
# the project lives in newsedge/ inside the repo
ln -sfn "$BASE/repo/newsedge" "$BASE/newsedge"

echo "[3/6] venv"
python3 -m venv "$BASE/venv"
"$BASE/venv/bin/pip" install -q -r "$BASE/newsedge/requirements.txt"

echo "[4/6] reachability check (Polymarket API from this box)"
code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 \
  "https://gamma-api.polymarket.com/markets?limit=1" || echo 000)
echo "   gamma-api.polymarket.com -> HTTP $code  (200 = good; if blocked, you need a different region/proxy)"

echo "[5/6] permissions + service"
mkdir -p "$BASE/newsedge/data"
chown -R newsedge:newsedge "$BASE"
touch /var/log/newsedge.out /var/log/newsedge.err
chown newsedge:newsedge /var/log/newsedge.out /var/log/newsedge.err
cp "$BASE/newsedge/deploy/newsedge.service" /etc/systemd/system/newsedge.service
systemctl daemon-reload
systemctl enable --now newsedge.service

echo "[6/6] done. follow it with:"
echo "   systemctl status newsedge"
echo "   tail -f /opt/newsedge/newsedge/data/alerts.log"
echo "   (score once markets resolve:)  sudo -u newsedge /opt/newsedge/venv/bin/python \\"
echo "      /opt/newsedge/newsedge/score_alerts.py --only-actionable --min-conf 0.6"
