# 使用与故障排查

本文是 [`README.md`](../README.md) 的操作手册，覆盖安装、启用、首次重启、模型选择、热刷新、断开/卸载，以及常见错误码的处理顺序。

> **适用环境**
>
> Windows 10/11 x64、Trae 国际版 3.6.20、Magpie 0.1.4596。其他构建、macOS、Linux 未验证。
>
> 文中把两类结论分开写：
>
> - **代码行为**：能在 `src/`、`cli.mjs` 和离线测试中找到依据。
> - **客户端行为**：模型目录的新增/修改/删除已通过真实账号验收（2026-11-21）；端到端聊天与窗口刷新时序仍以 Trae 实际客户端为准。遇到不一致时，按第 10 节收集信息。

---

## 0. 占位符

| 占位符 | 含义 |
| --- | --- |
| `<仓库目录>` | 本插件源码所在目录 |
| `<Trae 安装目录>` | Trae 国际版的安装根目录，其下有 `Trae.exe` 和 `resources/app` |
| `<模型名>` | Magpie 中配置的模型显示名 |
| `%APPDATA%` | Windows 当前用户的 Roaming 目录 |
| `%LOCALAPPDATA%` | Windows 当前用户的 Local 目录 |
| `~` | 当前用户主目录 |

命令中的 `<...>` 都需要替换成实际值；不要把真实用户名、绝对路径或凭据写进文档、issue 或聊天记录。

---

## 1. 安装前检查

### 1.1 确认 Magpie 和 Node

```powershell
magpie --version
node --version
```

- `magpie` 能运行，且版本为 0.1.4596 或你明确知道差异的版本。
- 直接运行 CLI 需要 Node.js 20+；插件本身由 Magpie 的 Bun 宿主加载，不需要你单独安装 Bun。
- Magpie 中至少有一个可用模型或路由组，并且 Magpie 网关能正常响应。

### 1.2 确认 Trae 国际版

1. 打开 Trae，确认界面是国际版（不是 Trae CN）。
2. 在“关于”或帮助信息中确认版本为 **3.6.20**。
3. 确认已经登录，模型菜单能正常打开。
4. 关闭 Trae 前先记住是否还有未保存的会话。

插件会读取 `<Trae 安装目录>/resources/app/product.json`，要求：

- `applicationName` 为 `trae`
- `providerCode` 为 `i18n`
- `packageType` 缺失或为 `TRAE_I18N`
- 凭据阶段还要求 `appVersion` 在允许表中（当前只有 `3.6.20`）

发现阶段任何一项不满足都会失败关闭；版本不在允许表时，同步会在派生凭据前停下，不会尝试“猜”一个可用配置。

### 1.3 确认没有第二个副本

不要在 Magpie 中同时安装两个本插件副本，也不要同时运行两个 Magpie 宿主去争用 `3499` 端口。CN 插件使用 `3498`，可以并存；但不要把 CN 的配置目录复制过来。

---

## 2. 安装与启用

### 2.1 添加插件

推荐直接从 GitHub 安装（仓库：<https://github.com/not502/magpie-agent-trae-intl>）：

```powershell
magpie plugin add github:not502/magpie-agent-trae-intl
```

从本地仓库目录安装（适合开发调试）：

```powershell
cd <仓库目录>
magpie plugin add .
```

或：

```powershell
magpie plugin add <仓库目录>
```

说明：

- `magpie plugin add <本地目录>` 是**就地加载**，不会复制到插件缓存。移动或删除 `<仓库目录>` 后插件失效（从 GitHub 安装则没有这个限制）。
- 添加、移除、更新或开关插件会重启 Magpie 宿主。如果 Magpie 正在运行，按提示重新打开。
- 可选：运行 `magpie plugin --json` 查看安装记录。不同 Magpie 版本字段不同，只要能找到对应 spec 即可。

### 2.2 在 Magpie Agent 页启用

1. 打开 Magpie。
2. 进入 **Agent** 页面（有的版本叫“智能体”或“接入”）。
3. 找到 **Trae (International)**。
4. 打开接入开关。
5. 如果页面提供模型/路由组选择，展开底部“显示其余”区域，再选择要暴露给 Trae 的条目。
6. 保持 Magpie 运行。

启用成功后，宿主会写入：

```text
~/.config/magpie-trae-intl/connection.json
```

这个文件由 Magpie 写，插件只读。它包含 `gatewayKey`，不要手工编辑、不要提交到仓库、不要贴到 issue。

### 2.3 首次重启 Trae

**完整退出 Trae，然后重新启动一次。** 仅关闭窗口不一定退出进程；请从托盘/任务栏确认。

需要重启的时机：

| 场景 | 操作 |
| --- | --- |
| 首次启用插件 | 重启 Trae 一次 |
| 首次开启客户端热刷新 | 重启 Trae 一次，让补丁在启动时加载 |
| Trae 升级后重新安装热刷新 | 重启 Trae 一次；升级通常会覆盖 `out/main.js` |
| 之后在 Magpie 中增删模型 | 重新加载 Trae 窗口即可；开启热刷新后插件会发通知 |
| 修改端口/配置目录 | 等同步完成后重新加载窗口，必要时重启 |
| 执行 `restore-client` 后 | 重启 Trae 一次，让原入口生效 |

