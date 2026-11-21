# magpie-agent-trae-intl — 架构设计

> 状态：0.1.0 骨架对应的设计基线。实现者只允许在**不改变本文与 `interfaces.md` 契约**的前提下填充模块体。
>
> 目标环境：Windows 10/11 x64、Trae 国际版 **3.6.20**、Magpie **0.1.4596**、Node ≥ 20（Bun 宿主）。
>
> 依据：开发期间对本机已安装客户端与宿主的只读核对——CN 参考插件 v0.3.4 的逐文件拆解、国际版 3.6.20 客户端/模型管理协议、Magpie Agent 插件的宿主契约。调研过程文档属内部材料，不随本仓库发布；本文保留核对结论，不保留指向它们的引用。
>
> 本文不新增任何运行时验证；本文的"已核实"只指开发期间核对过的证据。实际执行过的检查见 §13。

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 | 验收表现 |
| --- | --- | --- |
| G1 | 让 Trae 国际版的模型菜单出现 Magpie 模型 | 同步成功后 Trae 的自定义模型列表出现 `"<name> · Magpie"` 条目，`base_url` 指向本机桥 |
| G2 | 聊天流量不携带 Magpie 密钥进入 Trae 云端 | Trae 只持有回环标记的原生封套；`gatewayKey` 只存在于 `connection.json`，只被桥发往本机 Magpie |
| G3 | 目录同步可恢复 | 云端响应丢失后，下一次 tick 能凭 `managed-models.json` 的 pending 精确收敛，不重复建、不误删 |
| G4 | 断开/移除时只撤回自己写的东西 | 自建且未手改 → 删除；接管且未手改 → 还原原配置；用户手改 → 保留并告警 |
| G5 | 失败可诊断且不泄密 | 所有错误码可白名单化；`/health`、`sync-status.json`、日志不含 token/uid/device id/gatewayKey/ak |
| G6 | 构建不明时失败关闭 | 版本/哈希不在允许表 → 不打补丁、不派生密钥、不猜测算法 |

### 1.2 非目标

- 不修改 Trae 的 SQLite（`state.vscdb`、`ModularData/ai-agent/database.db`）；账户服务是唯一事实源（CN 参考插件同策略）。
- 不做登录、token 刷新、账号切换；只读 `storage.json`。
- 不移植 CN 的取消竞态补丁（只有 3.4.18 的锚点证据，参考实现未在其他构建复现）。
- 不支持 macOS/Linux；本设计沿用 Windows 路径、`x-device-type: windows`、`windowsHide` 假设。
- 不实现 Magpie 宿主侧、不写 `connection.json`（宿主写，插件只读）。
- 不承诺 `out/main.js` 热补丁在真实客户端里的运行行为（只做了临时副本的 `node --check`）。

---

## 2. 固定决策

| # | 决策 | 值 | 理由 |
| --- | --- | --- | --- |
| D1 | 包身份 | `magpie-agent-trae-intl@0.1.0`，ESM，`main: ./index.mjs`，MIT，`engines.node >= 20` | 与 Magpie Agent 插件宿主契约一致；零 npm 依赖 |
| D2 | Agent 身份 | id `trae-intl`，显示名 `Trae (International)` | 小写语义 id，避开内置 id 冲突 |
| D3 | 配置目录 / 端口 | `~/.config/magpie-trae-intl`、`127.0.0.1:3499` | 与 CN 版并存不抢端口/目录；`magpie.options.port` 只是编辑框初值 |
| D4 | 回环标记 | `magpie-trae-intl-local-bridge-v1` | 公开常量，不是上游密钥；桥的准入边界不依赖它保密 |
| D5 | 复用范围 | 桥、恢复日志状态机、指纹、锁、revision 复用 CN 设计；只替换“适配器常量” | 沿用 CN 参考实现的适配层/协议层/状态层三层切分 |
| D6 | 目录读取 | 默认 `batch_get_detail_param`（POST）；`model_list` 仅在显式策略下使用 | `model_list` 是 GET 且带请求体（国际版生成客户端静态定义），`fetch` 禁止 GET 带 body；见 §5.3.2 |
| D7 | 客户端热刷新 | 默认**关闭**，仅 `options.clientRefresh` 或 `MAGPIE_TRAE_INTL_CLIENT_REFRESH=1` 开启 | 3.6.20 只做过临时副本的语法检查，未在安装目录运行 |
| D8 | `/health` | 无鉴权但默认脱敏：不返回模型 id/名称；CLI `models` 改用带标记的 `/v1/models` | CN 参考实现的 `/health` 暴露模型名，是已知风险 |
| D9 | 凭据模式 | 默认 `native`（AES-256-GCM 封套）；`plaintext` 仅显式 opt-in | CN 参考实现的因果链证明明文 AK 会在聊天时失败；国际版未验证，故保留开关但默认关闭 |
| D10 | 模型 id | 默认按**数字**发送 `id`/`custom_model_id`；`idType:'string'` 仅作探针回退 | 2026-11-21 实测：update 拒绝字符串 id（400），数字 id 200；CN 同为 `Number` |
| D11 | 构建门控 | 仅 3.6.20 的 `harness.dll`/`ai_agent.dll`/`out/main.js` 哈希在允许表 | 哈希在本机只读测量；换版本必须重测 |
| D12 | 取消补丁 | 不实现 | 只有 3.4.18 锚点证据 |

