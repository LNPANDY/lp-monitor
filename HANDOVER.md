# LP Monitor 项目交接与实施蓝图（HANDOVER.md）

> **当前系统版本**：`v0.22.3`（已推送到 GitHub `main` 分支）  
> **代码仓库**：`LNPANDY/lp-monitor`  
> **更新时间**：2026-11-13  

---

## 一、 系统现状与近期交付成果

### 1. 核心架构与功能矩阵
- **多链 V3 集中流动性监控**：实时追踪 Uniswap V3 及分叉 DEX（0G Zia 等）仓位状态（In-range / Out-of-range）。
- **全站「不稳定币 / 稳定币」方向统一与去 Tick 化展示（v0.22.3 交付）**：
  - 自动将稳定币在前的交易对默认翻转为 `不稳定币/稳定币`（左跌右涨），统一仓位卡片、双指针、探针、建仓面板、Merkl 雷达及所有告警推送的正负号与涨跌/上下界描述。
  - 全面移除界面与告警中的原始 Tick 刻度展示，替换为人类可读的实际价格区间（`priceLow ~ priceHigh`）与套利目标价。
- **Zia 质押溯源与收益雷达（Module ⑦）**：
  - 自动穿透 ZiaVault 托管池，精准统计窄幅对手盘 TVL 与真实竞争仓位数。
  - Merkl 激励透视：实时拆解三桶权重（`60% 活跃 L 桶 + 20% Token0 + 20% Token1`），计算投入 \$1,000 的单格年化（APR）与各代币被动持币桶年化。
- **CEX 双指针与手续费死角雷达（v0.22.2 修复）**：
  - 接入 Binance WebSocket 秒级行情，计算池子隐含目标 Tick。
  - **手续费死角保护机制（Fee Deadzone）**：引入 `feeTicks`（如 `0.30%` 池对应 `30 tick`）。当币安与链上价差小于单边手续费死角时，套利无法触发，真实套利目标 Tick 维持在格内，彻底消除误报出格。
- **双模极速建仓面板（Module ⑧）**：
  - **模式 A（⚡ 最小单格）**：集中火力冲刺 60% 活跃 L 奖励池。
  - **模式 B（🛡️ 0 ~ 现价略高）**：重仓稳定币（98%+ USDC.e）+ 极少量主币（0G/ETH/SOL），下跌永不越界、不接飞刀，专吃被动持币补贴桶。
- **全流程容灾与断点重试（v0.22.1 交付）**：
  - 针对钱包取消/签名拒绝引入两级重试确认弹窗与面板黄底重试按钮。
  - 链上状态动态探测（`readNftOnChainStatus`），断点跳过已执行步骤。
  - 提供独立的「🔓 仅解押」与「⚡ 免签 NFT 质押授权（setApprovalForAll）」能力。
- **主页控制台增强（v0.22.0 交付）**：
  - 顶栏常驻版本徽章。
  - 扫描状态栏常驻 **「🌙 睡眠低频模式」** 开关与倒计时（支持 4h/6h/8h/10h 及自定义时长）。
  - 探针建仓与极速 Swap 面板支持一键折叠/展开。

---

## 二、 关键配置与环境清单

- **Node.js**：v20+ / v24 LTS
- **开发框架**：Next.js 14（App Router）+ TailwindCSS + viem
- **本地存储**：SQLite (`lp-monitor.db`)，进程内持久化存储：
  - 监控钱包 (`wallets`)、DEX 与质押配置 (`dexes`, `staking`)
  - 仓位状态与告警历史 (`positions`, `alerts`)
  - 探针收藏池 (`liquidity_favorites`)
  - 币种与 CEX 映射表 (`token_symbols`)
- **后台扫描与自愈**：
  - 支持 `npm run scan` 独立单次运行模式。
  - 调度器具备自愈机制，在访问 `/api/monitor` 时自动校验并恢复 cron。

---

## 三、 即将开展的下一阶段重点任务：小资金安全托管钱包体系

### 1. 业务目标
针对用户小资金高频挖 `W0G/USDC.e` 等流动性池的痛点，摆脱浏览器钱包插件频繁弹窗签名的繁琐流程，实现：
1. **一键建仓并自动质押**（Approve + Mint + Deposit 后端连续上链）
2. **一键解押并自动撤池**（Withdraw + Collect + Burn）
3. **一键 DEX 快速兑换配平**（SwapRouter）
4. **一键申领 Merkl 跨链奖励并直发主钱包**
5. **一键将闲置本金与收益快速归集回冷/主钱包**

