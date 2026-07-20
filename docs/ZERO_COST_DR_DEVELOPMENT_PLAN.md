# CloudFlare-ImgBed 零费用多渠道备份容灾重构开发文档

> 文档版本：1.0  
> 目标版本：CloudFlare-ImgBed Zero-Cost DR V3  
> 基线项目：MarSeventh/CloudFlare-ImgBed  
> 基线版本：v2.7.5（2026-07-15）  
> 编写日期：2026-07-20  
> 部署目标：Cloudflare Free Plan  
> 第一优先级：Cloudflare 侧不产生任何账单  
> 第二优先级：多渠道备份、读取容灾、自动修复  
> 推荐保存路径：`docs/ZERO_COST_DR_DEVELOPMENT_PLAN.md`

---

## 0. 重要声明

### 0.1 “永久免费”的准确含义

本项目的目标是：

1. 不订阅 Workers Paid。
2. 不启用任何必须按量付费或超量后自动计费的 Cloudflare 产品。
3. 不依赖 R2 作为系统必需组件。
4. 只使用 Cloudflare Free Plan 当前提供的免费资源。
5. 达到免费额度或应用软配额后，系统主动停止写入、复制或后台任务，宁可临时降级，也不升级付费。
6. 所有可能产生费用的功能默认关闭，并且需要修改代码级开关后才能启用。

无法对“未来永远为零费用”作出平台层面的绝对保证，因为：

- Cloudflare 未来可能调整免费套餐和使用条款。
- 域名注册和续费通常不是 Cloudflare 免费资源的一部分。
- Telegram、WebDAV、S3、Hugging Face 等外部存储渠道的费用和规则由各服务商决定。
- 用户可能在 Cloudflare 控制台手动升级套餐或启用按量付费产品。

因此，本项目采用以下可执行定义：

> 在 Cloudflare 当前免费计划不发生重大变化、用户不手动升级账户、不启用计费产品的前提下，系统不会主动产生 Cloudflare 使用账单；一旦接近免费资源软上限，系统自动降级或停止写入。

### 0.2 不使用 R2 作为默认组件的原因

Cloudflare R2 有免费额度，但它本质上是按存储量和操作量计费的产品。超过免费额度后会产生费用。预算告警只能在费用达到阈值时通知，不能作为阻止收费的硬开关。

因此：

- `ZERO_COST_MODE=true` 时，R2 Adapter 必须被禁用。
- 管理后台不显示“创建 R2 渠道”按钮。
- Wrangler 配置中不创建 R2 binding。
- 上传流程不能依赖 R2 中转。
- 队列任务必须从已有健康副本读取源文件。
- 后续如确实需要 R2，应在单独分支和单独 Cloudflare 账户中实验，不合并到零费用默认配置。

---

## 1. 项目背景

CloudFlare-ImgBed 是一个支持 Serverless 和 Docker 部署的文件托管项目，上游项目当前支持：

- Telegram
- Discord
- Cloudflare R2
- S3 兼容存储
- Hugging Face
- WebDAV
- 文件上传、管理、读取、删除
- 用户、目录、鉴权
- 内容审核
- RESTful API
- WebDAV

当前上游仓库使用 JavaScript，主要目录包括：

```text
database/
deploy/
frontend-dist/
functions/
├── api/
├── dav/
├── file/
├── random/
├── upload/
└── utils/
```

上游已有：

- Pages/Workers 部署能力
- KV 使用
- R2 使用
- D1 数据库适配
- 多存储渠道
- 分片上传
- Docker 运行模式

本次重新 fork 后，不直接在上传流程中继续增加 `if channel === ...`。多渠道容灾必须作为独立基础设施层开发。

---

## 2. 重构总体目标

### 2.1 核心目标

系统应当将“用户上传的文件”视为一个逻辑文件，将 Telegram、WebDAV、S3 等渠道中的对象视为物理副本。

```text
逻辑文件 File
├── 副本 Replica A：WebDAV 主存储
├── 副本 Replica B：Telegram 备份
└── 副本 Replica C：其他用户配置渠道
```

最终实现：

- 一个逻辑文件对应多个存储副本。
- 上传时按策略写入至少两个渠道。
- 主渠道不可用时自动读取备份。
- 损坏或缺失的副本可自动修复。
- 删除时所有副本均进入删除任务。
- 删除失败不会让文件重新对外可见。
- 新增渠道只需要实现统一 Adapter。
- Cloudflare 免费额度不足时自动停止写入。
- 不依赖收费资源维持基本读取能力。

### 2.2 目标服务等级

零费用模式的目标不是高并发商业图床，而是：

- 个人图床
- 小团队文件托管
- 博客图片
- 文档附件
- 自用 NAS 入口
- 低到中等访问量的静态文件分发

建议目标：

| 指标 | 目标 |
|---|---:|
| 单文件默认上限 | 10 MiB |
| 单文件硬上限 | 20 MiB |
| 同步写入渠道 | 最多 2 个 |
| 总副本目标 | 2–3 个 |
| 每日上传数软上限 | 500 |
| 每日队列任务软上限 | 2,000 |
| 每日 Worker 请求软上限 | 80,000 |
| D1 每日写入软上限 | 60,000 行 |
| D1 每日读取软上限 | 3,000,000 行 |
| 管理员数量 | 1–5 |
| 默认用户模式 | 私有或邀请制 |

### 2.3 非目标

V3 首版不实现：

- 在线图片压缩
- 图片格式转换
- 图片水印
- AI 审核
- 视频转码
- 在线解压
- 大文件分片合并
- 服务端完整 SHA-256 扫描
- 高并发公共匿名图床
- 跨 Cloudflare 账户双活
- R2 临时中转
- Durable Objects
- Cloudflare Images
- Cloudflare Stream
- Browser Rendering
- Workers AI
- Vectorize
- 付费日志服务
- 自动升级到付费计划

这些功能会增加 CPU、请求、存储或按量费用风险。

---

## 3. Cloudflare 免费资源约束

以下数据基于 2026-07-20 前后的官方文档。开发和每次发布前必须重新核对。

### 3.1 Workers Free

官方免费限制包括：

- 100,000 请求/天
- HTTP 请求 CPU 时间 10 ms
- 内存 128 MB
- 每次请求最多 50 个外部 subrequests
- 每次请求最多 6 个并发外连
- 单次请求体在 Free 域名套餐下最大 100 MB
- 每个账户最多 5 个 Cron Triggers
- 每个 Worker 版本最多 20,000 个静态文件
- 单个静态文件最大 25 MiB

本项目设置更低的应用软限制：

```text
Worker 请求：80,000/天
单文件：10 MiB 默认，20 MiB 硬限制
外部 subrequest：单次上传不超过 6
并发存储写入：最多 2
Cron：最多使用 2 个
静态资源：控制在 2,000 个以内
```

达到软限制后：

- 禁止匿名上传。
- 禁止新用户注册。
- 暂停后台深度校验。
- 保留文件读取和管理员登录。
- 管理后台显示“免费额度保护模式”。

### 3.2 D1 Free

官方免费计划当前包括：

- 5,000,000 行读取/天
- 100,000 行写入/天
- 账户总存储 5 GB
- 单数据库最大 500 MB
- 免费账户最多 10 个数据库
- Free 额度达到后查询会失败，而不是自动按量收费

本项目使用一个主数据库，限制为：

```text
数据库软上限：350 MB
每日读取软上限：3,000,000 行
每日写入软上限：60,000 行
单页分页上限：100
管理端导出最大行数：10,000
```

数据库中禁止存储：

- 文件二进制
- 缩略图
- Base64 文件
- 大段日志正文
- 完整远端响应
- 密钥
- Access Token
- 带签名 URL

### 3.3 Cloudflare Queues Free

官方免费计划当前包括：

- 10,000 operations/天
- 免费消息保留时间固定为 24 小时
- 正常消息通常产生写入、读取、删除 3 次 operation
- 重试会增加读取 operation
- 消息大于 64 KB 会按多个 operation 计算