---

## 3. 系统上下文与模块图

```
┌──────────────────────────── Magpie 宿主（Bun / moejs）────────────────────────────┐
│  moejs: trae.agent.js  ── 纯描述符 + connect() ──▶ 写 connection.json               │
│  Bun:   index.mjs      ── 单例守护 ──▶ startHost + startModelSync (+ 可选热刷新)     │
└───────────────┬───────────────────────────────┬──────────────────────────────────┘
                │ read-only                     │ read-only
                ▼                               ▼
   ~/.config/magpie-trae-intl/            Trae 安装目录 + 用户数据
     connection.json  (宿主写)              resources/app/product.json
     managed-models.json                    modules/ai-agent/{harness,ai_agent}.dll
     local-credential.json                  %APPDATA%/Trae/User/globalStorage/storage.json
     sync-status.json                     （全部只读；客户端补丁是唯一例外，默认关）
     model-sync.lock
                │
                │ 读 connection + credential
                ▼
        ┌───────────────┐    HTTPS    ┌──────────────────────────────┐
        │  sync.mjs     │────────────▶│ Trae 账户/模型 API            │
        │  (api.mjs)    │◀────────────│ /api/ide/v1/{model_list,     │
        └───────┬───────┘             │ batch_get_detail_param,     │
                │ 状态                 │ add/update_custom_model}     │
                ▼                     └──────────────────────────────┘
        sync-status.json
                │ revision
                ▼
   Trae 主进程 notifier（可选补丁）──▶ vscode:main::sandbox-icubeModelManagementChange

   Trae 原生 LLM 客户端 ── HTTP ──▶ 127.0.0.1:3499/v1/chat/completions
                                       │ 换 Authorization 为 gatewayKey
                                       ▼
                             Magpie 本机网关 /v1/chat/completions
```

### 3.1 模块职责与所有权

| 文件 | 所有者 | 职责 | 允许依赖 |
| --- | --- | --- | --- |
| `src/constants.mjs` | 架构（冻结） | 唯一常量源：身份、端口、主机表、枚举、允许表、上限 | 无（纯数据） |
| `src/paths.mjs` | A | 目录/安装发现、`product.json` 归一化 | `constants` |
| `src/session.mjs` | B | 登录态读取、请求头构造 | `constants`、`vendor/codec`、`paths`(类型) |
| `src/credential.mjs` | B | DLL 派生 profile、GCM 编解码、本地 AK 缓存 | `constants`、`paths`(类型) |
| `src/api.mjs` | B | Trae 云端目录 + CRUD、origin 选择 | `constants`、`session`(类型) |
| `src/state.mjs` | A | 原子读写、锁、路径别名 | `constants`、`paths` |
| `src/sync.mjs` | B | 恢复日志状态机、期望/释放循环、revision | `api`、`credential`、`state`、`session` |
| `src/bridge.mjs` | A | 回环 HTTP 桥、准入、转发、健康信息 | `constants`、`paths` |
| `src/client-refresh.mjs` | A | 客户端入口补丁、备份、还原 | `constants`、`paths` |
| `src/refresh-notifier.cjs` | A | 主进程内广播（CJS，被复制进 Trae） | `node:fs`、`node:os`、`node:path`、Electron |
| `src/vendor/trae-client-codec.mjs` | B | 登录态解码（MIT，见 `THIRD_PARTY.md`） | `node:crypto` |
| `trae.agent.js` | A | moejs 描述符 + `connect()`（零 import） | 无 |
| `index.mjs` | A | Bun 伴生入口（只导出 default） | 桥/同步/补丁 |
| `cli.mjs` | A | 诊断命令 | 全部 |
| `restore.mjs` | B | 退出补偿 worker | `sync`、`state` |

> “所有者”只用于并行分工，不限制阅读。`constants.mjs` 是唯一共享写点，已冻结；任何新常量先改契约文档再改该文件。

---

## 4. 运行形态与生命周期

1. **宿主安装/启用**：Magpie 读取 `package.json` 的 `magpie.agent`，在 moejs 里加载 `trae.agent.js`，拿到 `agent` 描述符。包内的 `*.agent.js` **不会**被隐式发现。
2. **用户选择模型**：宿主调用 `connect({gateway, models})`，把返回值写到 `connection.json`。该文件是宿主资产，插件永不写。
3. **伴生进程启动**：宿主加载 `index.mjs` 的 default 函数。单例键 `Symbol.for('magpie.trae-intl.bridge.v1')`；重复调用直接返回 `{}`。启动顺序：可选客户端补丁 → 桥 → 同步器。
4. **常驻**：桥监听 `127.0.0.1:3499`（失败每 2 s 重试，`EADDRINUSE` 不打印）；同步器每 5 s 检查 `connection.json`，内容未变且距上次检查 < 60 s 则跳过。
5. **退出**：`process.once('exit')` 时 detached 启动 `restore.mjs <port>`，`windowsHide`、`stdio: ignore`、`unref()`。它只在“桥已断开 + 恢复日志存在”时补做一次释放。
6. **失败隔离**：补丁失败不影响桥/同步；同步失败不阻断启动；桥失败持续退避。