> “首次重启一次、之后重新加载窗口”来自 Agent 描述符和 Trae 的常规模型列表加载方式；未做真实账号的端到端计时验收。

### 2.4 在 Trae 中选择模型

打开 Trae 的模型菜单，选择名称以 **` · Magpie`** 结尾的条目。例如：

```text
Example Model · Magpie
```

- Magpie 的 Agent 页显示 **Trae (International)**；Trae 菜单显示带 ` · Magpie` 后缀的模型。**Trae (International) 是 Magpie 侧的接入名称，不是 Trae 菜单里的模型名前缀。**
- 显示名最长 64 字符，模型名很长时后缀可能被截断；以 Magpie Agent 页的对应关系为准。
- 如果菜单里没有条目，先按第 3 节验证同步状态，再按 5.11 排查。

---

## 3. 安装后的最小验证

在 `<仓库目录>` 执行：

```powershell
node cli.mjs status
node cli.mjs models
node cli.mjs doctor
```

### 3.1 `status`

期望看到（字段顺序/数量可能随版本略有不同）：

- `"name": "magpie-trae-intl"`
- `"connected": true`
- `"sync": { "state": "synced", "models": <数量> }`
- `"credential": { "mode": "native" }`

关键字段解释：

| 字段 | 含义 | 异常时 |
| --- | --- | --- |
| `connected` | `connection.json` 存在且符合契约 | 在 Magpie 中重新启用接入 |
| `sync.state` | `synced` / `disconnected` / `pending` / `unknown` | `pending` 看 `sync.code`；`unknown` 看 status 文件 |
| `sync.models` | 当前期望的模型数量 | 0 表示 Magpie 没选模型或连接文件为空 |
| `sync.code` | 最近一次失败的机器码 | 按第 5 节处理 |
| `sync.warnings` | 模型级警告 | `model_edited_in_trae` 等，见 5.5 |
| `lastRequest` | 最近一次聊天请求摘要 | 不含消息内容；用于确认桥是否转发过 |
| `lastRejection` | 最近一次被拒绝的请求 | 常见 `local_auth_invalid` |

如果桥不在线：

```text
magpie-trae-intl: the local bridge on 127.0.0.1:3499 is not answering.
```

退出码为 1。先确认 Magpie 正在运行、插件已加载、端口没有被占用（5.6）。

### 3.2 `models`

输出一个数组，每项大致为：

```json
{
  "id": "<model id>",
  "object": "model",
  "owned_by": "magpie",
  "name": "<显示名>",
  "images": true,
  "efforts": ["low", "high"],
  "context_length": 128000,
  "max_output_tokens": 16000
}
```

- `context_length` / `max_output_tokens` 只在值 > 0 时出现。
- 这里打印的是模型 ID 和名称，不是聊天内容；分享前仍建议确认是否包含敏感项目名。
- 如果 `status` 正常但 `models` 为空，说明 Magpie 没有选模型。

### 3.3 `doctor`

`doctor` 不需要桥在线，直接读取配置和本机环境。重点看：

| 字段 | 期望 | 说明 |
| --- | --- | --- |
| `product.appVersion` | `3.6.20` | 实际读到的 Trae 版本 |
| `product.providerCode` | `i18n` | 不是 `i18n` 说明指向了 CN 或错误目录 |
| `paths.appSource` | `env` / `registry` / `fallback` | 安装目录来源；不会打印绝对路径 |
| `region` | `CN` / `SG` / `US` / `normal` / `USTTP` / `UNKNOWN` | 模型 API 区域 |
| `host` | 区域主机名 | 不包含账号信息 |
| `session.signedIn` | `true` | 是否读到完整登录态 |
| `session.expiresAtPassed` | `false` | JWT 是否已过期 |
| `session.deviceKeys` | `1` | 设备键必须唯一 |
| `credential.mode` | `native` | 默认原生封套 |
| `credential.profileAvailable` | `true` | DLL 派生是否成功 |
| `credential.buildAllowed` | `true` | 版本是否在允许表 |
| `catalog` | `batch` | 目录读取策略 |
| `clientRefresh` | `off` / `installed` / `unsupported` | 热刷新状态 |
| `sync.state` / `models` / `revision` | 与 status 文件一致 | 同步摘要 |

`doctor` 只输出布尔值、版本、枚举和主机名；不输出 token、userId、deviceId、gatewayKey 或模型 `ak`/`sk`。

### 3.4 首次同步的一次性检查

如果想主动触发一次同步：

```powershell
node cli.mjs sync
```

成功时输出类似：

```json
{
  "state": "synced",
  "models": 2,
  "warnings": [],
  "revision": "<64 位十六进制>",
  "updatedAt": "<ISO 时间>",
  "origin": "<主机名>"
}
```

失败时输出：

```json
{ "error": "<机器码>" }
```

退出码为 1。按第 5 节处理。

---

## 4. 模型能力、菜单和目录更新

### 4.1 能力映射

| Magpie 字段 | 写入 Trae | 规则 |
| --- | --- | --- |
| `context` | `prompt_max_tokens` | > 0 才写；0/缺失不声明 |
| `output` | `max_tokens` | > 0 才写 |
| `images` | `multimodal` | 布尔值 |
| `efforts` | `thinking_enable` + `reasoning_param` | 去掉 `default` 后非空 → `thinking_enable=1`，`values=["default", ...档位]`；否则 `0` 且不带参数 |
| `name` | `display_name` | 追加 `" · Magpie"`，最多 64 字符 |
| `id` | `model_name` | Trae 的模型标识 |
| — | `max_turn` | 固定 500 |