本项目限制：

```text
单条消息目标大小：小于 2 KB
每日新任务软上限：2,000
默认最大重试：5
队列中不传文件内容
队列中不传 Base64
队列中不传完整 metadata
```

消息只传：

```json
{
  "v": 1,
  "jobId": "job_xxx",
  "fileId": "file_xxx",
  "replicaId": "rep_xxx",
  "operation": "CREATE_REPLICA"
}
```

因为免费队列消息只保留 24 小时，D1 中的 `storage_jobs` 才是任务事实来源。Queue 只是唤醒执行器。

### 3.4 Turnstile Free

Turnstile 可用于：

- 匿名上传
- 登录
- 注册
- 重置密码
- API Token 创建

Turnstile Free 可用于大多数生产应用。零费用模式应默认启用，减少机器人消耗 Worker、D1 和外部存储额度。

### 3.5 明确禁止的 Cloudflare 产品

`ZERO_COST_MODE=true` 时禁止：

| 产品 | 原因 |
|---|---|
| R2 | 超出免费额度后按量计费 |
| Workers Paid | 固定月费及超量计费 |
| Cloudflare Images | 付费图片服务 |
| Stream | 付费视频服务 |
| Workers AI | 可能产生计费 |
| Browser Rendering | 可能产生计费 |
| Vectorize | 可能产生计费 |
| Containers | 可能产生计费 |
| Durable Objects 付费能力 | 非必要且有计费风险 |
| Logpush 付费目的地 | 非必要 |
| 付费 Access/Zero Trust 扩展 | 非必要 |

### 3.6 Cloudflare 账户建议

为最大程度避免误收费：

1. 为本项目创建独立 Cloudflare 账户。
2. 账户保持 Free Plan。
3. 不订阅 Workers Paid。
4. 不启用 R2。
5. 不添加不必要的付款方式。
6. 不点击任何“升级以继续”按钮。
7. 不使用第三方自动化升级套餐。
8. 每月检查 Cloudflare Subscriptions 页面。
9. 每次发布前检查 Wrangler bindings。
10. CI 中扫描禁止资源。

---

## 4. 推荐架构

### 4.1 总体架构

```mermaid
flowchart LR
    B[浏览器/客户端] --> W[Cloudflare Worker]
    W --> A[鉴权/Turnstile/限流]
    A --> U[上传编排器]
    U --> P[主存储 Adapter]
    U --> S[同步备份 Adapter]

    W --> D1[(D1 元数据)]
    W --> Q[Cloudflare Queue]

    Q --> C[Queue Consumer]
    C --> O[存储编排器]
    O --> P
    O --> S
    O --> X[第三副本 Adapter]

    B --> R[/file/:id 统一读取地址]
    R --> W
    W --> D1
    W --> O

    CRON[Cron Trigger] --> J[任务补发/健康检查]
    J --> D1
    J --> Q

    ADMIN[管理后台] --> W
```

### 4.2 为什么不需要 Cloudflare 文件中转

上传时：

- 小文件由 Worker 同时写入两个外部存储。
- 至少一个成功时可保留为 `degraded`。
- 两个成功时标记为 `available`。
- 第三个副本由 Queue 从健康副本读取后创建。
- 修复任务也从健康副本读取。

这意味着 Cloudflare 只处理请求、元数据和任务，不长期保存文件。

### 4.3 推荐渠道组合

零费用模式推荐：

#### 组合 A：自有 NAS + Telegram

```text
主存储：WebDAV / NAS
备份：Telegram 私有频道
```

优点：

- 主文件由用户自己控制。
- Telegram 可作为异地备份。
- 不依赖 R2。

风险：

- 家庭 NAS 可能离线。
- Telegram 的规则和接口限制可能变化。

#### 组合 B：两个 WebDAV

```text
主存储：WebDAV A
备份：WebDAV B
```

要求：

- 两个 WebDAV 不能在同一台物理设备。
- 最好位于不同网络和不同地点。

#### 组合 C：WebDAV + 用户自备 S3 兼容存储

```text
主存储：WebDAV
备份：S3 Compatible
```

说明：

- S3 费用由外部服务商决定。
- 项目无法保证外部 S3 免费。
- 管理后台必须显示费用风险提示。

#### 组合 D：Telegram + Hugging Face

仅适合明确符合相关服务条款的个人、小规模使用。不能将第三方免费服务视为无限容量对象存储。

---

## 5. 重新 Fork 后的仓库策略

### 5.1 操作步骤

1. 删除当前混乱 fork。
2. 在 GitHub 上重新 fork：
   `MarSeventh/CloudFlare-ImgBed`
3. Clone 新 fork。
4. 添加 upstream。
5. 创建重构分支。

```bash
git clone https://github.com/<your-name>/CloudFlare-ImgBed.git
cd CloudFlare-ImgBed

git remote add upstream https://github.com/MarSeventh/CloudFlare-ImgBed.git
git fetch upstream

git switch main
git reset --hard upstream/main
git push --force-with-lease origin main

git switch -c feature/zero-cost-dr-v3
git push -u origin feature/zero-cost-dr-v3
```

### 5.2 分支规则

```text
main
├── 与 upstream/main 尽量保持一致
└── 不直接开发

feature/zero-cost-dr-v3
├── V3 集成分支
├── 只接受经过测试的 PR
└── 定期 rebase/merge upstream

feature/storage-adapters
feature/replication-core
feature/zero-cost-guard
feature/admin-operations
feature/database-v3
```

### 5.3 与上游同步策略

每次同步：

```bash
git fetch upstream
git switch main
git reset --hard upstream/main
git push --force-with-lease origin main

git switch feature/zero-cost-dr-v3
git merge main
```

冲突原则：

- 上游页面和普通功能优先保留。
- V3 只接管存储编排、文件副本和运维任务。
- 不直接重写上游全部 UI。
- 不把存储 Adapter 逻辑写回 `upload/index.js`。
- 每次上游合并后运行完整 Adapter 和容灾测试。

### 5.4 提交规范

```text
feat(storage): add webdav replica adapter
feat(replication): add replica repair job
feat(cost): stop writes near free quota
fix(read): fallback when primary returns 404
refactor(db): isolate replica repository
test(adapter): add telegram contract tests
docs(dr): document zero-cost failover
```

---

## 6. 目录结构设计

建议新增 `functions/core`、`functions/adapters` 和 `functions/jobs`，保留上游原路由作为兼容入口。

```text
functions/
├── api/
│   ├── storage/
│   │   ├── channels.js
│   │   ├── policies.js
│   │   ├── replicas.js
│   │   ├── jobs.js
│   │   ├── health.js
│   │   └── usage.js
│   ├── files/
│   │   ├── detail.js
│   │   ├── delete.js
│   │   ├── verify.js
│   │   └── repair.js
│   └── ...
├── upload/
│   ├── index.js
│   └── ...
├── file/
│   └── [[path]].js
├── core/
│   ├── upload/
│   │   ├── uploadService.js
│   │   ├── validation.js
│   │   └── idempotency.js
│   ├── storage/
│   │   ├── adapter.js
│   │   ├── registry.js
│   │   ├── orchestrator.js
│   │   ├── policyEngine.js
│   │   ├── replicaService.js
│   │   └── readPlanner.js
│   ├── jobs/
│   │   ├── jobService.js
│   │   ├── dispatcher.js
│   │   ├── retryPolicy.js
│   │   └── handlers/
│   ├── cost/
│   │   ├── zeroCostGuard.js
│   │   ├── quotaService.js
│   │   └── featureGate.js
│   ├── health/
│   │   ├── channelHealth.js
│   │   └── circuitBreaker.js
│   └── security/
│       ├── secrets.js
│       ├── rateLimit.js
│       └── audit.js
├── adapters/
│   ├── telegram/
│   ├── webdav/
│   ├── s3/
│   ├── huggingface/
│   └── discord/
├── queues/
│   └── storageConsumer.js
├── scheduled/
│   ├── dispatchPendingJobs.js
│   └── maintenance.js
└── repositories/
    ├── fileRepository.js
    ├── replicaRepository.js
    ├── channelRepository.js
    ├── jobRepository.js
    └── quotaRepository.js

database/
├── init.sql
└── migrations/
    ├── 0030_storage_channels.sql
    ├── 0031_storage_policies.sql
    ├── 0032_file_replicas.sql
    ├── 0033_storage_jobs.sql
    ├── 0034_tombstones.sql
    └── 0035_usage_counters.sql

frontend-dist/
└── ...
```