---

## 5. 数据流

### 5.1 接入（connect）

```
Magpie ──connect({gateway:{v1,key}, models})──▶ trae.agent.js
                                                   │ 纯映射，同步返回
                                                   ▼
                          { version:2, baseURL:gateway.v1, gatewayKey:gateway.key,
                            models:[{id,name,context,output,images,efforts}] }
                                                   │ 宿主写
                                                   ▼
                                     ~/.config/magpie-trae-intl/connection.json
```

- `gateway.v1`/`gateway.key` 缺失 → 抛可读错误（→ `trae_gateway_required`），宿主“什么都不写”。
- `connect` 不返回 `model`/`effort`：模型选择权留在 Trae（CN 参考实现同策略）。
- `connect` 不做 I/O、不读文件、不 `fetch`、不设定时器；moejs 里这些都不可用。

### 5.2 聊天请求

```
Trae 原生 LLM 客户端
  │ POST http://127.0.0.1:3499/v1/chat/completions
  │ 鉴权头 = 公开标记（由 Trae 解密模型 ak 后得到）
  ▼
bridge.mjs
  1 Origin 头存在            → 403（挡浏览器）
  2 socket peer 非回环        → 403
  3 Host 非 127.0.0.1/localhost/[::1] + 端口 → 403（挡 DNS rebinding）
  4 GET /health              → 200（脱敏）
  5 鉴权头 ≠ Bearer <LOCAL_TOKEN> → 401 local_auth_invalid
  6 路由不在 /v1/models、/v1/chat/completions → 404
  7 方法不匹配                → 405
  8 connection.json 不可读/不合契约 → 503
  9 body 非法 / 模型不在白名单 / 超限 → 400 / 404 / 413
  ▼
重建请求：同一 body 重新序列化，不转发任何入站头；
  鉴权头 → `Bearer <gatewayKey>`；UA → magpie-agent-trae-intl/0.1.0
  ▼
Magpie 本机网关 → 上游模型
  ▼
响应：只复制 content-type / content-encoding / retry-after，
  加 cache-control: no-store、x-accel-buffering: no；
  body 原字节 pipeline（不解析 SSE，保住工具参数分片、图片、usage）
```

- 上游状态码原样透传（含 429 + `retry-after`）。
- 连接/头超时 10 s、请求 30 s、上游**空闲**超时 600 s；客户端断开 → 销毁上游请求。
- 入站 `baseURL` 约束：`http(s)`、host ∈ 回环集合、无 userinfo/query/hash、pathname 去尾斜杠后为 `/v1`、端口 ≠ 桥端口。
- 桥不转发、不记录任何 Trae 云端头（cookie、acl-token、转发链）。

### 5.3 目录同步

```
startModelSync (5s tick)
  │ connection.json 内容变化 或 距上次 > 60s
  ▼
syncModels
  0 withLock(model-sync.lock)                     ← 拿不到即 sync_busy（静默）
  1 read connection.json                          ← 只读；不存在/坏 → 视为未连接
  2 read managed-models.json                      ← ENOENT 允许；其它错误 sync_file_unreadable
  3 未连接且无日志 → 返回 {state:'disconnected', models:0, warnings:[], revision:'', updatedAt}，不写 status
  4 读 session（只读 storage.json + product.json）  ← 账号哈希必须等于日志 account
  5 api.list()                                    ← 权威目录
  6 日志版本 1→2 原地升级（无 pending 时）
  7 恢复 pending（add → update → delete，最多一个）
  8 期望循环：接管 / 创建 / 更新 / 跳过 / 告警
  9 释放循环：删除自建 / 还原接管 / 丢弃失联日志
 10 revision = sha256(sorted [id, fingerprint])
 11 写 sync-status.json
  ▼
notifier（可选）读 status → 向匹配窗口广播 → 客户端自行重拉目录
```

#### 5.3.1 恢复日志写入顺序（不可交换）

每条写操作固定为：**写 pending → 调云端 → 回读确认 → 清 pending 并落账**。这是 G3 的全部依据，沿用 CN 参考实现的成熟做法。

| pending | 写入时机 | 恢复动作 |
| --- | --- | --- |
| `add` | 创建前 | 用**精确三元组**（model + provider + baseURL）**且** name === display_name 查目录：0 条 → 清 pending 后重试创建；1 条 → 记为自建；>1 → `ambiguous_managed_model` |
| `update` | 更新/格式修复/还原前 | 按 id 找条目：缺失 → `trae_pending_model_missing`；未生效且指纹已变 → `trae_pending_model_edited`；否则**重放** update（幂等）并回读；`release` 为真时删除日志项 |
| `delete` | 删除前 | 条目仍在：指纹变了 → `trae_pending_model_edited`；否则再删；条目已不在 → 直接清日志 |

#### 5.3.2 目录读取策略（国际版的关键差异）