聊天时桥保留 `stream`、`tools`、图片和 `reasoning_effort`；实际能力取决于上游模型。上游的限流、余额、套餐和参数错误会原样返回。

### 4.2 目录更新

- 每 5 秒检查 `connection.json`。
- 内容未变且距上次检查 < 60 秒时跳过。
- 内容变化（启用、断开、换模型、换端口）触发同步。
- 失败写 `sync-status.json = {state:"pending", code}`；后续 tick 重试。连接内容变化时通常是下一个 5 秒 tick；空闲重试仍受 60 秒间隔限制。
- 写操作顺序：pending → 云端 → 回读 → 落账；响应丢失不会重复创建/误删。

### 4.3 在 Magpie 中增删模型

1. 在 Magpie 的 Agent 页勾选/取消模型。
2. 等待一个同步周期（通常几秒；空闲复核最多 60 秒）。
3. 重新加载 Trae 窗口；开启热刷新时由插件自动通知。
4. 用 `node cli.mjs status` 看 `sync.models` 是否变化。
5. 删除模型时，插件会删除自己创建且未手改的条目；接管条目会还原；手改条目保留并告警。

---

## 5. 故障排查

### 5.1 认证过期 / 未登录

**症状**

- `node cli.mjs status` 的 `sync.code` 为 `trae_not_signed_in`、`trae_sign_in_expired`、`trae_device_unavailable`、`trae_session_unreadable` 或 `trae_codec_unsupported`。
- `doctor` 的 `session.signedIn=false`，或 `expiresAtPassed=true`，或 `deviceKeys=0`。

**原因**

- Trae 未登录、登录已过期、登录信息被清理。
- `storage.json` 缺失/损坏。
- 登录信息的编码格式不是插件认识的格式（通常是客户端版本变化）。
- 设备键不是恰好一个。

**处理**

1. 打开 Trae，确认账号仍处于登录状态；必要时退出登录并重新登录。
2. 完全退出 Trae，再重新打开。
3. 再运行：

   ```powershell
   node cli.mjs doctor
   node cli.mjs sync
   ```

4. `signedIn=true` 且 `expiresAtPassed=false` 后再看 `sync`。
5. 如果仍是 `trae_codec_unsupported`：
   - 确认 Trae 版本确实是 3.6.20；
   - 不要手工修改 `storage.json`；
   - 记录错误码和版本，按第 10 节收集信息。
6. 如果 `trae_device_unavailable`：
   - 确认没有同时运行多个 Trae 用户数据目录；
   - 重新登录后仍失败，检查 `%APPDATA%/Trae/User/globalStorage` 是否被清理或还原过。

插件**不会**刷新 token，也**不会**把 token 发给 Magpie；重新登录是唯一可靠的修复方式。

### 5.2 DLL 版本不支持

**症状**

- `trae_credential_version_unsupported`
- `trae_credential_build_unsupported`
- `trae_credential_profile_unknown`
- `trae_credential_unavailable`
- `doctor` 的 `credential.buildAllowed=false` 或 `profileAvailable=false`。

**含义**

| 错误码 | 含义 |
| --- | --- |
| `trae_credential_version_unsupported` | `product.json.appVersion` 不在允许表 |
| `trae_credential_build_unsupported` | 两个 DLL 的整文件 SHA-256 不匹配允许表 |
| `trae_credential_profile_unknown` | DLL 中的标记不唯一或前缀不完整 |
| `trae_credential_unavailable` | `native` 模式下无法得到可用的派生 profile |

**处理**

1. 确认安装的是**官方 Trae 国际版 3.6.20**，不是 CN、不是被修改过的构建。
2. 确认 `MAGPIE_TRAE_INTL_APP` 没有指向旧版本或错误目录。
3. 如果最近升级/降级过 Trae，恢复官方 3.6.20 后重试。
4. 不要修改 DLL、不要伪造哈希、不要手动填 key/salt/AAD。插件会失败关闭。
5. 其他构建需要重新测量 DLL 哈希并更新允许表，属于维护者工作，不是用户配置项。

**关于 `plaintext` 模式**

`MAGPIE_TRAE_INTL_CREDENTIAL=plaintext` 会让插件把回环标记明文写进 Trae 模型配置，绕过 DLL 派生。它只用于诊断，**不建议日常使用**：

- 国际版是否接受明文 `ak` 未验证；
- CN 的证据显示明文 AK 在聊天时可能被拒绝（`invalid ak`）；
- 使用后如出现聊天失败，先移除该环境变量，恢复 `native`，重新同步模型。

### 5.3 客户端补丁哈希不匹配

**症状**

- `trae_client_refresh_build_unsupported`
- `trae_client_refresh_backup_invalid`
- `trae_client_refresh_write_failed`
- `trae_client_not_installed`
- `doctor` 的 `clientRefresh=unsupported`。

**先判断是否开启过热刷新**

默认关闭。如果你没有设置 `options.clientRefresh` 或 `MAGPIE_TRAE_INTL_CLIENT_REFRESH=1`，这些错误通常只出现在 Magpie stderr/诊断文件里，**不影响桥和目录同步**，可以忽略。

**处理**