---

## 7. 模块边界

### 7.1 API 层

职责：

- 解析请求
- 身份认证
- 权限检查
- Turnstile 校验
- 参数校验
- 调用 Service
- 标准化响应

禁止：

- 直接判断 Telegram/WebDAV/S3
- 直接写渠道特定逻辑
- 在 API 文件拼复杂 SQL
- 直接执行跨渠道修复

### 7.2 Service 层

职责：

- 上传业务流程
- 文件状态转换
- 副本状态转换
- 删除流程
- 任务创建
- 审计
- 配额保护

### 7.3 Orchestrator

职责：

- 根据策略选择写入渠道
- 根据健康度选择读取副本
- 决定同步或异步副本
- 创建修复任务
- 执行容灾回退

### 7.4 Adapter

职责：

- 对接一个具体存储服务
- put/get/head/delete
- 将供应商错误转成统一错误
- 描述渠道能力

禁止：

- 修改文件总体状态
- 修改其他渠道副本
- 选择主备
- 决定重试次数
- 返回前端业务响应

### 7.5 Repository

职责：

- D1 SQL
- 映射数据库对象
- 使用 prepared statement
- 统一事务/batch

禁止：

- 调用外部存储
- 调用 Queue
- 处理 HTTP

---

## 8. 存储 Adapter 规范

### 8.1 接口

```ts
export class StorageAdapter {
  constructor(channel, env) {
    this.channel = channel;
    this.env = env;
  }

  provider() {
    throw new Error("Not implemented");
  }

  capabilities() {
    return {
      read: true,
      write: true,
      delete: true,
      head: true,
      range: false,
      checksum: false,
      maxObjectSize: null
    };
  }

  async put(input) {
    throw new Error("Not implemented");
  }

  async get(input) {
    throw new Error("Not implemented");
  }

  async head(input) {
    throw new Error("Not implemented");
  }

  async delete(input) {
    throw new Error("Not implemented");
  }

  async healthCheck() {
    throw new Error("Not implemented");
  }
}
```

### 8.2 输入结构

```ts
/**
 * @typedef {Object} PutInput
 * @property {string} fileId
 * @property {string} objectKey
 * @property {ReadableStream|ArrayBuffer|Blob} body
 * @property {number} size
 * @property {string} contentType
 * @property {string} idempotencyKey
 * @property {number} generation
 */
```

### 8.3 输出结构

```ts
/**
 * @typedef {Object} StoredObject
 * @property {string} objectKey
 * @property {string|null} remoteId
 * @property {string|null} etag
 * @property {string|null} checksum
 * @property {number} size
 * @property {Object} safeMetadata
 */
```

`safeMetadata` 只能包含无敏感信息的远端标识。

### 8.4 统一错误

```ts
export class StorageError extends Error {
  constructor({
    provider,
    channelId,
    code,
    retryable,
    message,
    status = null,
    retryAfterSeconds = null
  }) {
    super(message);
    this.name = "StorageError";
    this.provider = provider;
    this.channelId = channelId;
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
```

错误码：

```text
AUTH_FAILED
NOT_FOUND
RATE_LIMITED
TIMEOUT
NETWORK_ERROR
QUOTA_EXCEEDED
FILE_TOO_LARGE
CHECKSUM_MISMATCH
PERMISSION_DENIED
INVALID_CONFIGURATION
UNSUPPORTED
REMOTE_CONFLICT
UNKNOWN
```

### 8.5 Adapter 注册

```js
const factories = {
  telegram: createTelegramAdapter,
  webdav: createWebDavAdapter,
  s3: createS3Adapter,
  huggingface: createHuggingFaceAdapter,
  discord: createDiscordAdapter
};

export function getAdapter(channel, env) {
  if (
    env.ZERO_COST_MODE === "true" &&
    channel.provider === "r2"
  ) {
    throw new Error("R2 is disabled in ZERO_COST_MODE");
  }

  const factory = factories[channel.provider];
  if (!factory) {
    throw new Error(`Unsupported provider: ${channel.provider}`);
  }

  return factory(channel, env);
}
```

---

## 9. 存储策略模型

### 9.1 默认策略

```json
{
  "id": "policy_default",
  "name": "zero-cost-safe",
  "enabled": true,
  "writeMode": "safe",
  "primaryChannelId": "webdav-main",
  "syncReplicaChannelId": "telegram-backup",
  "asyncReplicaChannelIds": [],
  "requiredCopiesForAvailable": 2,
  "minimumReadableCopies": 1,
  "maximumCopies": 3,
  "readStrategy": "health_priority",
  "autoRepair": true,
  "stopWhenQuotaRisk": true
}
```

### 9.2 写入模式

#### safe

默认模式。

- Worker 将请求体 tee/clone 给两个同步渠道。
- 两个渠道都成功：`available`。
- 仅一个成功：`degraded`，返回成功但明确提示正在修复，或根据配置返回 202。
- 两个都失败：`failed`。

#### strict

- 两个同步副本均成功才返回成功。
- 适合重要文件。
- 容易因为单渠道故障影响上传可用性。

#### fast

- 主渠道成功即返回。
- 备份通过队列执行。
- 数据在备份完成前存在单点风险。
- 仅建议管理员导入或低价值文件使用。

### 9.3 零费用默认选择

推荐：

```text
writeMode = safe
requiredCopiesForAvailable = 2
maximumCopies = 2
```

第三副本会增加：

- 外部请求
- 队列任务
- D1 写入
- 健康检查
- 删除任务

零费用优先于副本数量时，两个独立故障域通常比三个同类渠道更合理。

---

## 10. 文件状态机

### 10.1 文件状态

```text
receiving
  ↓
replicating
  ├── available
  ├── degraded
  └── failed

available / degraded
  ↓
deleting
  ├── deleted
  └── delete_degraded
```

### 10.2 副本状态

```text
planned
uploading
healthy
suspect
missing
corrupt
retry_wait
deleting
deleted
permanent_failure
```

### 10.3 合法转换

```js
const FILE_TRANSITIONS = {
  receiving: ["replicating", "failed"],
  replicating: ["available", "degraded", "failed", "deleting"],
  available: ["degraded", "deleting"],
  degraded: ["available", "failed", "deleting"],
  failed: ["replicating", "deleting"],
  deleting: ["deleted", "delete_degraded"],
  delete_degraded: ["deleted"],
  deleted: []
};
```

所有非法状态转换必须抛出错误并记录审计。

---

## 11. 上传流程

### 11.1 请求格式

```http
POST /upload
Content-Type: multipart/form-data
Idempotency-Key: <uuid>
X-Upload-Policy: zero-cost-safe
```

上传必须要求：

- 已登录用户，或
- 匿名上传启用且 Turnstile 通过

### 11.2 文件限制

默认：

```text
单文件最大 10 MiB
管理员可调到 20 MiB
一次请求最多 5 个文件
一次请求总大小最多 30 MiB
允许 MIME 白名单
禁止可执行文件
禁止 HTML/SVG 默认公开
```

原因：

- Worker 内存 128 MB
- Free CPU 10 ms
- 多副本写入会复制/tee 流
- 大文件容易导致外部渠道超时
- 不使用 R2 中转时大文件恢复复杂

### 11.3 上传步骤