| 策略 | 传输 | 适用 | 风险 |
| --- | --- | --- | --- |
| `batch`（默认） | `POST /api/ide/v1/batch_get_detail_param`，body 取 `BATCH_DEFAULTS`，**默认不带 `Request` 封套**（仅 `envelope:true` 探针时附加） | 与 3.6.20 原生 `model_mgr.rs` 同一路径 | 响应层级 `function_configs` 可能是对象而非 CN 的数组；`custom_config` 可能是 JSON 字符串 |
| `model_list`（备选） | `GET /api/ide/v1/model_list?type=`，**body 含 `Request`** | 条目是扁平结构 | WHATWG `fetch` **禁止 GET 带 body**，必须用 `node:http` 专用传输；服务端是否容忍空 body 未验证 |
| `auto` | 先 batch，仅在 `trae_catalog_unknown` 时回退 model_list | 诊断/兼容 | 回退会多一次请求；不得在认证/网络错误时回退 |

归一化目标见 `interfaces.md` 的 `CatalogEntry`：两种响应都必须还原出 `id / model / provider / name / ak / sk / baseURL / status / config / detail`。

#### 5.3.3 期望/释放判定

| 云端状态 | 日志状态 | 动作 |
| --- | --- | --- |
| `(model, provider, baseURL)` 匹配 0 条 | 无日志 | 创建（走 pending add） |
| 匹配 1 条 | 无日志 | 接管：先写 `{created:false, before, last}`，再改 |
| 匹配 >1 条 | 无日志 | `ambiguous_model_configuration`，零写入 |
| id 找不到 | 有日志 | 警告 `managed_model_removed_in_trae`，**保留日志** |
| 指纹 ≠ `last` | 有日志 | 警告 `model_edited_in_trae`，**跳过** |
| 元数据不匹配或 `credentialFormat` 缺失 | 有日志 | 更新（含一次格式修复），回读 |
| 期望集合不含该 model | 有日志且未手改 | 自建 → 删除；接管 → 按 `before` 还原（含原 `status`） |
| 账号哈希不同 | 有日志 | `trae_account_changed`，**任何写入前失败** |

指纹（v2，修复 CN 指纹的盲区）：

```
fingerprint(entry) = JSON.stringify({
  configuration: { model, name, baseURL, status, provider,
                   authType, configSource, customModelType, detail, config },
  credential: sha256(`${ak || ''}\u0000${sk ?? ''}`)
})
```

`config` 是解析后的 `custom_config` 对象；用它覆盖 CN 指纹漏掉的 `auth_type/region/custom_model_type` 等字段。`credential` 把 `ak` 与 `sk` 用 `\u0000` 分隔后拼接取哈希，**连 SK 一起覆盖**：目录返回 SK 时，用户对 SK 的手改也能被检测（实现见 `src/sync.mjs` 的 `fingerprint()`）。`id` 不进指纹（id 是身份，不是内容）。

### 5.4 热刷新（可选）

```
syncModels 写 sync-status.json {state:'synced'|'disconnected', revision:64hex}
        │
notifier（Trae 主进程内，1s tick）
        │ 过滤：未销毁 && URL 前缀匹配 && 未在加载主框架
        │ 去重：window.id → revision
        ▼
window.send('vscode:main::sandbox-icubeModelManagementChange',
            { detail: { type:'update', model:{}, openSource:'magpie',
                        source:'magpie', revision } })
```

国际版的自身调用只发 `{detail:{type,model,openSource}}`，消费方只把事件当“需要刷新”的信号、不读 payload。本插件发送**超集**，同时保留 `source/revision` 便于诊断。

### 5.5 凭据派生

```
product.json.appVersion ──必须在 VERIFIED_BUILDS──▶ 目标 DLL 路径
harness.dll：标记 "key too shortrandom too short" 前 84 个 hex → h
ai_agent.dll：标记 "apps\icube_server_rs\crates\llm-client\src\crypto\crypto.rs" 前 94 个 hex → a
校验：h 匹配 ^[0-9a-f]{84}$；a 匹配 ^[0-9a-f]{64}[0-9]{10}[0-9a-f]{20}$；
      a[0:64] === h[0:64]；a[74:94] === h[64:84]
key = hex(h[0:64])（32B）；salt = hex(h[64:84])（10B）；key[0..8) ^= salt[0..8)；擦除 salt
AAD = ASCII(a[64:74])（10 位十进制）
```

- 两个整文件 SHA-256 必须分别命中允许表；任何不符 → 失败关闭。
- 扫描用 1 MiB 分块 + 跨块标记窗口，内存有界；**不使用固定偏移**（偏移是构建相关的）。
- 空 SK 与 AK 使用同一封套布局：`base64(nonce[12] || ct || tag[16])`，空串 → 40 个 base64 字符。国际版只验证了 AK，因此 `sk` 的编码封装默认开启但在诊断里标记为未验证。

---

## 6. 状态文件与磁盘布局

`~/.config/magpie-trae-intl/`（目录 `0700`，文件 `0600`）：