### 2. 架构定型：方案 B（AES-256 加密托管 EOA 子钱包 + 硬编码主钱包归集 + 交易白名单防火墙）
#### 为什么选择方案 B（对比方案 A 智能合约代理）：
- **跨链发奖零痛点**：若项目方未来将 Merkl 奖励发在 Arbitrum、Base 或 Ethereum 等其他链，EOA 私钥具备全 EVM 链同地址天然属性，可直接在对应链一键领奖；而普通合约在未同地址部署的跨链环境下存在资产被卡风险。
- **免部署合约，开箱即用**：开发周期短、无链上额外合约漏洞风险。

#### 核心安全防线设计：
1. **私钥 AES-256-GCM 本地加密**：
   - 硬盘与数据库只存密文。
   - 用户在网页端输入「独立解锁口令」后，解密私钥仅存在 Node 运行时内存中，支持设置会话有效期（如 12h/24h）或一键锁定。
2. **主钱包归集地址代码级死锁**：
   - 后端环境变量写死 `MASTER_WALLET_ADDRESS`。
   - 所有转账归集接口**不接受前端传入的任何目标地址参数**，从根本上防止因 XSS 或注入导致资金被转至黑客地址。
3. **交易防火墙（Signer Guard）**：
   - 签名层拦截：除发往 `MASTER_WALLET_ADDRESS` 的转账外，严禁向任何未在白名单（Zia NPM、Zia Router、ZiaVault、Merkl Distributor）中的地址发送代币授权或转移调用。
4. **秒级推送与熔断**：
   - 任何托管签名上链立即通过 Telegram/Bark 发送附带 TxHash 的通知；限制单位时间内的 Gas 消耗与调用频次。

---

## 四、 后续开发防爆铁律（严禁破坏）

为避免长会话卡顿或上下文膨胀，后续代理人必须严格遵守已写入 [`AGENTS.md`](file:///home/antigravity/LNPANDY/lp-monitor/AGENTS.md) 的铁律：

1. **大文件轻量化读取**：
   - 严禁对 `src/app/page.tsx`、`src/components/mint-position-panel.tsx`、`src/components/liquidity-probe.tsx` 等大型组件全量读取数百行。必须先用 `grep -n` 定位，单次 `view_file` 严格限制在上下 **50 ~ 100 行** 内。
2. **Merkl 等大规模数据分析三道硬保险**：
   - **保险一（本地落盘）**：全网数据留在本地磁盘（如 `/tmp/` 或 `scratch/`），在 Node 内存中做有效性与日均 $\ge \$50$ 门槛过滤，禁止原始 JSON 涌入上下文。
   - **保险二（单行文本）**：严禁在命令行输出 `console.log(JSON.stringify(...))`。每条记录压缩为一行不超过 80 字符的紧凑纯文本。
   - **保险三（物理熔断）**：Shell 执行命令末尾强制加上 `| head -n 35` 物理熔断管道，单次上下文输出严格控制在 35 行以内。

---

## 五、 新会话启动指南

如需开启托管钱包功能开发，推荐在新会话中按以下步骤推进：
1. 确认系统依赖及编译状态：`npm run typecheck && npm run build`。
2. 创建后端签名器安全模块：`src/lib/wallet/custody-signer.ts`（实现 AES-256 解密、交易白名单、主钱包硬锁定）。
3. 开发前端托管钱包控制栏：集成在主控台顶栏或独立浮窗中（提供口令解锁、锁定、一键归集、余额查看）。
4. 对接 Mint/Staking/Swap 模块的托管代理调用端点。

---

## 六、 待办事项（TODO）

- [x] **全站涨跌与上下界口径统一 + 移除界面原始 Tick 展示**：基于 `pair_flip` 与「不稳定币 / 稳定币」计价口径（新增 [`display-orientation.ts`](src/lib/v3/display-orientation.ts)），全面统一仓位卡片、双指针进度条、探针、建仓面板、Merkl 雷达及全部告警推送的正负号与涨跌/上下界描述，并将界面及推送中的原始 Tick 数值全部替换为换算后的实际价格展示。
- [ ] **安装 `modern-web-guidance` Skill + `lp-monitor` UI 整体重塑**：
  1. 稍后安装接入 [`GoogleChrome/modern-web-guidance`](https://github.com/GoogleChrome/modern-web-guidance) Skill（现代原生 `<dialog>` / Popover、过渡动画、容器查询、`content-visibility` 等规范）。
  2. **先产出 UI 重塑效果图供确认**，待视觉方案敲定后再对主控台、仓位卡片、探针与建仓/Swap 面板进行整体改版落地。
- [ ] **小资金安全托管钱包体系（方案 B）**：按第三章蓝图实施 AES-256-GCM 托管子钱包、主钱包死锁归集与交易白名单防火墙。