1. 检查零费用保护状态。
2. 检查 Worker、D1、Queue 软配额。
3. 检查用户权限。
4. 校验 Turnstile。
5. 读取 `Idempotency-Key`。
6. 校验文件数量、大小、MIME、扩展名。
7. 生成 `fileId`、`objectKey`、`generation=1`。
8. 在 D1 创建逻辑文件和两个 planned 副本。
9. 获取两个 Adapter。
10. 对请求体进行安全 tee。
11. 并发写入主存储和同步备份。
12. 每个成功结果立即写入副本状态。
13. 计算逻辑文件状态。
14. 写审计日志。
15. 返回统一地址。
16. 如有失败副本，创建 D1 修复任务并尽量发送 Queue 消息。

### 11.4 不在 Worker 中执行的操作

- 图片重新编码
- EXIF 全量解析
- 大文件哈希
- ZIP
- 病毒扫描
- 缩略图生成
- 全文件 Base64
- 大 JSON 序列化

### 11.5 响应

两个副本成功：

```json
{
  "success": true,
  "status": "available",
  "fileId": "file_...",
  "url": "https://example.com/file/file_...",
  "healthyCopies": 2,
  "desiredCopies": 2
}
```

一个副本成功：

```json
{
  "success": true,
  "status": "degraded",
  "fileId": "file_...",
  "url": "https://example.com/file/file_...",
  "healthyCopies": 1,
  "desiredCopies": 2,
  "repairScheduled": true
}
```

两个失败：

```json
{
  "success": false,
  "status": "failed",
  "code": "ALL_CHANNELS_FAILED"
}
```

### 11.6 幂等上传

`Idempotency-Key` 唯一约束：

- 同一用户、同一 key、请求参数一致：返回原结果。
- 同一 key、文件大小或文件名不一致：返回 409。
- 失败上传可用相同 key 继续恢复。
- 保留至少 24 小时。

---

## 12. 异步复制与修复

### 12.1 不依赖 Queue 保存任务

D1 `storage_jobs` 是主记录：

```text
pending
queued
running
retry_wait
succeeded
dead
cancelled
```

Queue 消息丢失或 24 小时过期时，Cron 会重新投递。

### 12.2 创建副本

1. 读取 job。
2. 检查 job 是否已完成。
3. 检查文件墓碑。
4. 检查目标副本是否已 healthy。
5. 选择健康源副本。
6. 从源 Adapter `get()`。
7. 流式写入目标 Adapter。
8. 使用 `head()` 检查大小。
9. 标记副本 healthy。
10. 重算文件健康状态。
11. 标记 job succeeded。

### 12.3 重试策略

```text
第 1 次：1 分钟
第 2 次：5 分钟
第 3 次：30 分钟
第 4 次：2 小时
第 5 次：12 小时
之后：dead
```

Queue 免费保留只有 24 小时，因此长延迟不依赖 Queue 延时消息：

- D1 保存 `next_run_at`
- Cron 每 15 分钟扫描到期任务
- 到期后重新发送 Queue

### 12.4 重试分类

| 错误 | 是否重试 | 行为 |
|---|---|---|
| TIMEOUT | 是 | 指数退避 |
| NETWORK_ERROR | 是 | 指数退避 |
| RATE_LIMITED | 是 | 使用 Retry-After |
| AUTH_FAILED | 否/低频 | 渠道 offline，管理员修复 |
| QUOTA_EXCEEDED | 低频 | 暂停渠道写入 |
| FILE_TOO_LARGE | 否 | permanent_failure |
| NOT_FOUND 源文件 | 否 | 尝试其他源 |
| NOT_FOUND 删除 | 视为成功 | 标记 deleted |
| CHECKSUM_MISMATCH | 最多 2 次 | 之后 dead |
| INVALID_CONFIGURATION | 否 | 渠道 offline |

### 12.5 队列操作保护

每天预计：

```text
2,000 条任务 × 约 3 operations = 6,000 operations
```

剩余约 4,000 operations 用于：

- 重试
- DLQ
- 临时峰值
- 管理员手动任务

达到 7,000 operations 估算值后：

- 停止创建非必要校验任务。
- 只允许删除和无副本文件修复。
- 第三副本创建暂停。
- 管理页面显示保护状态。

---

## 13. 读取容灾

### 13.1 对外地址

所有文件使用统一地址：

```text
https://your-domain.example/file/{fileId}
```

不得把后端原始 URL 作为永久链接返回给用户。

### 13.2 读取计划

查询 D1：

```sql
SELECT
  r.*,
  c.health_status,
  c.priority
FROM file_replicas r
JOIN storage_channels c ON c.id = r.channel_id
WHERE r.file_id = ?1
  AND r.status IN ('healthy', 'suspect')
  AND c.enabled = 1
ORDER BY
  CASE c.health_status
    WHEN 'healthy' THEN 0
    WHEN 'degraded' THEN 1
    ELSE 2
  END,
  c.priority ASC,
  r.last_success_at DESC;
```

### 13.3 回退过程

1. 检查文件是否存在。
2. 检查 tombstone。
3. 获取候选副本。
4. 尝试第一副本。
5. 失败后更新轻量失败计数。
6. 尝试第二副本。
7. 成功后流式返回。
8. 异步创建 `VERIFY_REPLICA` 或 `REPAIR_REPLICA`。
9. 全部失败返回 503。
10. 已删除返回 404 或 410。

### 13.4 避免读取放大

每次读取最多尝试 2 个渠道。

禁止：

- 一次请求遍历所有渠道
- 每次读取都执行完整健康检查
- 每次读取都更新多行日志
- 每次读取都执行完整校验

读取成功后的访问统计应采样或聚合，不能每个请求写 D1。

推荐：

```text
1% 请求写访问采样
或
内存内聚合后按批写入
```

但 Worker isolate 不保证长期存在，因此访问统计不是核心一致性数据。

### 13.5 缓存

可使用 Cloudflare Cache API 缓存公开文件响应，但注意：

- Cache API 不作为持久存储。
- Cache miss 时仍走副本读取。
- 删除时执行 cache purge 或使用版本化 URL。
- 私有文件禁止共享缓存。
- 缓存不写入 R2。

建议：

```http
Cache-Control: public, max-age=3600, stale-while-revalidate=86400
```

私有文件：

```http
Cache-Control: private, no-store
```

---

## 14. 删除与墓碑

### 14.1 删除原则

用户删除文件时，必须先逻辑删除，再异步物理删除。

### 14.2 删除步骤

D1 batch：

1. `files.status = deleting`
2. `files.deleted_at = now`
3. 插入 `file_tombstones`
4. 为所有未删除副本创建删除 job
5. 写审计日志

从 batch 成功开始：

- `/file/{id}` 不再返回文件。
- 修复任务不得重新创建文件。
- 延迟上传任务必须取消。
- 管理后台显示删除进度。

### 14.3 删除任务

每个副本独立执行：

- 远端删除成功：`deleted`
- 远端已不存在：`deleted`
- 网络失败：重试
- 鉴权失败：dead + 告警
- 所有副本删除完成：逻辑文件 `deleted`

### 14.4 墓碑保留

建议：

```text
tombstone：90 天
审计日志：180 天
删除 job：成功后保留 30 天
dead job：管理员处理后保留 90 天
```

墓碑记录很小，保留它可以防止迟到任务“复活”文件。

---

## 15. 渠道健康检查与熔断

### 15.1 渠道状态

```text
unknown
healthy
degraded
offline
disabled
quota_blocked
```

### 15.2 健康检查频率

零费用模式不做高频探测。

建议：

- 每 30 分钟运行一次综合维护 Cron。
- 每个渠道最多一次轻量探测。
- 仅管理员打开状态页时可手动探测。
- 手动探测有 60 秒冷却。

### 15.3 熔断规则

```text
连续 3 次网络失败 → degraded
连续 5 次失败 → offline 15 分钟
AUTH_FAILED → 立即 offline
RATE_LIMITED → 根据 Retry-After 暂停
QUOTA_EXCEEDED → quota_blocked
连续 2 次成功 → healthy
```