| 文件 | 写入者 | 读取者 | 内容 | 是否含凭据 |
| --- | --- | --- | --- | --- |
| `connection.json` | **Magpie 宿主** | 桥、同步器 | `{version:2, baseURL, gatewayKey, models[]}` | **含 gatewayKey**；插件只读、不复制 |
| `managed-models.json` | `syncModels` | `syncModels`、`restore` | 日志 + `pending`（`interfaces.md` §15.2） | `before` 含服务器返回的 ak 封套（密文） |
| `sync-status.json` | `syncModels`/`startModelSync` | 桥、notifier、CLI | 成功：`{state,models,warnings,revision,updatedAt,origin}`；失败：`{state:'pending',code,updatedAt}` | 否 |
| `client-refresh-status.json` | notifier | 诊断 | `{revision,windows,notifiedAt}` | 否 |
| `local-credential.json` | `localCredential` | `localCredential` | `{version:1, mode, profile, ak}` | 是（本机可解的标记封套） |
| `model-sync.lock` | `withLock` | `withLock` | `{pid,key}` | 否 |
| `client-backups/<version>/main.original.js` | `installClientRefresh` | `restoreClient` | 客户端入口原文 | 否 |
| `client-backups/<version>/manifest.json` | `installClientRefresh` | 诊断 | `{state,version,changed,backup,updatedAt}` | 否 |

**绝不落盘**：JWT、refreshToken、userId、deviceId、gatewayKey、DLL 派生 key/salt/AAD、模型明文 SK。

---

## 7. 状态机与关键不变量

```
pending = null
  ├─ 需要新增 ─▶ pending=add ──成功──▶ entries[model]={id,created:true,last,credentialFormat:2}
  │                          └─异常/丢响应──▶ 下次 tick 按精确三元组 + name 查目录
  ├─ 需要更新 ─▶ pending=update ──成功──▶ last=fingerprint(entry)
  │                          └─异常/丢响应──▶ 下 tick 校验指纹后重放（幂等）
  └─ 需要删除 ─▶ pending=delete ──成功──▶ 删除 entries[model]
                             └─异常/丢响应──▶ 条目在→校验后重删；不在→清日志
```

| # | 不变量 | 违反时的后果 |
| --- | --- | --- |
| I1 | 任何云端写之前，pending 已落盘 | 丢响应会重复创建/误删 |
| I2 | pending 最多一个 | 恢复顺序不确定 |
| I3 | 只释放日志里存在的条目 | 会删用户的模型 |
| I4 | 账号哈希不匹配 → 零写入 | 跨账号误改 |
| I5 | 指纹每次成功写入后更新 | 下一次 tick 把正常条目当手改或反之 |
| I6 | 手改条目只告警、不动 | 覆盖用户编辑 |
| I7 | 回读最多 6 次 × 200 ms，失败即保留 pending | 提前落账导致不一致 |
| I8 | `withLock` 覆盖整个 `syncModels` | 并发重复写 |
| I9 | 写文件一律 tmp + wx + rename | 半截 JSON |
| I10 | `connection.json` 只读 | 覆盖宿主的密钥 |
| I11 | revision 只由目录内容决定，不含原始凭据 | 每次 tick 都触发刷新 |
| I12 | 桥只转发 `connection.models` 白名单中的模型 | 任意模型名被代理 |

---

## 8. 失败模式

错误约定：`Error.message` 就是机器码（匹配 `^[a-z][a-z0-9_]*$`），同时挂 `err.code`；对外日志/状态只允许白名单化后的码。完整表见 `interfaces.md` §16。

| 阶段 | 情况 | 行为 |
| --- | --- | --- |
| 启动 | 补丁安装失败 | 捕获，打印白名单码（否则 `trae_client_refresh_install_failed`），继续启动 |
| 启动 | 端口被占 | 每 2 s 重试；非 `EADDRINUSE` 只打印一次通用提示 |
| 启动 | 同步器失败 | 后台写 `sync-status.json = pending`，入口仍返回 `{}` |
| 会话 | 未登录 / token 过期 / 设备键不唯一 | `trae_not_signed_in` / `trae_sign_in_expired` / `trae_device_unavailable`；零写入 |
| 凭据 | 版本/哈希/形状不符 | `trae_credential_version_unsupported` / `_build_unsupported` / `_profile_unknown`；零写入，绝不猜测 key |
| 目录 | 响应形状未知 | `trae_catalog_unknown`；auto 策略可回退一次 model_list |
| 目录 | 分组 `error_code` | `trae_catalog_<code>`；零写入 |
| CRUD | HTTP 非 2xx / `code !== 0` | `trae_api_<code|status>`；pending 保留 |
| CRUD | 回读不确认 | `trae_model_{create,update,delete,restore}_unverified`；pending 保留 |
| 恢复 | 条目被手改 | `trae_pending_model_edited`；保留用户改动并保留 pending（下次仍会尝试，直到用户/插件状态稳定） |
| 桥 | connection 缺失/坏/断开 | 503 + 统一文案；零上游请求 |
| 桥 | 上游连接失败 | 未发头 → 502；已发头 → 销毁响应 |
| 桥 | 客户端取消 | 销毁上游请求，不记录成功 |
| 退出 | 补偿 worker 失败 | 全部吞掉；下次启动重试 pending |

---

## 9. 与 CN 版的差异