1. 如果开启过：执行

   ```powershell
   node cli.mjs restore-client
   ```

   然后重启 Trae。
2. `restore-client` 返回：
   - `restored`：已还原，重启 Trae；
   - `unchanged`：本来就是原文件；
   - `absent`：没有备份或版本不在允许表，未做修改；
   - 抛错：按错误码处理。
3. `trae_client_refresh_backup_invalid`：备份文件哈希不对，不要用未知备份覆盖 `main.js`。重新安装 Trae 或联系维护者。
4. `trae_client_not_installed`：找不到 Trae 安装或 `out/main.js`；检查安装目录。
5. Trae 升级后：`out/main.js` 哈希会变化，旧允许表不再匹配。此时不要强行打补丁；保持热刷新关闭，桥和同步仍可用。
6. **不要手工编辑 `<Trae 安装目录>/resources/app/out/main.js`**。需要撤销时只用 `restore-client`。

### 5.4 同步 pending

**症状**

- `status` 的 `sync.state` 为 `pending`，`sync.code` 有值。
- `sync-status.json` 形如：

  ```json
  { "state": "pending", "code": "<机器码>", "updatedAt": "<ISO>" }
  ```

**含义**

最近一次同步失败。桥仍可能在线，但 Trae 的模型目录可能停留在上一次成功的状态。插件会在后续 tick 重试；连接内容未变时仍受 60 秒空闲间隔限制；`sync_busy` 会被静默忽略。

**处理顺序**

1. 运行 `node cli.mjs status`，记录 `sync.code`。
2. 运行 `node cli.mjs doctor`，看 `product`、`session`、`credential`、`host` 是否正常。
3. 按错误码分组处理：

| 错误码 | 去哪里 |
| --- | --- |
| `trae_not_signed_in` / `trae_sign_in_expired` / `trae_device_unavailable` / `trae_session_unreadable` / `trae_codec_unsupported` | 5.1 |
| `trae_installation_unavailable` / `trae_product_not_international` / `trae_platform_unsupported` | 5.7 |
| `trae_credential_*` | 5.2 |
| `trae_account_changed` / `ambiguous_*` / `trae_pending_model_*` | 5.5 / 5.8 |
| `trae_model_*_unverified` | 5.8 |
| `trae_catalog_unknown` / `trae_catalog_<code>` / `trae_api_*` / `trae_response_*` | 5.9 |
| `sync_busy` | 等当前同步结束；不要并行运行两个 Magpie 宿主 |
| `sync_file_*` / `sync_lock_invalid` | 5.10 |
| `trae_origin_unavailable` | 5.9 |

4. 修复后主动触发：

   ```powershell
   node cli.mjs sync
   ```

5. 仍然 pending 时，不要连续手工重试几十次；记录错误码、`doctor` 输出和最近一次成功的时间，按第 10 节收集信息。

### 5.5 模型被手改

**症状**

- `sync.warnings` 出现 `{ "model": "<模型>", "code": "model_edited_in_trae" }`。
- 或同步失败码为 `trae_pending_model_edited`。

**行为**

- 如果条目在 Trae 中被手动修改（名称、地址、状态、配置、凭据等），插件检测到指纹变化后**跳过**该条目，不覆盖用户改动。
- 断开时，手改条目**保留**，不会删除或还原。
- `managed_model_removed_in_trae` 表示插件日志里记录的条目在 Trae 中已不存在；插件保留日志并告警。

**你想保留手改**

不做任何操作。插件会继续告警，但不会覆盖。断开后条目仍然存在。

**你想让插件重新接管**

1. 在 Trae 中删除该条目。
2. 在 Magpie 中关闭再打开 Trae (International) 接入，或等待一次断开/重连。
3. 断开时，插件发现条目已不存在，会从恢复日志中移除；重新连接后按新配置创建。
4. 用 `node cli.mjs status` 确认 `sync.state=synced`、`warnings=[]`。

**`trae_pending_model_edited` 的紧急处理**

这个码表示“待重放的写操作发现条目被手改”，插件会保留 pending 并反复失败。优先做法是把你刚做的修改改回去，或按上面的“删除 + 断开/重连”让状态重新收敛。

如果确实无法收敛，才使用下面的应急步骤：

1. 完全退出 Magpie。
2. 备份 `~/.config/magpie-trae-intl/managed-models.json`。
3. 只把顶层 `"pending"` 改为 `null`，不要改 `entries` 里的其他内容。
4. 重新启动 Magpie，运行 `node cli.mjs sync`。
5. 如果仍有残留，按“删除 + 断开/重连”处理。

这会丢弃那一次未完成的写操作。`managed-models.json` 含加密的接管快照，备份文件不要分享。

### 5.6 桥错误（HTTP 状态码）

Trae 的聊天请求会收到以下状态码；桥的错误体统一为：

```json
{ "error": { "type": "magpie_trae_error", "message": "<通用文案>" } }
```