### 15.4 健康探测应尽量轻量

优先：

- HEAD 指定测试对象
- API getMe
- PROPFIND 指定目录
- 小对象元数据请求

禁止：

- 列出整个桶
- 列出全部 Telegram 消息
- 扫描完整 WebDAV
- 全量下载测试文件

---

## 16. D1 数据模型

### 16.1 storage_channels

```sql
CREATE TABLE IF NOT EXISTS storage_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  failure_domain TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_refs_json TEXT NOT NULL DEFAULT '{}',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  health_status TEXT NOT NULL DEFAULT 'unknown',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  circuit_open_until TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 16.2 storage_policies

```sql
CREATE TABLE IF NOT EXISTS storage_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  write_mode TEXT NOT NULL DEFAULT 'safe',
  primary_channel_id TEXT NOT NULL,
  sync_replica_channel_id TEXT,
  async_replica_channel_ids_json TEXT NOT NULL DEFAULT '[]',
  required_copies_for_available INTEGER NOT NULL DEFAULT 2,
  minimum_readable_copies INTEGER NOT NULL DEFAULT 1,
  maximum_copies INTEGER NOT NULL DEFAULT 2,
  read_strategy TEXT NOT NULL DEFAULT 'health_priority',
  auto_repair INTEGER NOT NULL DEFAULT 1,
  stop_when_quota_risk INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 16.3 files

如上游已有文件表，可迁移或扩展；推荐最终结构：

```sql
CREATE TABLE IF NOT EXISTS files_v3 (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  original_name TEXT NOT NULL,
  extension TEXT,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  client_sha256 TEXT,
  integrity_level TEXT NOT NULL DEFAULT 'size_only',
  directory TEXT NOT NULL DEFAULT '',
  owner_id TEXT,
  policy_id TEXT NOT NULL,
  desired_replica_count INTEGER NOT NULL DEFAULT 2,
  healthy_replica_count INTEGER NOT NULL DEFAULT 0,
  primary_replica_id TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
```

### 16.4 file_replicas

```sql
CREATE TABLE IF NOT EXISTS file_replicas (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  object_key TEXT NOT NULL,
  remote_id TEXT,
  status TEXT NOT NULL,
  size_bytes INTEGER,
  checksum TEXT,
  checksum_type TEXT,
  etag TEXT,
  safe_metadata_json TEXT NOT NULL DEFAULT '{}',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  last_success_at TEXT,
  last_checked_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(file_id, channel_id, generation)
);
```

### 16.5 storage_jobs

```sql
CREATE TABLE IF NOT EXISTS storage_jobs (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  file_id TEXT NOT NULL,
  replica_id TEXT,
  source_replica_id TEXT,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  next_run_at TEXT,
  queued_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 16.6 file_tombstones

```sql
CREATE TABLE IF NOT EXISTS file_tombstones (
  file_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  deleted_at TEXT NOT NULL,
  purge_after TEXT NOT NULL,
  reason TEXT,
  actor_id TEXT
);
```

### 16.7 usage_counters

```sql
CREATE TABLE IF NOT EXISTS usage_counters (
  date_key TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(date_key, metric)
);
```

指标：

```text
worker_requests_estimated
uploads_started
uploads_completed
uploads_degraded
queue_jobs_created
queue_jobs_retried
d1_rows_read_estimated
d1_rows_written_estimated
anonymous_uploads
admin_operations
```

### 16.8 audit_logs

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
```

### 16.9 索引

```sql
CREATE INDEX IF NOT EXISTS idx_files_v3_status
  ON files_v3(status);

CREATE INDEX IF NOT EXISTS idx_files_v3_owner_created
  ON files_v3(owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_replicas_file_status
  ON file_replicas(file_id, status);

CREATE INDEX IF NOT EXISTS idx_replicas_channel_status
  ON file_replicas(channel_id, status);

CREATE INDEX IF NOT EXISTS idx_jobs_status_next
  ON storage_jobs(status, next_run_at);

CREATE INDEX IF NOT EXISTS idx_jobs_file
  ON storage_jobs(file_id);

CREATE INDEX IF NOT EXISTS idx_audit_target
  ON audit_logs(target_type, target_id, created_at DESC);
```

### 16.10 D1 查询规范

必须：

- 所有列表分页。
- 所有常用过滤字段有索引。
- 禁止管理页面 `SELECT *` 全表。
- 禁止无条件 COUNT 大表高频执行。
- 统计使用预聚合表。
- 每次 API 请求预估不超过 20 条 SQL。
- 读取文件时目标不超过 3 条 SQL。
- D1 返回 meta 时采集 rows_read/rows_written。

---

## 17. 零费用保护器

### 17.1 核心接口

```js
export async function assertWriteAllowed(env, context) {
  if (env.ZERO_COST_MODE !== "true") return;

  const quota = await getCurrentQuotaSnapshot(env.DB);

  if (quota.emergencyReadOnly) {
    throw new ZeroCostGuardError("SYSTEM_READ_ONLY");
  }

  if (quota.workerRequests >= 80000) {
    throw new ZeroCostGuardError("WORKER_SOFT_LIMIT");
  }

  if (quota.d1RowsWritten >= 60000) {
    throw new ZeroCostGuardError("D1_WRITE_SOFT_LIMIT");
  }

  if (quota.queueOpsEstimated >= 7000) {
    context.disableAsyncJobs = true;
  }
}
```

### 17.2 保护级别

```text
NORMAL
WARNING
WRITE_LIMITED
READ_ONLY
EMERGENCY
```

#### NORMAL

所有功能正常。

#### WARNING

- 管理后台提示。
- 暂停非必要校验。
- 降低健康检查频率。

#### WRITE_LIMITED

- 禁止匿名上传。
- 已登录用户限额。
- 暂停第三副本。
- 暂停批量迁移。

#### READ_ONLY

- 禁止上传。
- 禁止创建用户。
- 禁止普通修复。
- 保留读取、登录、删除和关键修复。

#### EMERGENCY

- 只保留公开读取。
- 管理员可以登录。
- 所有后台任务暂停。

### 17.3 CI 禁止资源扫描

新增脚本：

```js
const forbidden = [
  "r2_buckets",
  "vectorize",
  "browser",
  "ai",
  "durable_objects",
  "containers"
];
```

CI 检查：

- Wrangler 中出现禁用 binding，失败。
- `ZERO_COST_MODE` 默认不是 true，失败。
- Adapter registry 默认启用 R2，失败。
- package 中新增付费 SDK，要求人工审批。
- 代码调用 `env.R2`，失败。

---

## 18. 管理 API

### 18.1 渠道

```text
GET    /api/storage/channels
POST   /api/storage/channels
GET    /api/storage/channels/:id
PUT    /api/storage/channels/:id
DELETE /api/storage/channels/:id
POST   /api/storage/channels/:id/test
POST   /api/storage/channels/:id/enable
POST   /api/storage/channels/:id/disable
```

### 18.2 策略

```text
GET    /api/storage/policies
POST   /api/storage/policies
PUT    /api/storage/policies/:id
POST   /api/storage/policies/:id/validate
POST   /api/storage/policies/:id/activate
```

### 18.3 文件副本

```text
GET  /api/files/:id/replicas
POST /api/files/:id/verify
POST /api/files/:id/repair
POST /api/files/:id/rebuild
POST /api/files/:id/promote
```

### 18.4 任务

```text
GET  /api/ops/jobs
GET  /api/ops/jobs/:id
POST /api/ops/jobs/:id/retry
POST /api/ops/jobs/:id/cancel
GET  /api/ops/dead-jobs
POST /api/ops/dispatch
```

### 18.5 零费用状态

```text
GET /api/ops/zero-cost-status
```

示例：