| 维度 | CN v0.3.4 | INTL 0.1.0 | 依据 |
| --- | --- | --- | --- |
| 安装发现 | 固定 `%LOCALAPPDATA%/Programs/Trae CN/...` | 注册表 + 三个回退目录 + 校验 `providerCode=i18n`、`packageType=TRAE_I18N` | CN 源码常量；国际版在本机实测注册表与目录 |
| 用户数据目录 | `%APPDATA%/Trae CN`、`~/.trae-cn` | `%APPDATA%/Trae`、`~/.trae` | `product.json` 的 `dataFolderName=.trae` |
| 模型 API origin | `https://trae-api-cn.mchost.guru` | `https://<region host>`，SG=`coresg-normal.trae.ai`、normal=`core-normal.trae.ai`、US=`coreva-normal.trae.ai`、USTTP=`core-normal.traeapi.us` | 国际版 `product.json` bootConfig |
| origin 选择依据 | 源码常量 | `userRegion.region` → `bootConfig.agent`，缺失回退 `normal`；**不是** `auth.host` | 国际版生成客户端定义 + 完成日志实测 |
| 目录接口 | `batch_get_detail_param`，CN 的 5 个 `functions` | 默认 batch，`functions` 可配置（生成客户端示例 `['chat','builder']`）；备选 `model_list` | CN 源码；国际版生成客户端定义与 2026-11-21 实测 |
| 响应层级 | `function_configs` 为数组，元素含 `config_info_list` | `function_configs` 可能是**对象**（按 function 名）；`custom_config` 可能是 JSON 字符串；`custom_model_id` 在顶层条目 | 国际版 2026-11-21 实测响应 |
| 请求封套 | 无 | 目录调用**默认不带** `Request`（`envelope` 默认关，仅探针开）；CRUD 生成客户端不带 | 已实测（2026-11-21）：带 `Request` 400、无 `Request` 200（§13.2） |
| 模型 id | `Number(entry.id)` | 默认数字 id；`idType:'string'` 仅作探针回退 | 国际版实测（§14.1） |
| `custom_model_type` | `''` | `''`（UI 的 `other`，选择 other 时省略/空） | 国际版 UI 定义 |
| 思考参数 | `reasoning_effort` | 同；按 provider 有默认映射表 | 国际版 UI 默认映射 |
| 凭据版本白名单 | 3.4.18 / 3.4.20 | 3.6.20 | 两侧各自客户端的本机只读测量 |
| `main.js` 哈希 | 3.4.18 / 3.4.20 | 3.6.20 单一构建，`3381118 B` | 本机只读测量（见 `src/constants.mjs`） |
| 热刷新安装 | 默认开启 | **默认关闭**（D7），可显式开启/还原 | 3.6.20 仅做过临时副本语法检查 |
| 刷新载荷 | `{detail:{source,revision}}` | 超集 `{type,model,openSource,source,revision}` | 国际版完成日志实测 |
| 刷新通道 | 同名 | 同名（3.6.20 仍存在） | 国际版 3.6.20 实测 |
| `/health` | 返回模型 id/名称 | 默认脱敏；模型目录走带标记的 `/v1/models` | CN 的公开 `/health` 是已知风险 |
| 账号/设备头 | 带 `x-uid`、`x-cloudide-token` | 不发 `x-uid`、不发 `x-cloudide-token`；只发 JWT + 设备/版本/区域头 | 最小化凭据面，见 `interfaces.md` §3.2 |
| 取消补丁 | 有（3.4.18） | 无 | D12 |

**刻意保持不变**（复用 CN 的成熟部分）：桥的准入顺序、原始流管道、状态码透传、pending FSM、created/adopted 二分、账号绑定、锁、revision、退出补偿。

---

## 10. 安全与隐私

### 10.1 数据分级

| 级别 | 例子 | 规则 |
| --- | --- | --- |
| 公开 | 包名、版本、端口、回环标记、主机名、构建哈希、通道名 | 可进文档/测试/日志 |
| 本机敏感 | 安装路径、模型 id/名称、`connection.json`（含 gatewayKey）、`managed-models.json`、`local-credential.json` | 可落盘（`0600`），**不进** `/health` 默认输出、不进错误消息、不进 issue 模板 |
| 永不落盘/输出 | JWT、refreshToken、userId、deviceId、DLL key/salt/AAD、明文 AK/SK、gatewayKey 副本 | 只存在于内存；调试打印前必须白名单化 |

### 10.2 边界

1. **回环标记不是密钥**：它只在本机回环有效；真正的边界是回环监听 + 无 Origin + Host 校验 + 模型白名单 + 只向本机 Magpie 发送 `gatewayKey`。
2. **`gatewayKey`**：只从 `connection.json` 读进内存，只写入上游请求头；桥的错误、日志、`/health`、`sync-status.json` 一律不含它。
3. **`/health` 脱敏**：默认不返回模型 id/名称；`?models=1` 也不返回（只有 `/v1/models` 在带标记时返回）。CN 参考实现的公开 `/health` 是已知风险，本设计主动收窄。
4. **`local-credential.json`**：内容是用本机 DLL 派生密钥加密的回环标记；离开本机不可解。仍按凭据文件权限处理（`0700`/`0600`），且 `profile` 变更时重新编码。
5. **恢复日志的 `before`** 含服务器返回的 ak 封套（密文）。它用于还原接管条目；不还原就无法把用户原来的模型配置放回去。该文件必须按凭据处理。
6. **错误消息**：只允许机器码；上游响应体不进入错误消息（可能含账户信息）。桥对客户端只回通用文案。
7. **测试夹具**：只用合成封套与明显假值（如 `test-only-placeholder`）；不得使用真实 `storage.json`、真实 DLL 派生结果或真实 gatewayKey。
8. **不做遥测**、不访问除 Trae 账户 API 与 Magpie 本机网关以外的地址。