| 状态 | 可能原因 | 处理 |
| --- | --- | --- |
| 400 | 请求体不是合法 JSON，或缺少 `model`/`messages` | 重新选择模型；检查 Trae 侧请求是否被代理改写 |
| 401 | 回环标记不正确（`local_auth_invalid`） | 重新同步模型；确认没有混用 CN 配置；不要手工改 `connection.json` |
| 403 | 带 `Origin` 头、非回环来源、或 `Host` 不合法 | 不要用浏览器/网页工具直接调用；检查本机代理 |
| 404 | 路由不存在，或模型不在 `connection.models` 白名单 | 在 Magpie 中重新勾选模型并等待同步 |
| 405 | 方法不对（`/v1/models` 只允许 GET，聊天只允许 POST） | 检查调用方 |
| 413 | 请求体超过 32 MiB | 缩小请求；检查是否附带了过大的图片/附件 |
| 502 | 本机 Magpie 网关不可达，或上游在发头前失败 | 确认 Magpie 网关在运行；检查 `connection.json` 的 `baseURL` |
| 503 | `connection.json` 缺失/不合契约，或 Trae 未连接 | 在 Magpie 中重新启用接入；不要手工编辑连接文件 |

**桥不在线 / `status` 退出码 1**

1. 确认 Magpie 正在运行，插件已启用。
2. 检查端口是否被占用：

   ```powershell
   Get-NetTCPConnection -LocalPort 3499 -ErrorAction SilentlyContinue
   ```

   或：

   ```powershell
   netstat -ano | findstr :3499
   ```

3. 如果被其他进程占用，停止该进程，或换端口：

   ```powershell
   set MAGPIE_TRAE_INTL_PORT=3500
   ```

   然后重启 Magpie 宿主，等待同步，重新加载 Trae。
4. 确认没有同时运行两个本插件副本或两个 Magpie 宿主。

### 5.7 安装发现 / 产品识别失败

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `trae_installation_unavailable` | 找不到 `Trae.exe`、`product.json`、安装目录或 DLL | 用 `MAGPIE_TRAE_INTL_APP` 指向 `<Trae 安装目录>` 或 `<Trae 安装目录>/resources/app` |
| `trae_product_unreadable` | `product.json` 不是合法 JSON | 重新安装官方 Trae |
| `trae_product_not_international` | `providerCode` 不是 `i18n`，或 `packageType` 不是 `TRAE_I18N` | 检查是否指向 Trae CN；改用国际版目录 |
| `trae_platform_unsupported` | 非 Windows | 本插件不支持 macOS/Linux |
| `trae_home_unavailable` / `trae_home_invalid` | 找不到用户主目录，或主目录不是绝对路径 | 设置正确的 `USERPROFILE`/`HOME` |

`MAGPIE_TRAE_INTL_APP` 只影响**发现**，不会绕过版本/哈希校验。把它指向 CN 目录不会让插件工作，只会得到 `trae_product_not_international`。

### 5.8 恢复日志冲突 / 账号变化

| 错误码/警告 | 含义 | 处理 |
| --- | --- | --- |
| `trae_account_changed` | `managed-models.json` 的账号哈希与当前 Trae 账号不一致 | 切回原账号并断开；不要在另一个账号上继续使用同一配置目录 |
| `ambiguous_model_configuration` | 云端有多个 `(model, provider, base_url)` 相同的条目，无法判断接管哪一个 | 在 Trae 中删除重复条目；插件不会猜 |
| `ambiguous_managed_model` | 恢复 pending add 时按精确三元组 + 名称找到多条 | 清理重复条目后重试 |
| `trae_pending_model_missing` | 恢复 pending update 时按 id 找不到条目 | 按 5.5 清理 pending；然后“删除 + 断开/重连”，让日志丢弃失联条目并重新创建 |
| `trae_model_create_unverified` | 创建后回读仍找不到 | 保留 pending，下次重试；检查 Trae 模型列表和账户接口 |
| `trae_model_update_unverified` | 更新后回读不一致 | 同上 |
| `trae_model_delete_unverified` | 删除后条目仍在 | 同上 |
| `trae_model_restore_unverified` | 还原接管条目后回读不一致 | 同上 |

**想换 Trae 账号**

不要直接复用配置目录。推荐：

1. 在原账号下断开接入，等 `disconnected`，让插件撤回模型。
2. 退出原账号，登录新账号。
3. 重新启用接入。

如果原账号已无法登录，需要手动清理：备份并移走 `managed-models.json`，然后在新账号下重新同步；旧账号里的带 ` · Magpie` 条目需要在 Trae 中手动删除。移走日志后插件无法自动撤回旧条目。

### 5.9 目录 / 网络 / API 错误

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `trae_catalog_unknown` | 目录响应形状不认识 | 通常是客户端版本变化；先 `doctor`，不要连续重试 |
| `trae_catalog_<error_code>` | 云端某个 function 分组返回错误码 | 记录码；检查账号/套餐/区域；稍后重试 |
| `trae_catalog_strategy_unsupported` | 选了一个当前传输不支持的目录策略 | 默认 `batch`；不要手工切到 `model_list` |
| `trae_api_<code\|status>` | HTTP 非 2xx 或业务码非 0 | 401/403 看 5.1；429/5xx 稍后重试 |
| `trae_response_<status>` | 响应不是 JSON | 检查网络/代理；稍后重试 |
| `trae_origin_unavailable` | 找不到区域主机 | 检查 `product.json` 的 `bootConfig.agent` 或网络环境 |
| `trae_origin_invalid` | origin 覆盖非法（通常只在测试） | 不要设置非法 override |

如果错误持续且 `doctor` 的 `host` 为 `null`，先把 `doctor` 输出和错误码收集起来；不要猜测第二套主机。

