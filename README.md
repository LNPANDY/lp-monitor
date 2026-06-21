# LP Monitor — 区块链 LP 区间监控

监控一个或多个钱包地址在 **多个区块链 / 多个 DEX** 的集中流动性（CL）LP 仓位，
**当仓位超出价格区间时立即通过 Telegram / Bark / Server酱 / 企业微信告警**。
支持把质押在第三方合约的 LP 仓位一并纳入监控（溯源归集到原钱包）。

## 功能

1. **多链**：内置 Ethereum，可在网页上添加任意 EVM 链并自定义 RPC（支持多 URL failover）。
2. **多 DEX**：内置 Ethereum / Uniswap V3；所有兼容 Uniswap V3 `NonfungiblePositionManager` 的 DEX
   （PancakeSwap V3、QuickSwap V3、Aerodrome Slipstream、Camelot V3、BaseSwap 等）用同一套适配器，填 `factory` + `NPM` 地址即可。
3. **定向监控钱包**：在配置页按链添加任意数量的钱包地址。
4. **区间判断**（核心）：读取 `positions(tokenId)` 得到 `tickLower/tickUpper`，
   读 `pool.slot0().tick`，当 `currentTick` 不在 `[tickLower, tickUpper)` 内即判定越界。
5. **多种告警渠道**：Telegram Bot、Bark（iOS）、Server酱（微信）、企业微信机器人，越界/恢复/持续越界分别有去重策略。
6. **质押溯源**：在配置页登记质押合约（含「平台」与「交易对」信息），系统通过 ERC721 转账扫描把
   从钱包转入这些合约的 NFT 仓位仍归集到原钱包监控，并继续判断区间。

## 快速开始（本地）

```bash
# 1. 安装依赖（建议用国内镜像加速）
npm config set registry https://registry.npmmirror.com
npm install

# 2. 准备环境变量
cp .env.example .env.local
#   按需填写 RPC key、Telegram/Bark 等（也可全部留空，先用默认公共 RPC 跑通）

# 3. 启动
npm run dev
#   打开 http://localhost:3000
```

启动后会自动建库（`./data/app.db`）并写入默认 Ethereum / Uniswap V3 配置，
定时扫描调度器随之启动（默认每 3 分钟一次，由 `CRON_EXPRESSION` 控制）。

## 配置流程

1. **配置页 → 通知渠道**：先在 `.env.local` 填好渠道，重启服务，回到网页点「发送测试」确认。
2. **配置页 → 链**：默认已有 Ethereum；如需 BSC/Arbitrum/Base 等，添加链名、chainId、RPC URL。
3. **配置页 → DEX**：默认已有 Ethereum / Uniswap V3；其它链/DEX 填 factory + NPM 地址。
4. **配置页 → 监控钱包**：选择链，粘贴钱包地址（0x…），可选填备注。
5. **配置页 → 质押合约**：如有质押在第三方平台的仓位，登记平台名、交易对、合约地址。
6. **仪表盘 → 立即扫描**：点击触发一次扫描，或等待定时任务。

## 通知渠道接入

