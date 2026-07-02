#!/usr/bin/env bash
# 一键安装 gcal<->atimelogger 同步为 systemd service + timer（Linux）
# 用法：
#   bash deploy/install-systemd.sh            # 默认每 15 分钟
#   bash deploy/install-systemd.sh 10min      # 自定义间隔
# 前提：已按指南把密钥填入 scripts/.env（node 脚本会自动读取同目录 .env）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
NODE_BIN="$(command -v node || true)"
INTERVAL="${1:-15min}"

if [ -z "$NODE_BIN" ]; then
  echo "❌ 未找到 node，请先安装 Node.js >= 18" >&2
  exit 1
fi
if [ ! -f "$SCRIPT_DIR/gcal-atimelogger-sync.mjs" ]; then
  echo "❌ 未找到 $SCRIPT_DIR/gcal-atimelogger-sync.mjs" >&2
  exit 1
fi
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo "⚠️  未找到 $SCRIPT_DIR/.env，请先：cp .env.server.example scripts/.env 并填入密钥" >&2
fi

SERVICE=/etc/systemd/system/gcal-atl-sync.service
TIMER=/etc/systemd/system/gcal-atl-sync.timer

echo "写入 $SERVICE"
sudo tee "$SERVICE" >/dev/null <<EOF
[Unit]
Description=Google Calendar <-> aTimeLogger sync
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${NODE_BIN} ${SCRIPT_DIR}/gcal-atimelogger-sync.mjs
EOF

echo "写入 $TIMER（间隔 ${INTERVAL}）"
sudo tee "$TIMER" >/dev/null <<EOF
[Unit]
Description=Run gcal-atl sync every ${INTERVAL}

[Timer]
OnBootSec=2min
OnUnitActiveSec=${INTERVAL}
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now gcal-atl-sync.timer

echo "✅ 安装完成。下次触发："
systemctl list-timers | grep gcal || true
echo "查看日志： journalctl -u gcal-atl-sync.service -f"
echo "立即跑一次： sudo systemctl start gcal-atl-sync.service"