### 5.10 文件/锁/权限错误

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `sync_file_unreadable` | 配置文件读不了/不是 JSON/路径是目录 | 检查 `~/.config/magpie-trae-intl` 权限，以及 `connection.json`、`managed-models.json` 是否存在且为合法 JSON |
| `sync_file_unwritable` | 配置目录/临时文件写不了 | 检查磁盘空间、权限、杀毒软件拦截 |
| `sync_lock_invalid` | 锁文件内容不是合法 `{pid,key}` | 确认没有 Magpie 在跑后删除 `model-sync.lock` |
| `sync_busy` | 另一个同步持有锁 | 等待；不要并行运行两个宿主 |
| `trae_credential_cache_unreadable` | `local-credential.json` 读不了 | 备份后删除，下次同步重建 |
| `trae_credential_self_check_failed` | 新生成的封套自检失败 | 检查 DLL/版本；不要手工写入封套 |
| `trae_credential_mode_invalid` | `MAGPIE_TRAE_INTL_CREDENTIAL` 值非法 | 只使用 `native` 或 `plaintext` |

Windows 上文件被占用/杀毒软件扫描可能导致瞬时失败；重试一次通常恢复。持续失败时不要删除 `managed-models.json`，先备份。

### 5.11 Trae 菜单没有 ` · Magpie` 条目

按顺序检查：

1. `node cli.mjs status`：
   - `connected=true`？
   - `sync.state=synced`？
   - `sync.models > 0`？
2. `node cli.mjs models` 是否有输出？
3. 是否已经完整重启 Trae 一次（首次启用后必须）？
4. 是否在 Magpie Agent 页勾选了模型？列表较长时是否展开了“显示其余”？
5. 是否登录的是同一个 Trae 账号？换账号后旧条目不会出现在新账号。
6. 模型名是否太长导致 ` · Magpie` 后缀被截断？到 Magpie Agent 页确认对应关系。
7. 如果在 Trae 中手动删除过条目，插件可能保留日志并告警 `managed_model_removed_in_trae`；按 5.5 删除 + 断开/重连。
8. 开启热刷新后，检查 `~/.config/magpie-trae-intl/client-refresh-status.json` 是否有 `revision`/`notifiedAt`；没有则按 5.12 处理。

> “菜单是否立即出现”属于 Trae 客户端行为，未做真实账号端到端验收；如果代码侧状态都正常，重启 Trae 仍是最可靠的刷新方式。

### 5.12 热刷新不生效

1. `node cli.mjs doctor` 看 `clientRefresh`：
   - `off`：没有安装/没有开启；
   - `installed`：已安装，检查 Trae 是否重启过；
   - `unsupported`：安装失败或版本不在允许表。
2. 看 `~/.config/magpie-trae-intl/client-refresh-status.json`：
   - 有 `revision` 和 `notifiedAt` 说明 notifier 至少发送过一次；
   - 没有则可能是 `sync-status.json` 没有有效 `revision`（例如 `pending`），或 Trae 窗口未加载完成。
3. notifier 的失败通常被加载语句的 `.catch(() => {})` 静默吞掉，不会出现在 Magpie stderr；用 `client-refresh-status.json` 是否更新来判断。它只影响自动刷新，不影响桥和同步。
4. 确认 `sync-status.json` 的 `state` 是 `synced` 或 `disconnected`，且 `revision` 是 64 位小写十六进制；`pending` 不会触发通知。
5. 兜底：关闭热刷新并执行 `restore-client`，重启 Trae 后手动重新加载窗口。

真实 3.6.20 客户端里的补丁运行行为未验证；这部分只能按“可选增强”使用，不能把它当作桥/同步的前置条件。

---

## 6. 日常操作

### 6.1 增加/移除模型

1. Magpie Agent 页勾选/取消。
2. 等待 5 秒 tick（空闲复核最多 60 秒）。
3. 重新加载 Trae 窗口；开启热刷新时自动通知。
4. `status` 看 `sync.models` 和 `warnings`。

### 6.2 修改端口

1. 设置 `MAGPIE_TRAE_INTL_PORT=<n>`（从启动 Magpie 的环境设置，或写入 Magpie 的 `options.port`）。
2. 重启 Magpie 宿主。
3. 等同步完成；Trae 中模型的 `base_url` 会更新到新端口。
4. 重新加载 Trae 窗口。
5. 用 `status` 确认桥在线；必要时 `serve --port <n>` 检查端口。

如果 Magpie 是从图形界面启动的，`set` 的环境变量不会被继承；这种情况优先用 `magpie plugin options` 写入 `{"port":<n>}`，或在启动 Magpie 的终端/快捷方式里设置。

不要在两个插件副本之间共用一个端口。

### 6.3 与 CN 插件并存

- 本插件：`~/.config/magpie-trae-intl`、`3499`、agent `trae-intl`。
- CN 插件：`~/.config/magpie-trae`、`3498`、CN agent。
- 不要复制配置、日志或备份；不要手工把 CN 的模型条目指向本插件端口。

### 6.4 切换 Trae 账号

见 5.8。账号哈希不匹配时插件在任何写入前失败，这是保护，不是 bug。

---

## 7. 断开与卸载

### 7.1 断开