```json
{
  "mode": "ZERO_COST",
  "level": "NORMAL",
  "cloudflare": {
    "workerRequestsEstimated": 12340,
    "workerSoftLimit": 80000,
    "d1RowsReadEstimated": 420000,
    "d1ReadSoftLimit": 3000000,
    "d1RowsWrittenEstimated": 9300,
    "d1WriteSoftLimit": 60000,
    "queueOpsEstimated": 1250,
    "queueSoftLimit": 7000
  },
  "disabledFeatures": [
    "r2",
    "image_processing",
    "third_replica_when_warning"
  ]
}
```

---

## 19. 管理后台页面

### 19.1 零费用状态面板

必须放在管理首页顶部：

- 当前模式：Zero Cost
- 当前保护级别
- Worker 请求估算
- D1 行读写估算
- Queue operation 估算
- 数据库大小
- 今日上传数
- 是否禁止上传
- 是否暂停修复
- R2：强制禁用
- Workers Paid：未启用

### 19.2 渠道管理

显示：

- 名称
- Provider
- 故障域
- 优先级
- 读写能力
- 最大文件大小
- 健康状态
- 最近成功
- 最近失败
- 错误码
- 暂停写入
- 测试连接

创建渠道时：

- R2 选项在 Zero Cost 模式不可见。
- S3 显示“外部服务可能收费”。
- 同故障域渠道显示警告。
- 密钥只通过 Secret 配置，不回显。

### 19.3 容灾策略

校验：

- 主渠道与同步备份不能相同。
- 两个渠道应有不同 `failure_domain`。
- 两个渠道都必须支持 write/read/delete。
- 文件大小上限取两个渠道最小值。
- Zero Cost 模式最多两个同步渠道。
- `maximumCopies` 默认不超过 2。
- 不能选择 R2。

### 19.4 文件详情

显示：

- 文件状态
- 逻辑 ID
- 统一 URL
- 大小、MIME
- 所有者
- 策略
- 健康副本数
- 目标副本数
- 每个副本状态
- 最近校验
- 最近错误
- 手动修复
- 手动切主
- 删除

### 19.5 任务中心

筛选：

- operation
- status
- channel
- file
- created_at
- attempts

操作：

- 单个重试
- 批量重试
- 取消
- 标记人工处理
- 导出小批量 JSON

禁止：

- 一次展示所有任务
- 一次批量重试超过 100
- 自动刷新小于 15 秒

---

## 20. 安全设计

### 20.1 Secret

渠道密码和 Token 只能保存在：

- Wrangler Secret
- Cloudflare Dashboard Secret

D1 只保存 Secret 引用：

```json
{
  "tokenRef": "TELEGRAM_BACKUP_TOKEN",
  "passwordRef": "WEBDAV_MAIN_PASSWORD"
}
```

### 20.2 鉴权

- 管理员使用安全 Session。
- API Token 只显示一次。
- Token 哈希后存储。
- 上传 API 支持 scope。
- 删除和修复需要高权限。
- 管理 API 不允许匿名。

### 20.3 匿名上传

默认关闭。

启用时必须：

- Turnstile
- IP 限频
- 文件类型白名单
- 单文件 5 MiB
- 每 IP 每小时 10 个
- 每日总匿名上传 100 个
- 禁止 SVG/HTML
- 禁止自定义路径
- 禁止选择渠道
- 自动过期可选

### 20.4 SSRF

WebDAV/S3 Endpoint 必须防 SSRF：

- 禁止 localhost
- 禁止 127.0.0.0/8
- 禁止 10.0.0.0/8
- 禁止 172.16.0.0/12
- 禁止 192.168.0.0/16，除非管理员明确开启自有 NAS 模式
- 禁止 link-local
- 禁止 metadata service 地址
- 限制协议为 HTTPS，局域网模式可允许 HTTP
- 重定向次数最多 2
- 重定向后重新校验 host

自有 NAS 位于私网时，Cloudflare Worker 通常无法直接访问内网地址，需使用安全反向代理或 Tunnel。Tunnel 本身的使用条件应在部署时重新核对。

### 20.5 文件响应安全

```http
X-Content-Type-Options: nosniff
Content-Disposition: inline; filename*=UTF-8''...
Referrer-Policy: no-referrer
```

危险类型强制：

```http
Content-Disposition: attachment
```

### 20.6 日志脱敏

不得记录：

- Authorization
- Cookie
- Bot Token
- WebDAV 密码
- S3 Secret
- 完整签名 URL
- 文件二进制
- 私有文件内容

---

## 21. 可观测性

### 21.1 结构化日志

```json
{
  "level": "error",
  "event": "replica.create.failed",
  "requestId": "req_...",
  "jobId": "job_...",
  "fileId": "file_...",
  "replicaId": "rep_...",
  "channelId": "telegram-backup",
  "provider": "telegram",
  "errorCode": "RATE_LIMITED",
  "retryable": true,
  "attempt": 2,
  "timestamp": "2026-07-20T12:00:00.000Z"
}
```

### 21.2 核心指标

- available 文件数
- degraded 文件数
- failed 文件数
- 无健康副本文件数
- dead job 数
- 待处理 job 数
- 最老 pending job
- 每渠道成功率
- 每渠道最近错误
- 每日上传数
- 每日 Worker 请求估算
- D1 读写估算
- Queue operations 估算
- Zero Cost 保护级别

### 21.3 审计事件

```text
channel.created
channel.updated
channel.disabled
policy.updated
file.uploaded
file.degraded
file.repaired
file.deleted
job.retried
job.cancelled
zero_cost.warning
zero_cost.read_only
admin.login
secret.reference.changed
```

---

## 22. Cron 设计

Free 账户最多 5 个 Cron，本项目只用 2 个。

### 22.1 每 15 分钟

```text
*/15 * * * *
```

任务：

- 扫描到期 pending/retry_wait job
- 每次最多 50 个
- 检查 Queue 软额度
- 投递可执行任务
- 更新零费用保护状态

### 22.2 每 6 小时

```text
15 */6 * * *
```

任务：

- 渠道轻量健康检查
- 重算少量 degraded 文件
- 清理过期幂等键
- 清理过期成功 job
- 清理过期审计日志
- 检查数据库软大小
- 不执行全量扫描

### 22.3 分批游标

所有维护任务必须使用游标：

```text
maintenance_cursor
last_file_id
last_channel_id
last_job_id
```

单次 Cron：

- 处理固定数量
- 接近 CPU 限制立即退出
- 下次继续
- 不做大事务

---

## 23. Wrangler 配置

推荐 Worker 部署，而不是把新增任务能力全部塞进 Pages Functions。

示例 `wrangler.toml`：

```toml
name = "cloudflare-imgbed-zero-cost"
main = "deploy/worker/index.js"
compatibility_date = "2026-07-01"

[vars]
ZERO_COST_MODE = "true"
ALLOW_R2 = "false"
MAX_UPLOAD_BYTES = "10485760"
HARD_MAX_UPLOAD_BYTES = "20971520"
MAX_SYNC_CHANNELS = "2"
DAILY_UPLOAD_SOFT_LIMIT = "500"
WORKER_REQUEST_SOFT_LIMIT = "80000"
D1_READ_SOFT_LIMIT = "3000000"
D1_WRITE_SOFT_LIMIT = "60000"
QUEUE_OPS_SOFT_LIMIT = "7000"

[[d1_databases]]
binding = "DB"
database_name = "cloudflare-imgbed-zero-cost"
database_id = "REPLACE_ME"
migrations_dir = "database/migrations"

[[queues.producers]]
binding = "STORAGE_QUEUE"
queue = "imgbed-storage-zero-cost"

[[queues.consumers]]
queue = "imgbed-storage-zero-cost"
max_batch_size = 5
max_batch_timeout = 5
max_retries = 3
dead_letter_queue = "imgbed-storage-zero-cost-dlq"

[[queues.consumers]]
queue = "imgbed-storage-zero-cost-dlq"
max_batch_size = 5
max_batch_timeout = 10

[triggers]
crons = [
  "*/15 * * * *",
  "15 */6 * * *"
]

[assets]
directory = "./frontend-dist"
binding = "ASSETS"
```

