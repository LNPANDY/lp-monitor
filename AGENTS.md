# LP Monitor Agents

LP Monitor 是一个去中心化流动性池监控系统，包含多个智能代理用于自动发现、监控和通知流动性仓位状态变化。

## 核心代理

### 1. Scanner Agent（扫描代理）

**文件位置**: `src/lib/monitor/scanner.ts`

**职责**:
- 加载所有启用的监控钱包
- 发现每个钱包的流动性池仓位（直接持有 + 质押溯源）
- 读取仓位的区间状态（in-range / out-of-range）
- 与上次状态对比，检测状态翻转
- 基于冷却时间去重同状态告警
- 写回仓位状态到数据库

**关键功能**:
- `runScan()` - 执行完整扫描流程
- `findDirectPositions()` - 发现直接持有的仓位
- `findStakedPositions()` - 发现质押的仓位

**输出**: ScanSummary（钱包数、仓位数、超出区间数、告警发送数、错误列表）

---

### 2. Scheduler Agent（调度代理）

**文件位置**: `src/lib/monitor/scheduler.ts`

**职责**:
- 管理定时扫描任务
- 支持动态修改扫描频率
- 提供自愈机制确保调度器持续运行
- 防止重复执行（状态保护）

**关键功能**:
- `startScheduler()` - 启动定时扫描
- `ensureScheduler()` - 自愈机制，确保调度器运行
- `restartScheduler()` - 动态重启调度器
- `currentCron()` - 获取当前 cron 表达式

**自愈策略**: 在 `/api/monitor` 请求时检查调度器状态，丢失则自动重建

---

### 3. Staking Discovery Agent（质押发现代理）

**文件位置**: `src/lib/staking/discover.ts`

**职责**:
- 通过质押合约发现钱包间接持有的流动性池仓位
- 追溯质押资金池到底层流动性池
- 处理多种质押协议的适配

**关键功能**:
- `findStakedPositions()` - 发现质押仓位
- `analyzeStaked()` - 分析质押池的流动性分布
- 处理 tick 窗口过滤，确保精度

**精度修复**: 修复了跨区间累加导致的 3891 精度问题，确保 total≈13382 W0G、share≈47%

---

### 4. Adapter Agent（适配器代理）

**文件位置**: `src/lib/adapters/v3-fork.ts`

**职责**:
- 统一不同 DEX 的 V3 流动性池接口
- 处理 Uniswap V3 及其分叉（PancakeSwap、SushiSwap 等）
- 提供标准化的仓位查询接口

**关键功能**:
- `getAdapter()` - 获取对应 DEX 的适配器
- `ownerOf()` - 查询仓位所有权
- `liquidity()` - 查询仓位流动性状态

---

### 5. Notification Agent（通知代理）

**文件位置**: `src/lib/notify/index.ts`

**职责**:
- 多渠道通知发送
- 并行发送，提高响应速度
- 支持渠道状态检测和测试

**支持渠道**:
- **Telegram Bot** - 通过 botToken 和 chatId 发送
- **Bark (iOS)** - 通过 iOS 推送服务
- **Server酱 (微信)** - 通过微信服务通知
- **企业微信机器人** - 通过 webhook 发送

**关键功能**:
- `notifyAll()` - 向所有配置渠道发送通知
- `testChannel()` - 测试单个渠道配置
- `channelStatus()` - 获取所有渠道配置状态

**通知内容**: 仓位状态翻转、价格异常、流动性变化等

---

### 6. CEX Price Agent（交易所价格代理）

**文件位置**: `src/lib/cex/binance.ts`

**职责**:
- 获取中心化交易所价格作为参考
- 支持 CEX 价格阈值告警
- 处理币种映射关系

**关键功能**:
- `loadAllMappings()` - 加载币种映射
- `buildQuotesByAddr()` - 构建价格查询表
- 价格阈值检测和告警

---

## 辅助代理

### 7. Configuration Agent（配置代理）

**文件位置**: `src/lib/db/settings.ts`

**职责**:
- 管理系统配置
- 动态修改告警阈值
- 存储渠道配置信息
- 扫描频率控制

**配置项**:
- `scan_cron` - 扫描频率
- `tick_move_threshold` - 价格变动阈值
- `cex_price_threshold` - CEX 价格阈值
- 各通知渠道的认证信息

---

### 8. Database Agent（数据库代理）

**文件位置**: `src/lib/db/index.ts`

**职责**:
- 管理数据库连接
- 仓位状态持久化
- 告警历史记录
- 缓存失效管理

**数据表**:
- `positions` - 仓位状态
- `alerts` - 告警记录
- `wallets` - 监控钱包
- `dexes` - DEX 配置
- `staking` - 质押信息

---

## 工作流程

```
Scheduler Agent 定时触发
    ↓
Scanner Agent 执行扫描
    ↓
Staking Discovery Agent 发现质押仓位
    ↓
Adapter Agent 查询仓位状态
    ↓
状态翻转检测
    ↓
Notification Agent 发送告警
    ↓
Database Agent 持久化数据
```

## 独立运行模式

通过 `npm run scan` 可以独立执行一次扫描后退出，适用于：

- 调试和测试
- 系统 cron 任务触发
- 无 Next 服务环境

**文件**: `src/lib/monitor/run-once.ts`

---

## 错误处理与恢复

所有代理都实现了完善的错误处理：

1. **Scanner Agent** - 收集扫描错误，但不中断整体流程
2. **Scheduler Agent** - 自愈机制确保持续运行
3. **Notification Agent** - 单个渠道失败不影响其他渠道
4. **Database Agent** - 事务处理确保数据一致性

---

## 性能优化

1. **并行处理** - 通知、仓位查询等并行执行
2. **缓存策略** - 质押信息缓存，减少链上查询
3. **去重机制** - 冷却时间避免重复告警
4. **批量操作** - 数据库批量写入提升性能

---

## 依赖关系

```
Scheduler Agent
    ↓ 扫描
Scanner Agent
    ↓ 发现仓位
Staking Discovery Agent + Adapter Agent
    ↓ 状态查询
CEX Price Agent
    ↓ 告警发送
Notification Agent
    ↓ 数据持久化
Database Agent
```

---

## 监控指标

系统定期输出监控指标：

- 扫描钱包数量
- 发现仓位数量
- 超出区间仓位数量
- 发送告警数量
- 扫描耗时
- 错误信息

这些指标可通过 `/api/monitor` 端点实时查询。