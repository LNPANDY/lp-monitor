#!/usr/bin/env bash
# 在 VPS 上一键部署/更新 LP Monitor（非 Docker 方式）。
# 用法：在 VPS 上 git clone 项目后，进入项目目录执行：
#   bash deploy/update.sh
# 前置：VPS 已装好 Node 20+、npm，且用 git 拉取了最新代码。

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "==> 项目目录: $ROOT"

# 1. 安装依赖（首次或更新）
if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ]; then
  echo "==> 安装依赖..."
  npm config set registry https://registry.npmmirror.com
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund
fi

# 2. 构建
echo "==> 构建..."
npm run build

# 3. 安装/更新 systemd 服务
SERVICE_SRC="$ROOT/deploy/lp-monitor.service"
SERVICE_DST="/etc/systemd/system/lp-monitor.service"
WHO="$(whoami)"
echo "==> 安装 systemd 服务（需要 sudo）..."
# 替换 service 文件里的用户名和路径
sudo bash -c "cat > '$SERVICE_DST'" <<EOF
[Unit]
Description=LP Monitor (Next.js)
After=network.target

[Service]
Type=simple
User=$WHO
WorkingDirectory=$ROOT
EnvironmentFile=$ROOT/.env.local
ExecStart=/usr/bin/env npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable lp-monitor
sudo systemctl restart lp-monitor

echo "==> 启动完成。状态："
sudo systemctl status lp-monitor --no-pager -l | head -15
echo ""
echo "==> 查看实时日志：journalctl -u lp-monitor -f"