明确不能出现：

```toml
[[r2_buckets]]
```

### 23.1 Secret 示例

```bash
npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN
npx wrangler secret put SESSION_SECRET
npx wrangler secret put TURNSTILE_SECRET

npx wrangler secret put WEBDAV_MAIN_USERNAME
npx wrangler secret put WEBDAV_MAIN_PASSWORD

npx wrangler secret put TELEGRAM_BACKUP_TOKEN
```

---

## 24. 测试策略

### 24.1 单元测试

覆盖：

- 文件状态转换
- 副本状态转换
- 策略校验
- 故障域校验
- Adapter registry
- R2 禁用
- 零费用保护等级
- 幂等键
- 重试分类
- 墓碑检查
- 读取候选排序
- Queue 软配额
- D1 查询分页

### 24.2 Adapter 合约测试

同一套测试运行于每个 Adapter：

```text
put
head
get
delete
head -> not found
```

异常测试：

- 重复 put
- 重复 delete
- 超时
- 401/403
- 404
- 429
- 5xx
- 大文件
- Unicode 文件名
- 特殊字符路径
- 网络中断

### 24.3 集成测试

必须覆盖：

1. 两个同步渠道都成功。
2. 主成功、备份失败。
3. 主失败、备份成功。
4. 两个渠道都失败。
5. 主读取失败，备份读取成功。
6. 读取回退后创建修复任务。
7. Queue 消息重复。
8. Queue 消息过期，Cron 从 D1 重新投递。
9. 远端写入成功、D1 更新前中断。
10. D1 写入成功、Queue 投递前中断。
11. 删除后旧复制任务到达。
12. 文件 generation 已更新，旧 job 到达。
13. D1 接近软上限，上传被阻止。
14. Queue 接近软上限，非必要任务暂停。
15. R2 配置出现，部署测试失败。
16. 匿名上传无 Turnstile 被拒绝。
17. 同 Idempotency-Key 重复上传。
18. 文件删除时一个渠道离线。
19. 渠道恢复后删除完成。
20. 所有副本丢失，返回 503。

### 24.4 故障演练

发布前手动执行：

- 修改主 WebDAV 密码使其失效。
- 暂停 Telegram Bot。
- 模拟 429。
- 删除主副本。
- 删除备份副本。
- 停止 Queue consumer。
- 等待消息超过 24 小时的模拟流程。
- 将 D1 写保护级别切到 READ_ONLY。
- 删除文件后重新投递旧任务。
- 回滚 Worker 版本。
- 导出并恢复 D1。

### 24.5 性能测试

目标不是最大吞吐，而是确保不超过免费限制。

测试：

- 1 MiB 文件双写
- 5 MiB 文件双写
- 10 MiB 文件双写
- 20 MiB 硬上限行为
- 50 并发读取
- 5 并发上传
- 主存储超时下读取回退
- 10 个 Queue job 批量消费

任何持续超过 10 ms CPU 的路径必须优化或移除。

---

## 25. 开发阶段

### Phase 0：重新 Fork 和稳定基线

交付：

- 新 fork
- upstream remote
- V3 分支
- 上游 v2.7.5 可部署
- 原功能冒烟测试
- 零费用 CI 扫描框架

验收：

- 原始上传、读取、删除可用。
- 不修改上游 main。
- 新分支可部署。
- CI 能检测 R2 binding。

### Phase 1：D1 V3 数据模型

交付：

- channels
- policies
- files_v3
- replicas
- jobs
- tombstones
- usage_counters
- repositories
- migrations

验收：

- migration 可重复执行。
- rollback 文档完成。
- 查询均分页并有索引。
- D1 batch 用于关键状态变化。

### Phase 2：Adapter 标准化

优先顺序：

1. WebDAV
2. Telegram
3. S3 Compatible
4. Hugging Face
5. Discord

交付：

- 接口
- registry
- error model
- capability model
- contract tests

验收：

- 业务代码中无 provider 分支链。
- 每个 Adapter 通过合约测试。
- R2 在 Zero Cost 模式不可用。

### Phase 3：双写上传

交付：

- safe/strict/fast
- 同步双写
- 幂等上传
- 文件/副本状态
- 降级响应
- 审计

验收：

- 两个渠道成功时 available。
- 一个成功时 degraded。
- 重试不会重复产生逻辑文件。
- 单文件硬上限生效。

### Phase 4：Queue 和 Outbox

交付：

- storage_jobs
- Queue producer
- consumer
- Cron dispatch
- retry
- dead jobs

验收：

- Queue 丢消息时可恢复。
- 消息重复不重复写副本。
- 24 小时后仍可从 D1 恢复。
- 队列软额度保护生效。

### Phase 5：读取容灾

交付：

- 统一文件地址
- ReadPlanner
- 主备回退
- 失败标记
- 修复任务

验收：

- 主渠道离线时 URL 不变化。
- 最多尝试两个渠道。
- 回退成功后生成修复任务。
- 私有文件缓存正确。

### Phase 6：删除容灾

交付：

- tombstone
- 异步副本删除
- 删除重试
- delete_degraded
- 防文件复活

验收：

- 删除后立即不可读。
- 延迟复制任务不能复活文件。
- 渠道恢复后完成删除。

### Phase 7：零费用保护

交付：

- ZeroCostGuard
- usage counters
- 保护等级
- 管理面板
- CI 禁止资源
- Read-only 降级

验收：

- 接近软上限自动停止写入。
- 不会自动升级付费。
- Wrangler 无 R2。
- 所有付费能力默认关闭。

### Phase 8：管理后台

交付：

- 渠道
- 策略
- 文件副本
- 任务中心
- 使用量
- 审计
- 手动修复

验收：

- 常见故障不需直接查数据库。
- 所有人工操作有审计。
- 页面查询均分页。

### Phase 9：旧功能兼容与发布

交付：

- 上游 API 兼容
- 旧元数据迁移
- 部署文档
- 回滚文档
- 灾难恢复演练

验收：

- 旧链接仍可读取。
- 上游主要功能不回归。
- 可一键关闭 V3 路由。
- 完成 D1 导出恢复。

---

## 26. GitHub Issues 列表

建议按顺序创建：

1. `chore: recreate clean fork and upstream sync workflow`
2. `chore: add zero-cost forbidden-resource CI check`
3. `feat(db): add storage channel schema`
4. `feat(db): add storage policy schema`
5. `feat(db): add file replica schema`
6. `feat(db): add persistent storage job outbox`
7. `feat(db): add tombstone and usage counter schema`
8. `refactor(storage): define common adapter contract`
9. `feat(storage): implement WebDAV adapter`
10. `feat(storage): implement Telegram adapter`
11. `feat(storage): implement S3-compatible adapter`
12. `feat(storage): implement Hugging Face adapter`
13. `test(storage): add adapter contract suite`
14. `feat(upload): add idempotent dual-write upload`
15. `feat(upload): add safe strict and fast policies`
16. `feat(replication): add queue consumer`
17. `feat(replication): add D1 outbox dispatcher`
18. `feat(replication): add retry and dead-job flow`
19. `feat(read): add health-priority read planner`
20. `feat(read): add transparent replica failover`
21. `feat(repair): add replica verification and repair`
22. `feat(delete): add tombstone-first deletion`
23. `feat(cost): add free-tier usage counters`
24. `feat(cost): add write-limited and read-only modes`
25. `feat(cost): hard-disable R2 in zero-cost mode`
26. `feat(admin): add channel management page`
27. `feat(admin): add replication policy page`
28. `feat(admin): add file replica detail page`
29. `feat(admin): add jobs and dead-jobs page`
30. `feat(admin): add zero-cost dashboard`
31. `security: add SSRF protections for storage endpoints`
32. `security: add Turnstile and anonymous upload limits`
33. `test(dr): add failover disaster test suite`
34. `docs: add deployment and secret configuration`
35. `docs: add rollback and D1 recovery runbook`