### 10.3 威胁模型（摘要）

| 威胁 | 缓解 | 残余风险 |
| --- | --- | --- |
| 本机任意进程调用桥 | 回环 + Host/Origin + 标记 + 模型白名单 | 标记是公开常量；同用户进程仍可调用（与 CN 相同） |
| 浏览器页面打本机端口 | `Origin` 头存在即 403 + Host 校验 | 无 |
| 恶意插件读配置目录 | 文件 `0600` | 同用户进程可读（平台限制） |
| 恶意模型把桥当开放代理 | 只允许 `connection.models`；只转发到 `connection.baseURL` | 无 |
| 日志泄漏 | 白名单码、无响应体、`/health` 脱敏 | 用户自行上传 `connection.json` 的风险需文档提示 |
| 未验证客户端被补丁 | 版本 + 哈希双门控；默认关闭 | 3.6.20 运行时未验证 |

---

## 11. 与 Magpie 宿主契约的对齐

| 契约点 | 本设计 |
| --- | --- |
| `magpie.agent` 声明 | `package.json` 指向 `./trae.agent.js` |
| moejs 无 Node API | 描述符零 import、`connect` 纯函数 |
| `connect` 预算 ~0.7 s | 只做数组 map 与字符串拼接 |
| 每个导出函数都会被调用 | `index.mjs` 只导出 default；`trae.agent.js` 只导出 `agent`/`connect` |
| `library.mcp` 必须带 `mcpFormat` | 一次写全四项，`mcpFormat: 'claude'` |
| `~`/`$VAR` 展开、未定义变量为空串 | 描述符用 `$APPDATA`/`~`；运行时路径由 `paths.mjs` 解析，不依赖展开 |
| `magpie.options` 只是建议值 | 入口自己 `options.port ?? 3499` |
| 包内 `*.agent.js` 不被发现 | 不依赖隐式扫描 |

> 上表各契约行为均在开发期对 Magpie 0.1.4596 宿主逐一核对，并与官方插件文档（<https://usemagpie.ai/docs/zh/plugins>）对齐。

---

## 12. 并行实现分工

两个实现者按文件所有权并行，唯一共享写点是已冻结的 `src/constants.mjs`。

| 实现者 A（运行时/桥） | 实现者 B（协议/同步） |
| --- | --- |
| `src/paths.mjs`、`src/state.mjs` | `src/session.mjs`、`src/vendor/trae-client-codec.mjs` |
| `src/bridge.mjs` | `src/credential.mjs` |
| `src/client-refresh.mjs`、`src/refresh-notifier.cjs` | `src/api.mjs` |
| `index.mjs`、`cli.mjs`、`trae.agent.js` | `src/sync.mjs`、`restore.mjs` |

测试文件也按所有者拆分，避免同文件冲突：

- A：`test/bridge.test.mjs`、`test/client-refresh.test.mjs`、`test/cli.test.mjs`
- B：`test/session.test.mjs`、`test/credential.test.mjs`、`test/codec.test.mjs`、`test/api.test.mjs`、`test/sync.test.mjs`
- 共享：`test/skeleton.test.mjs`（只断言契约，不随实现变化）

集成顺序：

1. A：`paths` + `state`（B 的同步器需要落盘）
2. B：`session` + `credential`（可先用注入的 codec/profile 单测）
3. B：`api`（用假 transport 单测两种目录形状）
4. B：`sync`（用假 api/credential 覆盖 pending 全表）
5. A：`bridge`（独立于 Trae，可先用假 `connection.json` 端到端）
6. A：`index` + `cli` + `restore`（串联）
7. A：`client-refresh` + notifier（默认关，单独测）
8. 合并：跑 `npm test && npm run check && npm run privacy && npm run pack:check`

接口变更规则：先改 `docs/design/interfaces.md`，再改 stub 签名，最后改实现；`constants.mjs` 的键名一旦发布不得复用为别的含义。

---

## 13. 验证边界

### 13.1 已核实（开发期只读核对）

| 事实 | 证据 |
| --- | --- |
| 本机 Trae 国际版 3.6.20，`providerCode=i18n`，`packageType=TRAE_I18N` | 本机安装目录的 `product.json` |
| 三个文件的大小与 SHA-256（两个 DLL + `out/main.js`） | 本机 `sha256sum` 实际运行 |
| `storage.json` 的 codec 可解码，字段与区域值取值 | 本机 `storage.json` 实际解码 |
| AK 的 AES-256-GCM 布局与两个正向样本、两个负向对照 | 本机样本验证 |
| 模型管理端点/字段名（生成客户端静态字符串） | 国际版生成客户端定义 |
| 原生模型服务方法表与 `model_mgr.rs` 使用 batch | 国际版客户端静态字符串 |
| 热刷新通道名与转发路径 | 国际版完成日志实测 |
| `out/main.js` 追加 `import()` 通过 `node --check` | 临时副本实际运行 |
| 安装发现顺序与 PowerShell 脚本结果 | 本机 PowerShell 实测 |
| Magpie 对 agent/connect/library/options 的契约 | Magpie 0.1.4596 宿主行为核对与官方插件文档 |