| 渠道 | .env 变量 | 获取方式 |
|---|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` | [@BotFather](https://t.me/BotFather) 创建 Bot 拿 token；与 Bot 私聊后访问 `https://api.telegram.org/bot<TOKEN>/getUpdates` 取 chat_id |
| Bark | `BARK_KEY`、（可选）`BARK_SERVER` | App Store 装 Bark，复制设备 key |
| Server酱 | `SERVERCHAN_KEY` | [sct.ftqq.com](https://sct.ftqq.com) 登录后获取 SCKEY |
| 企业微信 | `WECOM_WEBHOOK_KEY` | 企业微信群 → 添加机器人 → 复制 webhook 中 `key=` 后的值 |

## 区间判断与告警策略

- **首次发现且越界** → 立即告警。
- **从「在区间内」翻转为「越界」** → 立即告警。
- **从「越界」翻回「在区间内」** → 发送恢复通知。
- **持续越界** → 每 `ALERT_COOLDOWN_MS`（默认 1 小时）重复提醒一次，避免漏报。
- 状态全部持久化在 SQLite，重启不丢。

## 项目结构

```
src/
├── app/                     # Next.js App Router
│   ├── page.tsx             # 仪表盘（仓位卡片 + 越界高亮）
│   ├── config/page.tsx      # 配置页（钱包/链/DEX/质押/通知）
│   ├── alerts/page.tsx      # 告警时间线
│   └── api/                 # REST: wallets/chains/dexes/staking/positions/alerts/monitor/notify-test
├── lib/
│   ├── db/                  # SQLite (better-sqlite3) + schema + seed
│   ├── chains/              # 多链配置（DB 驱动）+ viem PublicClient 工厂
│   ├── adapters/            # V3-fork 仓位适配器（区间判断核心）
│   ├── staking/discover.ts  # 直接持有发现 + 质押转账扫描溯源
│   ├── monitor/             # scanner 编排 + node-cron 调度 + 去重状态机
│   └── notify/              # telegram / bark / serverchan / wecom
└── instrumentation.ts       # 服务启动自动建库 + 启动调度器
```

## 常见问题

- **某 DEX 不在 V3-fork 体系**（如 Trader Joe Liquidity Book v2.1、Uniswap V4 PoolManager）：
  第一版适配器接口已抽象，可在 `src/lib/adapters/` 增加新类型并在 `registry` 注册。
- **质押仓位扫描不到**：转账扫描只覆盖最近约 20000 个区块，太久之前质押的需要在配置页手动登记，
  或后续扩展为按 `deposits(tokenId)` 反查。
- **RPC 限流**：每条链可填多个 RPC URL（空格/逗号分隔），自动 failover；生产建议用付费 RPC。

## 常用命令

```bash
npm run dev        # 开发服务（含定时调度器）
npm run build      # 生产构建
npm run typecheck  # 类型检查
npm run scan       # 不起 Web 服务，单独跑一次扫描（调试或外部 cron 用）
```

---

## 部署到 VPS

LP Monitor 需要 7×24 运行才能持续监控，所以本地开发跑通后，应部署到一台常开的 VPS。
项目提供两种部署方式，**任选其一**：

| | Docker 部署 | systemd 部署 |
|---|---|---|
| 环境要求 | VPS 装 Docker | VPS 装 Node 20+ |
| 适合 | 干净隔离、好回滚 | 更轻量、少一层 |
| 数据 | 挂载 `./data` 卷 | `/home/<user>/lp-monitor/data/` |
| 更新方式 | 重新 build 镜像 | git pull + update.sh |

### 0. 通用准备

1. **买一台 VPS**：1 核 1G 起步即可（程序本身很轻，主要消耗是 RPC 请求）。
   阿里云/腾讯云轻量、DigitalOcean、Hetzner、Vultr 都行。**推荐海外或香港节点**，
   因为 Telegram Bot 和大部分公共 RPC 在国内访问不稳定。
2. **把代码弄上 VPS**（两种之一）：
   - **方式 A（推荐，便于后续更新）**：把项目推到 GitHub 私有仓库，VPS 上 `git clone`。
   - **方式 B**：本地打包上传：`rsync -av --exclude node_modules --exclude .next --exclude data ./ user@vps-ip:~/lp-monitor/`
3. **配置 `.env.local`**：在 VPS 项目根目录复制 `.env.example` → `.env.local`，填好通知渠道 token。
   这是**部署前必须做的**，否则告警发不出去。

```bash
# 在 VPS 项目目录里
cp .env.example .env.local
nano .env.local   # 至少填好一个通知渠道（如 BARK_KEY）
```

### 方式一：Docker 部署（推荐）

VPS 装好 Docker（`curl -fsSL https://get.docker.com | sh`）后：

```bash
cd ~/lp-monitor

# 1. 构建镜像（首次约 3-5 分钟，主要在编译 better-sqlite3）
docker build -t lp-monitor:latest .

# 2. 启动容器（前台先跑一次看日志是否正常）
docker run -it --rm \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  --env-file .env.local \
  --name lp-monitor \
  lp-monitor:latest

# 3. 确认没问题后，后台常驻 + 开机自启
docker run -d --restart unless-stopped \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  --env-file .env.local \
  --name lp-monitor \
  lp-monitor:latest

# 4. 查看日志
docker logs -f lp-monitor

# 更新到新版本
git pull
docker build -t lp-monitor:latest .
docker restart lp-monitor
```

### 方式二：systemd 部署（不用 Docker）

VPS 装 Node 20+（`curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs`）后：

```bash
cd ~/lp-monitor

# 一键安装依赖 + 构建 + 注册为 systemd 服务（开机自启 + 崩溃自动重启）
bash deploy/update.sh

# 之后日常操作：
sudo systemctl status lp-monitor    # 查看状态
sudo systemctl restart lp-monitor   # 重启
journalctl -u lp-monitor -f         # 实时日志

# 更新到新版本
git pull && bash deploy/update.sh
```

### 反向代理 + HTTPS（重要）

默认监听 `http://VPS-IP:3000`，强烈建议前面套一层 Nginx + HTTPS，避免明文传输和端口暴露。

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

# 配置 Nginx（假设域名 lp.example.com 已解析到 VPS）
sudo tee /etc/nginx/sites-available/lp-monitor <<'EOF'
server {
    server_name lp.example.com;   # 换成你的域名

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/lp-monitor /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 申请 Let's Encrypt 免费证书
sudo certbot --nginx -d lp.example.com
```

完成后访问 `https://lp.example.com` 即可。

### 备份与迁移

整个应用的**全部状态**只有两样东西：

1. `data/app.db`（SQLite：链/DEX/钱包配置 + 历史告警 + token 缓存）
2. `.env.local`（通知渠道 token）

迁移到新 VPS 只需：

```bash
# 旧机器
scp data/app.db user@new-vps:~/lp-monitor/data/
scp .env.local  user@new-vps:~/lp-monitor/
# 新机器重新启动服务即可，所有配置和历史告警都在
```

或者在网页「配置 → 导出配置」下载 JSON 文件，新机器「导入配置」一键恢复（不含历史告警，但配置全在）。

### 部署后的小提示

- **首次启动**：访问网页 → 配置页确认链/DEX/钱包都在 → 点仪表盘「立即扫描」验证一次。
- **改扫描频率**：直接在仪表盘的「扫描频率」卡片里选预设或填 cron，热生效无需重启。
- **更换 RPC**：生产建议用付费 RPC（Alchemy/QuickNode/Ankr 等），免费公共 RPC 在高频轮询时容易被限流。
- **不要把端口直接暴露公网**：要么用上面的 Nginx 反代，要么用 SSH 隧道临时访问。

## 安全提示

- `.env.local` 含敏感 token，已默认 gitignore，不要提交。
- 本应用只读链上数据并发送通知，不涉及私钥或交易签名。
- 告警内容含钱包地址与仓位信息，请确认通知渠道的隐私性。
