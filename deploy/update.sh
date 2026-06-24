#!/usr/bin/env bash
# 在 VPS 上一键部署/更新 LP Monitor（非 Docker 方式）。
# 用法：在 VPS 上 git clone 项目后，进入项目目录执行：
#   bash deploy/update.sh
# 前置：VPS 已装好 Node 20+、npm，且用 git 拉取了最新代码。

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "==> 项目目录: $ROOT"

# 1. 安装依赖（仅在 package-lock.json 内容变化时才执行）
#    用内容 hash 判断而非时间戳——git checkout 的文件 mtime 不可靠，
#    而且不希望每次 update 都重装（npm ci 会清空 node_modules，很慢）。
REGISTRY_SET="$(npm config get registry 2>/dev/null || echo '')"
LOCK_HASH_FILE="$ROOT/.package-lock.hash"
NEW_HASH="$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1 || shasum -a 256 package-lock.json 2>/dev/null | cut -d' ' -f1)"
OLD_HASH="$(cat "$LOCK_HASH_FILE" 2>/dev/null || echo '')"

if [ ! -d node_modules ] || [ "$NEW_HASH" != "$OLD_HASH" ]; then
  echo "==> 安装依赖（lock 文件变化或首次安装）..."
  # 首次用国内镜像加速；已配置则不动
  if [ -z "$REGISTRY_SET" ] || [ "$REGISTRY_SET" = "undefined" ] || [ "$REGISTRY_SET" = "https://registry.npmjs.org/" ]; then
    npm config set registry https://registry.npmmirror.com
  fi
  # 用 npm install 增量更新（不删 node_modules），比 npm ci 快得多；
  # 静默 deprecation 警告（那些是子依赖的，无害且刷屏）。
  npm install --no-audit --no-fund --loglevel=error 2>&1 | grep -v -E "npm warn deprecated|npm notice" || true
  echo "$NEW_HASH" > "$LOCK_HASH_FILE"
else
  echo "==> 依赖无变化，跳过安装"
fi

# 2. 构建（next build 必须每次跑，因为源码可能变了）
#    静默 lint/info 类输出，只保留关键信息。
echo "==> 构建..."
npm run build 2>&1 | grep -v -E "^$" | tail -40

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