---

## 27. 发布验收标准

### 27.1 零费用

- Cloudflare 账户保持 Free。
- 未订阅 Workers Paid。
- Wrangler 中无 R2 binding。
- 管理 UI 无 R2 创建入口。
- `ZERO_COST_MODE=true`。
- CI 检测付费资源。
- 达到软上限时系统降级。
- 不存在自动升级代码。
- 不依赖预算告警阻止收费。
- 部署清单包含套餐复核。

### 27.2 容灾

- 至少支持 WebDAV + Telegram 双副本。
- 主渠道故障时备份可读。
- 读取 URL 不变化。
- 失败副本可自动修复。
- 修复任务可跨 Queue 24 小时限制恢复。
- 删除先写墓碑。
- 删除失败可重试。
- 旧任务不会复活文件。

### 27.3 安全

- Secret 不入 D1。
- 日志脱敏。
- 管理 API 鉴权。
- 匿名上传默认关闭。
- 开启匿名上传必须 Turnstile。
- 文件大小限制有效。
- SSRF 防护有效。
- 危险 MIME 强制下载。
- 所有人工运维操作有审计。

### 27.4 性能与配额

- 关键请求 CPU 不持续超过 Free 限制。
- 文件读取最多尝试两个后端。
- 每次上传最多两个同步渠道。
- D1 列表均分页。
- Queue 消息小于 2 KB。
- 单次 Cron 分批处理。
- 无全表高频扫描。

### 27.5 运维

- 管理员可查看每个文件副本。
- 管理员可重试 dead job。
- 管理员可暂停渠道。
- 管理员可切换主副本。
- 管理员可查看零费用保护状态。
- 有 D1 导出和恢复文档。
- 有 Worker 回滚文档。

---

## 28. 运维手册

### 28.1 每日

自动完成：

- 检查使用量
- 调度到期 job
- 限制非必要任务
- 记录 degraded 文件

管理员无需每日操作。

### 28.2 每周

管理员检查：

- degraded 文件
- dead jobs
- 渠道 offline
- D1 大小
- Cloudflare Free Plan 状态
- 外部存储容量
- 最近错误

### 28.3 每月

1. 检查 Cloudflare Billing/Subscriptions。
2. 确认没有 Workers Paid。
3. 确认没有 R2。
4. 检查官方免费额度是否变化。
5. 导出 D1。
6. 随机恢复一个文件。
7. 随机从备份读取一个文件。
8. 检查 Telegram/WebDAV 等外部渠道规则。
9. 更新本文档中的限额日期。

### 28.4 主渠道故障

系统行为：

- 熔断主渠道。
- 从备份读取。
- 新上传根据策略决定降级或拒绝。
- 不自动切换到收费存储。

管理员：

1. 查看错误码。
2. 测试连接。
3. 修复凭据/网络。
4. 恢复渠道。
5. 批量重试修复任务。

### 28.5 D1 达到软上限

系统：

- 进入 WRITE_LIMITED 或 READ_ONLY。
- 禁止上传。
- 保留读取。
- 暂停非必要任务。

管理员：

- 清理成功 job 历史。
- 清理过期审计。
- 检查无索引查询。
- 导出后清理旧数据。
- 不通过升级付费解决。

### 28.6 Queue 接近软上限

系统：

- 暂停第三副本。
- 暂停周期校验。
- 仅执行删除和无副本修复。
- D1 保留 pending job。

次日免费额度重置后由 Cron 继续投递。

### 28.7 Worker 请求接近软上限

系统：

- 关闭匿名上传。
- 关闭公开列表刷新。
- 提高缓存时间。
- 禁止高频状态轮询。
- 保留文件读取。

达到 Cloudflare 硬限制后请求可能失败，系统不能通过付费扩容。

---

## 29. 回滚方案

### 29.1 Feature Flag

```text
ENABLE_REPLICATION_V3=true
ZERO_COST_MODE=true
ENABLE_V3_READ=true
ENABLE_V3_UPLOAD=true
```

回滚：

```text
ENABLE_V3_UPLOAD=false
ENABLE_V3_READ=false
```

保留：

- V3 数据表
- 副本
- 墓碑
- 审计

不做破坏性数据库降级。

### 29.2 Worker 回滚

- 每次发布打 Git Tag。
- 保留最近 3 个可用版本。
- 发现严重错误立即部署上一个 Tag。
- 数据 migration 必须向前兼容至少一个版本。

### 29.3 数据恢复

每月导出 D1：

```bash
npx wrangler d1 export cloudflare-imgbed-zero-cost \
  --remote \
  --output backups/d1-YYYY-MM-DD.sql
```

备份文件应保存到用户自有安全位置，不依赖同一个 Cloudflare 账户。

---

## 30. 最终实施建议

首个版本严格控制在以下范围：

```text
Cloudflare Worker Free
D1 Free
Queues Free
Turnstile Free
静态前端资源
WebDAV 主存储
Telegram 同步备份
统一文件 URL
双副本上传
读取回退
墓碑删除
D1 持久任务
Queue 异步修复
Zero Cost Guard
管理运维页面
```

首版不要实现：

```text
R2
大文件分片
图片处理
第三个默认副本
公开匿名图床
高频健康检查
复杂访问统计
全量校验
```

最核心的产品定义：

> Cloudflare 只负责免费边缘计算、元数据和任务调度；文件内容由用户配置的独立存储渠道保存。系统维护逻辑文件和多个物理副本，并在主渠道故障时自动切换到备份。达到免费资源阈值时系统主动降级，绝不以自动付费维持服务。

---

## 31. 官方参考资料

核对日期：2026-07-20

1. Cloudflare Workers Limits  
   https://developers.cloudflare.com/workers/platform/limits/

2. Cloudflare Workers Pricing  
   https://developers.cloudflare.com/workers/platform/pricing/

3. Cloudflare D1 Pricing  
   https://developers.cloudflare.com/d1/platform/pricing/

4. Cloudflare D1 Limits  
   https://developers.cloudflare.com/d1/platform/limits/

5. Cloudflare Queues Pricing  
   https://developers.cloudflare.com/queues/platform/pricing/

6. Cloudflare Queues Limits  
   https://developers.cloudflare.com/queues/platform/limits/

7. Cloudflare R2 Pricing  
   https://developers.cloudflare.com/r2/pricing/

8. Cloudflare Budget Alerts  
   https://developers.cloudflare.com/billing/manage/budget-alerts/

9. Cloudflare Turnstile Plans  
   https://developers.cloudflare.com/turnstile/plans/

10. CloudFlare-ImgBed 上游仓库  
    https://github.com/MarSeventh/CloudFlare-ImgBed

---

## 32. 发布前零费用检查清单

```text
[ ] Cloudflare 账户为 Free Plan
[ ] Workers Paid 未订阅
[ ] R2 未启用
[ ] Wrangler 无 r2_buckets
[ ] ZERO_COST_MODE=true
[ ] ALLOW_R2=false
[ ] Queue 使用 Free 配额
[ ] D1 使用 Free 配额
[ ] Cron 不超过 2 个
[ ] 文件默认上限 10 MiB
[ ] 同步渠道不超过 2
[ ] 匿名上传默认关闭
[ ] Turnstile 已启用
[ ] Worker 软上限 80,000/天
[ ] D1 读取软上限 3,000,000 行/天
[ ] D1 写入软上限 60,000 行/天
[ ] Queue 软上限 7,000 operations/天
[ ] 达限后进入只读模式
[ ] 无自动套餐升级逻辑
[ ] 无付费 SDK 或 Binding
[ ] 外部存储费用风险已提示
[ ] 已检查 Cloudflare 最新官方文档
[ ] 已完成 D1 导出
[ ] 已完成主渠道故障演练
[ ] 已完成备份读取演练
[ ] 已完成删除防复活测试
```