### 13.2 未核实（设计如何兜底）

| 缺口 | 兜底 |
| --- | --- |
| ~~模型 API 的线上报文~~ 已实测（2026-11-21）：`coresg-normal.trae.ai` + 现有请求头对 CN 形态请求体返回 200；2xx 响应无 `code` 字段（原 CN 判定会误报 `trae_api_200`，已修复）；自定义模型回读只含 `model_name/provider/base_url/ak/status/thinking_enable/reasoning_param/max_turn/multimodal/display_name`，不含 `max_tokens/prompt_max_tokens/sk/config_detail`，同步比对已改为只校验回读字段 |
| ~~`Request` 封套是否必需~~ 已实测（2026-11-21）：`batch_get_detail_param` 对带 `Request` 的生成客户端变体返回 400，CN 形态无 `Request` 返回 200；`envelope` 默认已改为关，仅保留给探针 |
| `FunctionConfig` 其余 4 个字段 | 解析只依赖已确认的 `config_info_list`；未知字段忽略 |
| `custom_config` 的层级 | 解析器同时接受“条目顶层”和“`model_detail_list[]` 内”两种位置 |
| 非空 SK 的封套 | 不主动写非空 SK；还原时原样回传服务器给的值 |
| `model_list` 的 GET body | 默认不走该策略；需要时用 `node:http` 专用传输 |
| `out/main.js` 运行时补丁 | 默认关闭；只在哈希命中时安装；`restore-client` 永远可用 |
| notifier 能否 `require('electron')` | 注入 `options.electron`；失败只影响刷新，不影响桥/同步 |
| 非 Windows | 明确不支持 |
| `/health` 的实际风险等级 | 默认脱敏（比 CN 更严） |
| 与 CN 插件并存 | 目录/端口/agent id 全部不同；不共享任何文件 |

### 13.3 本次会话实际运行的检查

| 命令 | 结果 |
| --- | --- |
| `npm run check`（`node scripts/check-syntax.mjs`） | `check-syntax: ok (19 file(s), node --check)` |
| `npm test`（`node --test "test/**/*.test.mjs"`） | `tests 9 / pass 9 / fail 0` |
| `npm run privacy` | `privacy: ok (31 file(s), 9 rule(s))` |
| `npm run pack:check` | `npm pack --dry-run lists 20 file(s)` / `ok (runtime files only; no docs, tests, scripts or state)` |

负向对照（同一会话内临时文件，跑完即删）：含 Windows 用户目录形式（`%USERPROFILE%\...`）与伪造 JWT 的文件被 privacy 报 2 条 finding、退出码 1；含 `const broken = ;` 的文件被 check-syntax 判失败、退出码 1。

除以上检查外，本次**没有**运行真实 Trae 客户端、没有调用 Trae 云端、没有安装补丁、没有读取任何真实凭据。

### 13.4 真实账号目录验收（2026-11-21）

| 步骤 | 结果 |
| --- | --- |
| 只读目录探测（诊断矩阵） | CN 形态请求体在 `coresg-normal.trae.ai` 返回 200；生成客户端变体 400（定位首次接入 `trae_api_400` 的根因） |
| `syncModels` 新增 | `state:'synced'`，服务端创建 `custom_model_id`，回读 `display_name/base_url/ak/client_connect/thinking_enable/max_turn/multimodal` 与请求一致；AK 原样回显（封套通过服务端存储往返） |
| 幂等复跑 | 第二次 `syncModels` 无新增、revision 不变、无重复条目 |
| 桥冒烟 | 原生编码标记 → 200（经桥转发至桩上游）；错误标记/坏标记 → 401 |
| 释放删除 | 移除 connection 后 `syncModels` 删除模型并回读确认不存在（数字 id 删除一次成功；字符串 id 400，已修复为数字） |
| 账户安全 | 前后快照比对：除测试模型外零增删改；测试模型已清理 |

---

## 14. 开放问题

1. ~~国际版 `custom_model_id` 是否接受字符串~~ 已实测（2026-11-21）：`update_custom_model` 拒绝字符串 id（400），数字 id 返回 200；插件已默认发数字 id。
2. 空 SK 是否需要原生封套——国际版缓存里 `sk` 全为空字符串，但聊天时是否校验未知。
3. ~~`functions` 的默认集合~~ 已实测（2026-11-21）：CN 的 5 个 function（`chat_v3`/`solo_work_lite`/`solo_agent`/`solo_agent_lite`/`solo_coder`）返回 200，`['chat','builder']` 返回 400；`BATCH_DEFAULTS` 已按实测修正。
4. `model_list` 的 GET body 能否省略——需要抓包。
5. 区域变化（SG↔US）时是否需要重建模型条目——`base_url` 不变，理论上不需要；未验证。
6. 客户端补丁在真实 3.6.20 的加载时序与 CSP——只做了语法检查。