1. Magpie Agent 页关闭 **Trae (International)**。
2. 保持 Magpie 运行，等待撤回。用 `status` 查看 `sync.models` 变为 0；`sync.state` 通常是 `disconnected`（取决于宿主如何清空 `connection.json`）。最终以 Trae 菜单中本插件条目消失为准。如果从未同步过，可能没有 status 文件。
3. 如果开启过热刷新：

   ```powershell
   node cli.mjs restore-client
   ```

   然后重启 Trae。
4. 在 Trae 模型菜单确认条目已消失。

断开时只处理日志中记录的条目：自建未手改 → 删除；接管未手改 → 还原；手改 → 保留并告警。云端已不存在的条目会从日志移除。

### 7.2 卸载

1. 完成 7.1，确认撤回完成（`sync.models=0`，Trae 菜单中的条目消失）。
2. 执行 `restore-client`（如果开启过热刷新）。
3. 在 Magpie 插件列表移除/停用本插件。
4. 确认不再需要恢复日志后，才删除 `~/.config/magpie-trae-intl`。

**不要先删配置目录**：`managed-models.json` 是撤回 Trae 模型的唯一依据，`client-backups/` 是恢复 `out/main.js` 的唯一备份。

如果已经删除，插件无法自动清理旧模型；在 Trae 的模型管理中手动删除带 ` · Magpie` 的条目。

### 7.3 恢复客户端入口

```powershell
cd <仓库目录>
node cli.mjs restore-client
```

结果：

| `state` | 含义 | 下一步 |
| --- | --- | --- |
| `restored` | 已写回原 `main.js` 并删除 helper | 重启 Trae |
| `unchanged` | 当前已是原文件 | 无需操作 |
| `absent` | 没有备份/版本不在允许表/客户端不存在 | 未修改；检查版本或重装 Trae |

`restore-client` 不需要桥在线；即使插件已经卸载，只要仓库目录还在，仍可运行。

---

## 8. 文件与隐私

| 文件 | 写入者 | 内容 | 分享建议 |
| --- | --- | --- | --- |
| `~/.config/magpie-trae-intl/connection.json` | Magpie 宿主 | `{version,baseURL,gatewayKey,models}` | **不要分享**，含 gatewayKey |
| `~/.config/magpie-trae-intl/managed-models.json` | 插件 | 模型 ID、接管前配置、指纹、pending | **不要分享**，可能含加密 ak |
| `~/.config/magpie-trae-intl/local-credential.json` | 插件 | 用本机 DLL 派生密钥加密的回环标记；不是 Magpie 网关密钥 | **不要分享** |
| `~/.config/magpie-trae-intl/sync-status.json` | 插件 | 状态、数量、警告、修订号 | 可能含模型 ID；去掉后分享 |
| `~/.config/magpie-trae-intl/client-refresh-status.json` | notifier | revision、窗口数、时间 | 可分享 |
| `~/.config/magpie-trae-intl/client-backups/<版本>/` | 插件 | Trae 入口原文和 manifest | 不要分发 |
| `%APPDATA%/Trae/User/globalStorage/storage.json` | Trae | 登录态 | **绝不要分享/复制** |

原则：

- 插件不主动把 JWT、refreshToken、userId、deviceId、gatewayKey、DLL key/salt/AAD 或模型明文 ak/sk 写入日志。
- `managed-models.json` 的 `before` 会保存服务器返回的 `ak` 原值（正常是原生封套，不是 Magpie 网关密钥）；该文件仍按敏感文件处理。
- `local-credential.json` 是加密后的回环标记，不是 Magpie 网关密钥。
- `connection.json` 是 Magpie 宿主写的，插件只读；它含 `gatewayKey`，所以最需要保护。
- 诊断输出不含聊天消息内容；但 `lastRequest.model`、`sync.warnings[].model`、`models` 会含模型 ID/名称。
- `restore-client` 会打印备份路径；分享前去掉。
- 没有遥测；只访问 Trae 账户 API 和本机 Magpie 网关。

---

## 9. 错误码速查

下表按处理阶段整理，只列用户可能遇到、可处理的码；桥/CLI 内部还有一些不会进入同步状态的码（例如连接文件校验、上游超时），它们最终表现为 HTTP 502/503 或 CLI 的通用提示。

### 9.1 路径 / 安装 / 平台

| 码 | 触发 |
| --- | --- |
| `trae_home_unavailable` | 找不到用户主目录 |
| `trae_home_invalid` | home 不是绝对路径 |
| `trae_platform_unsupported` | 非 Windows |
| `trae_installation_unavailable` | 找不到安装、`Trae.exe` 或 `product.json` |
| `trae_product_unreadable` | `product.json` 不可读/不是 JSON |
| `trae_product_not_international` | `providerCode` 非 `i18n` 或 `packageType` 非 `TRAE_I18N` |

### 9.2 会话 / 认证

| 码 | 触发 |
| --- | --- |
| `trae_session_unreadable` | `storage.json` 缺失/不可读/非 JSON |
| `trae_not_signed_in` | 没有登录 blob、token 或 userId |
| `trae_sign_in_expired` | JWT 缺失 `exp`、无法解析，或已过期（含 30 秒余量） |
| `trae_device_unavailable` | 设备键不是恰好一个 |
| `trae_codec_unsupported` | 登录 blob 不是已知编码格式 |
| `trae_session_invalid` | 会话字段不完整，或 auth host 非法 |

### 9.3 凭据 / DLL

| 码 | 触发 |
| --- | --- |
| `trae_credential_version_unsupported` | `appVersion` 不在 `VERIFIED_BUILDS` |
| `trae_credential_build_unsupported` | DLL 整文件 SHA-256 不匹配 |
| `trae_credential_profile_unknown` | DLL 标记不唯一或前缀不完整 |
| `trae_credential_input_invalid` | 编码输入不是字符串或 nonce 非 12 字节 |
| `trae_credential_invalid` | 封套 base64/长度/GCM 校验失败 |
| `trae_credential_cache_unreadable` | `local-credential.json` 读取/解析失败 |
| `trae_credential_self_check_failed` | 新封套自检失败 |
| `trae_credential_unavailable` | `native` 模式无法派生 profile |
| `trae_credential_mode_invalid` | `MAGPIE_TRAE_INTL_CREDENTIAL` 不是 `native`/`plaintext` |

### 9.4 目录 / API

| 码 | 触发 |
| --- | --- |
| `trae_origin_unavailable` | 找不到区域主机 |
| `trae_origin_invalid` | origin override 非法（测试） |
| `unsupported_trae_operation` | 调用了不在白名单的方法 |
| `trae_api_<code\|status>` | 业务码非 0 或 HTTP 非 2xx |
| `trae_response_<status>` | 响应不是 JSON |
| `trae_catalog_unknown` | 目录响应形状不认识 |
| `trae_catalog_<error_code>` | 某个 function 分组返回错误码 |
| `trae_catalog_strategy_unsupported` | 目录策略不支持 |
| `trae_model_invalid` | 模型 id 缺失 |
| `trae_model_id_invalid` | id 不能转成数字（仅 `idType=number`） |

### 9.5 同步 / 恢复日志

| 码 | 触发 |
| --- | --- |
| `sync_file_unreadable` | 状态/连接文件读取或解析失败 |
| `sync_status_unavailable` | health 读不到/损坏 `sync-status.json`，按 `pending` 展示 |
| `sync_file_unwritable` | 写配置目录失败 |
| `sync_lock_invalid` | 锁文件内容非法 |
| `sync_busy` | 锁被活进程持有 |
| `sync_state_version_unknown` | 日志版本不在 `[1,2]` |
| `trae_account_changed` | 日志账号哈希与当前会话不符 |
| `trae_credential_required` | 构造请求时没有 ak |
| `ambiguous_managed_model` | pending add 找到多条 |
| `ambiguous_model_configuration` | 接管时找到多条 |
| `trae_pending_model_missing` | pending update 的 id 不存在 |
| `trae_pending_model_edited` | pending 操作的条目被手改 |
| `trae_model_create_unverified` | 创建后回读失败 |
| `trae_model_update_unverified` | 更新后回读失败 |
| `trae_model_delete_unverified` | 删除后回读失败 |
| `trae_model_restore_unverified` | 还原后回读失败 |
| `trae_sync_failed` | 非白名单异常兜底 |

警告（写入 `warnings[]`，不算失败）：

| 警告码 | 含义 |
| --- | --- |
| `model_edited_in_trae` | 条目被手改，插件跳过 |
| `managed_model_removed_in_trae` | 日志中的条目在 Trae 中已不存在 |

### 9.6 桥 / 客户端补丁 / 其他

| 码 | 触发 |
| --- | --- |
| `trae_bridge_port_invalid` | 端口不是 1..65535 的整数 |
| `local_auth_invalid` | 桥收到错误的回环标记（HTTP 401，出现在 health 的 `lastRejection`） |
| `trae_client_not_installed` | 找不到 Trae 安装或 `out/main.js` |
| `trae_client_refresh_build_unsupported` | `out/main.js` 哈希/版本不在允许表 |
| `trae_client_refresh_backup_invalid` | 备份文件哈希不匹配 |
| `trae_client_refresh_write_failed` | 写客户端文件失败 |
| `trae_client_refresh_install_failed` | 补丁安装的兜底错误码 |
| `trae_notifier_unavailable` | notifier 拿不到 Electron/窗口 API（通常被加载器静默吞掉，只影响自动刷新） |
| `trae_gateway_required` | Magpie 没提供 gateway.v1 或 gateway.key |

---

## 10. 收集问题信息

报告问题时只提供以下内容，**不要**附配置文件：

1. Windows 版本、Trae 版本（`doctor.product.appVersion`）、Magpie 版本。
2. `node cli.mjs doctor` 的 JSON（已脱敏）。
3. `node cli.mjs status` 的 JSON；如果担心模型 ID，可只保留 `connected`、`sync.state`、`sync.code`、`sync.models`、`rejected`/`lastRejection.code`。
4. 出错前你做了什么：首次启用、升级 Trae、换账号、改端口、开/关热刷新、手动改模型等。
5. 错误码的完整文本，以及能否稳定复现。
6. 是否开启过热刷新，`doctor.clientRefresh` 的值。

不要提供：

- `connection.json`、`managed-models.json`、`local-credential.json`
- `%APPDATA%/Trae/User/globalStorage/storage.json`
- 任何 JWT、refreshToken、gatewayKey、模型 ak/sk、设备 ID、用户 ID、邮箱
- 聊天消息内容

如果必须提供日志，先删除其中的 token、key、账号、设备 ID、绝对用户路径和消息内容，只保留错误码、时间、状态码和布尔值。
