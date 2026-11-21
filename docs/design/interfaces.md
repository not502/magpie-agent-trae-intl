# magpie-agent-trae-intl — 接口契约

> 本文件是骨架与实现之间**唯一**的签名来源。实现者可以替换函数体，但不得改动导出名、参数位置、返回形状与错误码；确需改动时先改本文件并在 PR 中说明。
>
> 配套：[`architecture.md`](architecture.md)（数据流、状态机、失败模式、验证边界）。
>
> 通用约定：
> - 全部 ESM；不引入 npm 运行时依赖；Node ≥ 20（Bun 宿主兼容）。
> - 机器错误统一为 `Error`，且 `err.message === err.code`（同一个字符串），匹配 `^[a-z][a-z0-9_]*$`。人读文案只允许出现在 CLI 输出，不进错误 `message`。
> - 异步函数只承诺 `Promise`；不使用回调风格。
> - 任何函数都不得打印、序列化或返回 `token`、`userId`、`deviceId`、`gatewayKey`、`key`、`aad`、明文 AK/SK。
> - 类型用 JSDoc 表达；`Buffer` 仅在本机模块（不进入 moejs）使用。

---

## 1. `src/constants.mjs`（冻结）

纯数据，零 import、零逻辑（只有构造只读表的 `Object.freeze` / `Object.fromEntries` / `join`）。

| 导出 | 类型 | 值 / 含义 |
| --- | --- | --- |
| `PRODUCT` | `{name, version}` | `magpie-agent-trae-intl` / `0.1.0`；测试断言等于 `package.json` |
| `AGENT_ID` / `AGENT_NAME` | string | `trae-intl` / `Trae (International)` |
| `CONFIG_DIR_NAME` | string | `magpie-trae-intl` |
| `DEFAULT_PORT` | number | `3499` |
| `BRIDGE_NAME` / `BRIDGE_HOST` | string | `magpie-trae-intl` / `127.0.0.1` |
| `LOCAL_TOKEN` | string | `magpie-trae-intl-local-bridge-v1`（公开回环标记） |
| `CONNECTION_VERSION` / `STATE_VERSION` / `CREDENTIAL_FORMAT` | number | `2` / `2` / `2` |
| `API_PREFIX` | string | `/api/ide/v1` |
| `API_METHODS` | object | `list/batchDetail/providers/add/update/connectivity` 的方法名 |
| `CALLABLE_METHODS` | string[] | `batch_get_detail_param`、`add_custom_model`、`update_custom_model` |
| `BATCH_DEFAULTS` | object | batch 请求默认体（见 §5.2） |
| `TRAE_HOSTS` | object | `agent` / `account` 的区域主机表 |
| `DEFAULT_REGION` | string | `US`（国际版缺省） |
| `APP_ID` | string | 客户端公开 app id |
| `IDE_VERSION_CODE_FALLBACK` | string | `20260212`（观测值，来源未解释） |
| `DEVICE_TYPE` | string | `windows` |
| `AUTH_SCHEME` | string | 认证 scheme token（与线上观测的 `headers.authorization_scheme` 取值一致） |
| `HEADERS` | object | 本插件发送的头名（`auth`、`cloudIdeToken`、`ideToken` 等；见 §3.3） |
| `PROVIDER` | string | `custom_openai_compatible` |
| `AUTH_TYPE` | object | `{apiKey:0, accessKey:1}` |
| `CONFIG_SOURCE` | object | `{trae:1, enterprise:2, personal:3}` |
| `CUSTOM_MODEL_TYPE` | object | `{chat:'chat_model', reasoning:'reasoning_model', other:'other'}` |
| `BASE_URL_SUFFIX` | object | 按 provider 的路径后缀 |
| `REASONING_PARAMETER` | string | `reasoning_effort` |
| `MODEL_DEFAULTS` | object | `maxTurn:500`、`thinkingEnable:1`、`multimodal:true`、`displayNameMaxLength:64`、`displayNameSuffix:' · Magpie'` |
| `HOT_REFRESH` | object | 两个通道名 + `windowUrlPrefix` |
| `CLIENT_LAYOUT` | object | 安装内相对路径（exe、product.json、main.js、DLL 目录等） |
| `VERIFIED_BUILDS` | object | 版本 → `{harness, aiAgent, mainJs, mainJsSize}` 的 SHA-256 允许表 |
| `MAIN_SHA256_TABLE` | object | 版本 → `main.js` 哈希（`client-refresh` 的 `MAIN_SHA256` 来源） |
| `DLL_MARKERS` | object | 两个字节标记 + 前缀长度 84 / 94 |
| `CRYPTO` | object | `nonceBytes:12`、`tagBytes:16`、`aadBytes:10`、`keyBytes:32`、`saltBytes:10`、`keyXorBytes:8`、`cacheVersion:1` 等 |
| `LIMITS` | object | 体积/超时/重试/回读参数（见 §8、§7） |
| `STATUS_STATES` | string[] | `synced`、`disconnected`、`pending` |
| `ENV` | object | 四个环境变量名 |

约束：新增键不得复用既有键的含义；构建哈希只能来自实测，不得推测。

---

## 2. `src/paths.mjs`

```js
export function resolvePaths(env = process.env): PluginPaths
export function resolveAppDir(env = process.env, options = {}): AppLocation
export function readProduct(appDir): Product
export function ensureConfigDir(paths = resolvePaths()): string
```

### 2.1 `PluginPaths`

| 字段 | 值 |
| --- | --- |
| `home` | `env.USERPROFILE` → `env.HOME` → `os.homedir()` |
| `configDir` | 固定 `<home>/.config/magpie-trae-intl`（由 Magpie 宿主按 agent 描述符写入，不可用环境变量改到别处） |
| `connection` | `<configDir>/connection.json` |
| `state` | `<configDir>/managed-models.json` |
| `credential` | `<configDir>/local-credential.json` |
| `lock` | `<configDir>/model-sync.lock` |
| `status` | `<configDir>/sync-status.json` |
| `clientRefreshStatus` | `<configDir>/client-refresh-status.json` |
| `clientBackups` | `<configDir>/client-backups` |
| `notifier` | `<packageRoot>/src/refresh-notifier.cjs` |
| `restore` | `<packageRoot>/restore.mjs` |

- `packageRoot` 只能由 `import.meta.url` 推导，不得硬编码。
- 抛：`trae_home_unavailable`（三处 home 都没有）、`trae_home_invalid`（home 不是绝对路径）。

### 2.2 `AppLocation`

| 字段 | 含义 |
| --- | --- |
| `appDir` | `<install>/resources/app` |
| `installDir` | `<install>` |
| `exe` | `<install>/Trae.exe` |
| `productFile` | `<install>/resources/app/product.json` |
| `source` | `env` / `registry` / `fallback` |
| `rejected` | 被校验拒绝的候选目录（仅内存，不打印） |

`options`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `platform` | `process.platform` | 非 `win32` 直接抛 `trae_platform_unsupported` |
| `registry` | 内部实现 | `() => string[]`，返回卸载注册表里的 `InstallLocation`；测试注入 |

候选顺序：`MAGPIE_TRAE_INTL_APP`（可指向 install 或 `resources/app`）→ `registry()` → `%LOCALAPPDATA%/Programs/Trae` → `%ProgramFiles%/Trae` → `%ProgramFiles(x86)%/Trae`。

校验（全部通过才接受）：`Trae.exe` 是文件；`product.json` 可解析；`providerCode === 'i18n'`。`packageType` 缺失时接受，存在但不等于 `TRAE_I18N` 时拒绝（记为 rejected）。
抛：`trae_installation_unavailable`、`trae_platform_unsupported`。

### 2.3 `Product`

| 字段 | 来源 | 备注 |
| --- | --- | --- |
| `appVersion` | `product.json.appVersion` | 对外版本；**不是** `version`（VS Code 基线） |
| `vscodeVersion` | `version` / `vscodeVersion` | 诊断用 |
| `providerCode` | 同名字段 | 必须 `i18n` |
| `packageType` | 同名字段 | 期望 `TRAE_I18N` |
| `quality` | 同名字段 | |
| `dataFolderName` | 同名字段 | 期望 `.trae` |
| `traeVersionCode` | 同名字段 | |
| `ideVersionCode` | `ideVersionCode ?? IDE_VERSION_CODE_FALLBACK` | 请求头值；来源未解释 |
| `agentAppId` | `agentAppId ?? APP_ID` | |
| `hosts` | `bootConfig.agent` / `bootConfig.account`，缺失回退 `TRAE_HOSTS` | 仅保留四个区域键 |
| `appDir` / `productFile` | 入参 | |

抛：`trae_product_unreadable`、`trae_product_not_international`。
实现约束：不把整个 `product.json` 挂到返回值上，不打印其内容。

### 2.4 `ensureConfigDir`

递归创建 `paths.configDir`，mode `0700`，幂等；返回目录字符串。失败抛 `sync_file_unreadable`。

---

## 3. `src/session.mjs`

```js
export function readSession(options = {}): TraeSession
export function buildHeaders(session, product): Record<string, string>
```

### 3.1 `readSession({ storageFile?, product?, codec? })`

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `storageFile` | `<APPDATA>/Trae/User/globalStorage/storage.json` | 测试注入 |
| `product` | `readProduct(resolveAppDir().appDir)` | 仅取 `appVersion` |
| `codec` | `{ decode: clientDecode }` | 测试可换成恒等解码 |

算法：

1. 读文件；ENOENT/JSON 错误 → `trae_session_unreadable`。
2. `storage['iCubeAuthInfo://icube.cloudide']` 必须是 string，否则 `trae_not_signed_in`。
3. 值 `trim().startsWith('{')` → 直接解析；否则 `codec.decode(value)` 后解析。codec 抛错 → `trae_codec_unsupported`。
4. `token`、`userId` 缺失 → `trae_not_signed_in`。
5. JWT 第二段 base64url 解 JSON；`exp` 缺失或 `exp*1000 <= now + LIMITS.connectionExpirySkewMs` → `trae_sign_in_expired`。
6. 设备键：`Object.keys(storage)` 中匹配 `^iCubeAuthInfo://icube-dc:\d+$` 的项必须恰好 1 个，否则 `trae_device_unavailable`。
7. `account = sha256(String(userId))`（小写 hex）。

### 3.2 `TraeSession`

| 字段 | 类型 | 保密 | 说明 |
| --- | --- | --- | --- |
| `account` | 64 hex | 可持久化 | 日志/账号绑定只用它 |
| `token` | string | **机密** | JWT；只进内存 |
| `userId` | string | **机密** | 不发送 `x-uid`，本字段只用于 `account` 与诊断布尔值 |
| `deviceId` | string | **机密** | 设备键末段 |
| `region` | `CN|SG|US|USTTP|UNKNOWN` | 公开 | `userRegion.region` → `account.storeRegion` → `DEFAULT_REGION` |
| `aiRegion` | string | 公开 | `userRegion._aiRegion` → `account.storeRegion` → `region` |
| `authHost` | string | 公开 | 解码后的 `host`；**不用于**模型 API |
| `expiresAt` | ISO string | 公开 | 由 `exp` 推出 |
| `storageFile` | string | 本机路径 | 仅诊断 |
| `productVersion` | string | 公开 | `product.appVersion` |

`userId` 可以在 `buildHeaders` 中使用，但本设计不发送 `x-uid`；保留字段是为了账号哈希与未来兼容。

### 3.3 `buildHeaders(session, product)`

返回**全新**的小写头对象；不修改入参；不缓存。

| 头 | 值 |
| --- | --- |
| `authorization` | `` `${AUTH_SCHEME} ${session.token}` `` |
| `x-ide-token` | `session.token` |
| `x-app-id` | `product.agentAppId ?? APP_ID` |
| `x-device-id` | `session.deviceId` |
| `x-device-type` | `DEVICE_TYPE` |
| `x-app-version` | `product.appVersion ?? session.productVersion` |
| `x-ide-version` | 同上 |
| `x-ide-version-code` | `product.ideVersionCode ?? IDE_VERSION_CODE_FALLBACK` |
| `x-user-region` | `session.region` |
| `x-trae-client-type` | `ide` |
| `content-type` | `application/json` |
| `user-agent` | `magpie-agent-trae-intl/0.1.0` |

**不发送**：`x-uid`、`x-cloudide-token`、`cookie`、任何转发头、`x-forwarded-for`、`x-machine-id`。
理由：最小化凭据面；`x-uid`/`x-machine-id` 在真实模型 API 上是否必需未验证（见 `architecture.md` §13.2）。若联调出现 401/403，先加 `x-uid` 并记录证据，再考虑设备头。

抛：`trae_session_invalid`（`token`/`deviceId` 缺失或非字符串）。

---

## 4. `src/credential.mjs`

```js
export function readNativeCredentialProfile(options = {}): CredentialProfile
export function encodeCredential(value, profile, nonce): string
export function decodeCredential(value, profile): string
export function localCredential(file, options = {}): string
export function credentialMode(): 'native'|'plaintext'
```

### 4.1 `readNativeCredentialProfile({ appDir?, local?, builds? })`

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `appDir` | `resolveAppDir().appDir` | |
| `local` | `process.env.LOCALAPPDATA` | 仅测试注入 |
| `builds` | `VERIFIED_BUILDS` | 仅测试注入；生产不得放宽 |

算法：

1. `version = readProduct(appDir).appVersion`；不在允许表 → `trae_credential_version_unsupported`。
2. 目标：`<appDir>/modules/ai-agent/harness.dll`、`ai_agent.dll`；缺失 → `trae_installation_unavailable`。
3. 内存缓存键 `identity = version | path:size:mtimeMs | path:size:mtimeMs`；命中直接返回。
4. `inspect(file, marker, prefixBytes)`：1 MiB 分块流式 SHA-256，跨块窗口找标记；只接受“标记跨块边界且前缀完整”的候选；候选必须恰好 1 个，否则 `trae_credential_profile_unknown`。
5. 两个整文件 digest 必须分别等于 `builds[version].harness` / `.aiAgent`，否则 `trae_credential_build_unsupported`。
6. 形状：`h` 匹配 `^[0-9a-f]{84}$`；`a` 匹配 `^[0-9a-f]{64}[0-9]{10}[0-9a-f]{20}$`；`a[0:64]===h[0:64]`；`a[74:94]===h[64:84]`。
7. 派生：`key=hex(h[0:64])`、`salt=hex(h[64:84])`、`key[i]^=salt[i] (i<8)`、`salt.fill(0)`、`aad=Buffer.from(a[64:74],'ascii')`。
8. 返回 `Object.freeze({ id:`trae-intl-${version}:${harnessSha256}`, identity, version, key, aad, harnessSha256, aiAgentSha256 })`。

**禁止**：固定偏移、把 key/salt/aad 写入任何文件、在错误消息里带出 hex。

### 4.2 封套

```
encode(value, profile, nonce = randomBytes(12)):
  base64( nonce[12] || AES-256-GCM(key, nonce, AAD=profile.aad, plaintext=value) || tag[16] )
```

- `value` 必须是 string；`nonce` 必须 12 字节；否则 `trae_credential_input_invalid`。
- 每次调用默认随机 nonce，同一明文输出不同。
- 空串 → 28 字节 → 40 个 base64 字符。

`decode`：

- 严格标准 base64（允许尾部 `=`），且 `bytes.toString('base64') === value`（拒绝非规范编码）。
- 长度 ≥ 28；nonce=前 12、tag=后 16。
- 任何解密/校验失败 → `trae_credential_invalid`；消息不含输入。

### 4.3 `localCredential(file, { profile?, mode? })`

| 模式 | 行为 | 返回 | `credentialFormat` |
| --- | --- | --- | --- |
| `native`（默认） | 读缓存；`version===1 && mode==='native' && profile===profile.id && decode(ak)===LOCAL_TOKEN` 则复用；否则重新编码并自检 | 封套字符串 | `2` |
| `plaintext` | 不写缓存，直接返回 `LOCAL_TOKEN` | 标记原文 | `0` |

- 写缓存：目录 `0700`、tmp `wx` + `0600` + rename；JSON 形如 `{version:1, mode, profile, ak}`。
- 非 ENOENT 的读取/解析错误 → `trae_credential_cache_unreadable`；自检失败 → `trae_credential_self_check_failed`。
- `native` 但 `profile` 不可用 → `trae_credential_unavailable`（不自动降级到 plaintext）。

### 4.4 `credentialMode()`

- 读 `MAGPIE_TRAE_INTL_CREDENTIAL`；未设置或 `native` → `'native'`；`plaintext` → `'plaintext'`；其他 → `trae_credential_mode_invalid`。
- 无副作用；不读文件。

---

## 5. `src/api.mjs`

```js
export class TraeAPI {
  constructor(session, options = {})
  async list(options = {}): Promise<CatalogEntry[]>
  async add(request): Promise<{code:number, message?:string}>
  async update(body): Promise<{code:number, message?:string}>
  async remove(entry): Promise<{code:number, message?:string}>
  async call(method, body): Promise<Record<string, unknown>>
}
export function resolveOrigin(options = {}): string
```

### 5.1 构造选项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `request` | `fetch` | `(url, init) => Promise<Response>`；测试注入 |
| `origin` | `resolveOrigin({session, product})` | `https://<host>`，无尾斜杠 |
| `product` | `undefined` | 供 `buildHeaders` 用；缺省时用 `session.productVersion` + fallback |
| `catalog` | `'batch'` | `'batch'|'model_list'|'auto'` |
| `envelope` | `false` | 目录调用是否带 `Request: {}`；国际版 3.6.20 实测带 `Request` 返回 400，`true` 仅保留给探针 |
| `functions` | `BATCH_DEFAULTS.functions` | batch 的 function 列表 |
| `timeoutMs` | `LIMITS.apiTimeoutMs` | |
| `encodeEmptySecret` | `undefined` | `() => string`；`undefined` 表示不编码空 SK |
| `idType` | `'number'` | `'string'|'number'`；国际版实测 update 拒绝字符串 id（400），默认发数字 |

### 5.2 `list({ strategy? })`

**batch 请求体**（字段名与值固定，取自 `src/constants.mjs` 的 `BATCH_DEFAULTS`；默认**不带** `Request` 封套，仅 `envelope:true` 时附加 `"Request": {}`）：

```json
{
  "functions": ["chat_v3", "solo_work_lite", "solo_agent", "solo_agent_lite", "solo_coder"],
  "access_type": 0,
  "ab_force_vids": "",
  "ab_autotest_advanced_mode": 0,
  "agent_type": "",
  "current_config_info": { "config_name": "", "is_custom_model": false },
  "mode_type": 0,
  "show_custom_model": true
}
```

> 国际版 3.6.20 实测（2026-11-21）：`functions:['chat','builder']` 等生成客户端变体与带 `Request` 封套的请求返回 400；上表形状返回 200（见 `src/constants.mjs` 的 `BATCH_DEFAULTS` 注释）。

**解析规则**（必须同时容忍两种层级）：

1. `payload.data ?? payload`。
2. `function_configs` 必须是对象或数组；否则 `trae_catalog_unknown`。
3. 对象：键是 function 名；数组：元素是分组，function 名取 `group.function ?? group.name ?? index`。
4. 每组 `error_code` 非空 → `trae_catalog_<error_code>`。
5. 遍历 `group.config_info_list[]` → `info.model_detail_list[]`。
6. `custom_config`：string → `JSON.parse`（失败按 `{}` 处理并保留原值到 `raw`）；object → 原样；`null` → `{}`。
7. `id = String(cc.custom_model_id ?? detail.custom_model_id ?? '')`；空则跳过。
8. `model = detail.model_name ?? detail.name`；`provider = detail.provider ?? PROVIDER`。
9. `name = info.display_config?.display_name ?? info.config_name ?? model`。
10. `ak = cc.ak`、`sk = cc.sk ?? ''`、`baseURL = cc.base_url`、`status = cc.status !== false`。
11. `detail = { multimodal: !!(info.display_config?.multimodal ?? detail.multimodal), model_hyper_params: { max_tokens: detail.max_tokens, prompt_max_tokens: detail.prompt_max_tokens, thinking_enable: cc.thinking_enable, reasoning_param: cc.reasoning_param }, max_turn: detail.max_turn ?? 500 }`。
12. 同名 id 去重：先出现者为准，后来者只补空字段。

**model_list 请求**：`GET ${origin}${API_PREFIX}/model_list?type=`，body `{"Request":{}}`。默认 `fetch` 无法发送 GET body → 抛 `trae_catalog_strategy_unsupported`。实现者需在 `api.mjs` 内提供基于 `node:http` 的 `httpGetJson`（不含 Node API 的模块不得引用它）。

**model_list 解析**：`data.model_list[]`；`id=String(custom_model_id)`、`model=model_name ?? name`、`provider`、`name=display_name ?? name`、`ak/sk/base_url/status/auth_type/config_source/custom_model_type/client_connect` 取顶层；`custom_config` 字符串解析；`detail` 由 `multimodal/max_tokens/prompt_max_tokens/thinking_enable/reasoning_param/max_turn` 组装。

**auto**：先 batch；仅当错误码为 `trae_catalog_unknown` 时回退 model_list。认证/网络错误不得回退。

### 5.3 `CatalogEntry`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 服务器 `custom_model_id` |
| `model` | string | `model_name` / `name` |
| `provider` | string | |
| `name` | string | 显示名 |
| `ak` | string? | 服务器返回的封套 |
| `sk` | string? | 通常 `""` |
| `baseURL` | string? | |
| `status` | boolean | |
| `authType` | number? | |
| `configSource` | number? | |
| `customModelType` | string? | |
| `clientConnect` | boolean? | `true` 表示原生客户端本地直连 `base_url` |
| `config` | object | 解析后的 `custom_config`，永不是原始字符串 |
| `detail` | object | `{multimodal, model_hyper_params, max_turn}` |
| `raw` | object? | 仅供还原的服务器原始子集（实现可选，但不得含额外凭据） |

### 5.4 CRUD

`add(request)` → `POST ${API_PREFIX}/add_custom_model`，body 就是 `ModelRequest`（§7.1）的 11 个字段。返回 `{code, message}`；**不推断 id**（add 响应不含 id）。

`update(body)` → `POST ${API_PREFIX}/update_custom_model`。body 字段顺序无关，但必须包含：

```json
{
  "action": "update",
  "id": 123456789,
  "provider": "custom_openai_compatible",
  "model_name": "...",
  "status": true,
  "auth_type": 0,
  "sk": "",
  "region": "",
  "base_url": "http://127.0.0.1:3499/v1/chat/completions",
  "custom_model_type": "",
  "config_detail": { "multimodal": true, "model_hyper_params": {}, "max_turn": 500 },
  "display_name": "..."
}
```

- `ak` 只在调用方提供且与服务器当前值不同时出现（原生编辑器的行为）。
- `id` 默认发**数字**（`idType:'number'`，2026-11-21 实测字符串 id 被 update 400 拒绝）；`idType:'string'` 仅作探针，此时 `id = String(id)`。数字模式下非安全非负整数 → `trae_model_id_invalid`。

`remove(entry)` → 同一接口，body **恰好** `{"action":"delete","id":<number>}`（随 `idType`，默认数字，见上）；不带 `sk`，因此不触发空 SK 编码。

### 5.5 `call(method, body)`

| 步骤 | 规则 | 失败码 |
| --- | --- | --- |
| 方法白名单 | `CALLABLE_METHODS` | `unsupported_trae_operation` |
| 空 SK 编码 | 仅 add/update 且 `body.sk === ''` 且注入了 `encodeEmptySecret`；用 `{...body}` 不改调用方对象 | 编码器抛错则原样上抛 |
| 请求 | `POST`，`redirect:'error'`，`AbortSignal.timeout(timeoutMs)` | — |
| 解析 | 非 JSON | `trae_response_<status>` |
| 业务码 | `!response.ok` 或 `result.code !== 0` | `trae_api_<code ?? status>` |
| 返回 | 原始解析对象 | — |

**禁止**：把 URL query、请求体、响应体、头写入错误消息或日志。

### 5.6 `resolveOrigin({ session, product, override })`

- `override`：URL 解析；必须 `https:`；仅当 host 是 `127.0.0.1`/`localhost`/`[::1]` 时允许 `http:`（测试）。返回去掉尾斜杠的 origin。
- 否则 `region = session?.region ?? DEFAULT_REGION`；`table = product?.hosts?.agent ?? TRAE_HOSTS.agent`；`host = table[region] ?? table.normal`；返回 `https://${host}`。
- 不使用 `session.authHost`。
- 抛：`trae_origin_unavailable`（无合法 host）、`trae_origin_invalid`（override 非法）。

---

## 6. `src/state.mjs`

```js
export function syncPaths(home): SyncPaths
export function readJson(file, fallback): unknown
export function writeJsonAtomic(file, value): void
export async function withLock(file, fn): Promise<any>
```

### 6.1 `syncPaths(home = os.homedir())`

返回 `{control, state, credential, lock, status}`，**必须**委托 `resolvePaths({HOME: home})`，不得重复拼 `CONFIG_DIR_NAME`。

### 6.2 `readJson(file, fallback)`

- ENOENT → 返回 `fallback`（原样，不复制）。
- 其他读取/解析错误、路径是目录 → 抛 `sync_file_unreadable`。
- 不打印文件内容。

### 6.3 `writeJsonAtomic(file, value)`

1. 递归创建父目录 `0700`。
2. 写 `<file>.<uuid>.tmp`，`flag:'wx'`、`mode:0600`，内容 `JSON.stringify(value, null, 2)`。
3. `rename` 覆盖目标。
4. `finally` 删除临时文件。
5. 失败 → `sync_file_unwritable`。

### 6.4 `withLock(file, fn)`

- payload `{pid: process.pid, key: randomUUID()}`；`wx` 创建，`0600`。
- EEXIST：读 payload；`pid` 非正整数 → `sync_lock_invalid`；`process.kill(pid,0)` 成功 → `sync_busy`；`ESRCH` → 删除陈旧锁并重试一次；其他错误原样上抛。
- `finally` 释放：只有当读回的 `key` 相同才删除；释放失败忽略（不掩盖 `fn` 的结果）。
- `fn` 可以返回 Promise；函数返回其 `await` 结果。

---

## 7. `src/sync.mjs`

```js
export function modelRequest(model, endpoint, ak): ModelRequest
export async function syncModels(options = {}): Promise<SyncResult>
export function startModelSync(options = {}): {ready: Promise<void>, stop: () => Promise<void>}
```

### 7.1 `modelRequest(model, endpoint, ak)`

```ts
{
  ak: string,                    // 非空，否则 trae_credential_required
  provider: 'custom_openai_compatible',
  model_name: string,            // model.id，非空，否则 trae_model_invalid
  is_custom: true,
  auth_type: 0,
  region: '',                    // 模型提供方区域，不是用户区域
  sk: '',                        // 线上由 call() 编码
  base_url: endpoint,
  custom_model_type: '',         // UI 的 other
  config_detail: {
    multimodal: boolean,
    model_hyper_params: {
      thinking_enable: 0|1,
      prompt_max_tokens?: number,     // 仅 context > 0
      max_tokens?: number,            // 仅 output > 0
      reasoning_param?: { parameter: 'reasoning_effort', values: ['default', ...levels] }
    },
    max_turn: 500
  },
  display_name: string           // `"<name||id> · Magpie"`.slice(0, 64)
}
```

`levels = [...new Set(model.efforts ?? [])].filter(v => typeof v === 'string' && v !== 'default')`；非空时 `thinking_enable=1` 且带 `reasoning_param`，否则 `0` 且不带。
`endpoint` 由调用方给出，固定 `http://127.0.0.1:<port>/v1/chat/completions`。

### 7.2 `syncModels(options)`

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `paths` | `syncPaths()` | |
| `apiFactory` | `async () => new TraeAPI(readSession(), { product: readProduct(resolveAppDir().appDir) })` | 可注入假 API |
| `credentialFactory` | `localCredential` | `(file) => string|Promise<string>` |
| `port` | `DEFAULT_PORT` | |
| `endpoint` | 由 port 推导 | 测试可覆盖 |
| `sleep` | `setTimeout(...,200)` | 回读间隔 |
| `now` | `() => new Date().toISOString()` | |
| `catalog` | `'batch'` | 传给 API |

流程（顺序不可交换）：

1. `withLock(paths.lock)`。
2. `control = readJson(paths.connection, null)`；`connected = control?.version===2 && typeof control.gatewayKey==='string' && !!control.gatewayKey && Array.isArray(control.models)`。
3. `state = readJson(paths.state, null)`；`!connected && !state` → 返回 `{state:'disconnected', models:0, warnings:[], revision:'', updatedAt:now()}`，**不写 status**。
4. `api = await apiFactory()`；`state?.account !== api.session.account` → `trae_account_changed`（零写入）。
5. `remote = await api.list({strategy: options.catalog})`。
6. 初始化/升级日志：`{version:2, account, entries:{}, pending:null}`；版本不在 `[1,2]` → `sync_state_version_unknown`。
7. `endpoint = options.endpoint ?? http://127.0.0.1:<port>/v1/chat/completions`。
8. `ak = connected ? await credentialFactory(paths.credential) : undefined`；`desired = connected ? control.models.map(m => modelRequest(m, endpoint, ak)) : []`；`format = credentialMode() === 'native' ? 2 : 0`。
9. 恢复 pending（§7.3）。
10. 期望循环（§7.4）。
11. 释放循环（§7.5）。
12. `revision = sha256(JSON.stringify(remote.map(e => [e.id, fingerprint(e)]).sort()))`（小写 hex）。
13. 写 status：`{state: connected?'synced':'disconnected', models: desired.length, warnings, revision, updatedAt, origin}`。
14. 返回同一对象。

### 7.3 pending 恢复

| pending | 步骤 |
| --- | --- |
| `add` | `found = remote.filter(matching(e, pending.request) && e.name === pending.request.display_name)`；>1 → `ambiguous_managed_model`；1 → `entries[model]={id, created:true, last:fingerprint, credentialFormat}`；0 → 什么都不做；最后清 pending 并保存 |
| `update` | `entry = remote.find(id === String(body.id))`；缺失 → `trae_pending_model_missing`；`applied = desiredMatches(entry, target, body.status)`，`target.ak = body.ak ?? before.ak`；未生效且指纹 ≠ `before` 指纹 → `trae_pending_model_edited`；`!applied || credentialFormat === 2` → 重放 `update` 并回读；回读不满足 → `trae_model_update_unverified`；更新 `last`/`credentialFormat`；`release` 为真则删条目；清 pending |
| `delete` | 条目仍在：指纹 ≠ `before` → `trae_pending_model_edited`；否则重删并回读，仍在 → `trae_model_delete_unverified`；不在 → 删除条目；清 pending |

### 7.4 期望循环

对每个 `request`：

1. `managed = state.entries[request.model_name]`；`entry = managed && remote.find(id === managed.id)`。
2. 无日志：
   - `same = remote.filter(matching(e, request))`；>1 → `ambiguous_model_configuration`。
   - =1 → 接管：`{id, created:false, before: entry, last: fingerprint(entry)}` 先保存，再继续。
   - =0 → 创建：写 `pending={kind:'add', model, request, credentialFormat:format}` → `add` → 回读（`matching && name===display_name`）→ 找不到 → `trae_model_create_unverified` → 落账 `{created:true,...}`。
3. 有日志但云端不存在 → 警告 `managed_model_removed_in_trae`，`continue`（保留日志）。
4. `managed.last && managed.last !== fingerprint(entry)` → 警告 `model_edited_in_trae`，`continue`。
5. `!desiredMatches(entry, request) || managed.credentialFormat !== format` → 写 pending update → `update` → 回读 → 不满足 → `trae_model_update_unverified` → 更新 `last`/`credentialFormat` → 清 pending。

`desiredMatches(entry, request, status = true)`：`matching && entry.ak === request.ak && entry.name === request.display_name && entry.status === status && deepEqual(entry.detail, request.config_detail)`（JSON 归一化后比较）。

### 7.5 释放循环

对每个 `[model, managed]` 且 `model` 不在 desired 集合：

1. 云端按 id 找不到 → 删日志项并保存。
2. 指纹 ≠ `last` → 警告 `model_edited_in_trae`，跳过。
3. `managed.created` → pending delete → `remove` → 回读 → 仍在 → `trae_model_delete_unverified` → 删日志项。
4. 否则还原：`originalRequest(before)`（`ak/provider/model_name/base_url/auth_type/sk/region/custom_model_type/config_detail/display_name`，`status = before.status`）；已一致则跳过写；否则 pending update（`release:true`）→ `update` → 回读 → 不满足 → `trae_model_restore_unverified`。

### 7.6 `startModelSync(options)`

- `ready`：首个 tick 的 Promise（成功/失败都 resolve，失败已写 status）。
- tick 条件：未停止、无在飞任务；读 `connection.json` 文本；文本与上次成功读取相同且距上次检查 < `LIMITS.syncIdleSkipMs` → 跳过。
- 成功：记录 `previous=content`，清空错误去重。
- 失败：`sync_busy` 静默；其他码白名单化（`^[a-z][a-z0-9_]*$`，否则 `trae_sync_failed`），去重打印到 stderr，写 `{state:'pending', code, updatedAt}`（覆盖旧 status，故意丢弃 revision）。
- 定时器 `LIMITS.syncIntervalMs`，`unref()`。
- `stop()`：置位、清定时器、`await` 在飞任务。

---

## 8. `src/bridge.mjs`

```js
export const DEFAULT_PORT   // 3499
export const LOCAL_TOKEN    // 公开标记
export function connectionPath(home): string
export function createBridge(options = {}): Bridge
export function startHost(options = {}): {ready, stop}
```

### 8.1 `createBridge`

| 选项 | 默认 |
| --- | --- |
| `file` | `resolvePaths().connection` |
| `port` | `DEFAULT_PORT` |
| `maxBodyBytes` | `LIMITS.maxBodyBytes`（32 MiB） |
| `upstreamTimeoutMs` | `LIMITS.upstreamIdleTimeoutMs`（600 s，空闲） |
| `onRequest` | `() => {}` |
| `exposeModels` | `false` |

`Bridge`：`{server, listen(), close()}`；`listen()` resolve `AddressInfo`；`close()` 先销毁在飞上游请求，再 `server.close` + `closeAllConnections()`。

### 8.2 准入与响应

| 顺序 | 条件 | 响应 |
| --- | --- | --- |
| 1 | 有 `Origin` 头 | 403 |
| 2 | `socket.remoteAddress` ∉ `{127.0.0.1, ::1, ::ffff:127.0.0.1}` | 403 |
| 3 | `Host` ∉ `^(127\.0\.0\.1|localhost|\[::1\]):\d+$` | 403 |
| 4 | `GET /health` | 200（脱敏） |
| 5 | 鉴权头 ≠ `Bearer ${LOCAL_TOKEN}` | 401 `local_auth_invalid` |
| 6 | 路由 ∉ `{/v1/models, /v1/chat/completions}` | 404 |
| 7 | 方法不匹配 | 405 |
| 8 | `connection.json` 不合契约 | 503 |
| 9 | body/模型/体积 | 400 / 404 / 413 |

错误体固定：`{"error":{"type":"magpie_trae_error","message":"<通用文案>"}}`；文案不得包含内部路径、模型 `ak`、`gatewayKey`。

### 8.3 `GET /health`

```json
{
  "name": "magpie-trae-intl",
  "version": "0.1.0",
  "connected": true,
  "sync": {
    "state": "synced|disconnected|pending|unknown",
    "models": 2,
    "code": "optional_machine_code",
    "revision": "64hex",
    "updatedAt": "ISO",
    "warnings": [{ "model": "...", "code": "..." }]
  },
  "credential": { "mode": "native|plaintext" },
  "requests": 12,
  "lastRequest": { "time": "ISO", "model": "...", "status": 200, "stream": true, "tools": 3, "images": 1, "reasoningEffort": "high", "durationMs": 1234 },
  "received": 13,
  "lastInbound": { "time": "ISO", "method": "POST", "route": "/v1/chat/completions", "status": 200 },
  "rejected": 1,
  "lastRejection": { "time": "ISO", "status": 401, "code": "local_auth_invalid" }
}
```

- `sync` 字段白名单清洗：`state` 只允许四值；`code` 匹配 `^[a-z][a-z0-9_]*$`；`revision` 必须 64 位小写 hex；`warnings` 只保留 `{model,code}` 字符串。读不到 status → `{state:'pending', code:'sync_status_unavailable'}`。
- `models` 仅在 `exposeModels:true` 时出现；默认不暴露模型 id/名称。
- 永不返回 `gatewayKey`、`baseURL`、`ak`、`sk`、`token`。
- `received`/`lastInbound` 只统计非 `/health` 请求。

### 8.4 `GET /v1/models`（需要标记）

```json
{ "object": "list", "data": [
  { "id": "...", "object": "model", "owned_by": "magpie", "name": "...",
    "context_length": 128000, "max_output_tokens": 16000, "images": true,
    "efforts": ["low","high"] } ] }
```

`context_length`/`max_output_tokens` 仅在值 > 0 时出现。

### 8.5 `POST /v1/chat/completions`

- body ≤ `maxBodyBytes`；JSON 对象；`model` 非空 string；`messages` 数组。
- `model` 必须在 `connection.models[].id` 中，否则 404。
- 转发体：解析后重新 `JSON.stringify`，字段不改；`stream`、`tools`、图片、`reasoning_effort` 原样保留。
- 上游头：`Bearer ${gatewayKey}`、`content-type`、`content-length`、`user-agent: magpie-agent-trae-intl/0.1.0`、`accept`（按请求 `stream`）、可选 `x-magpie-conversation`（`[A-Za-z0-9_.:-]{1,200}`）。
- 不转发任何入站头。
- 上游协议按 `baseURL` 选择 `http`/`https`；`setTimeout(upstreamTimeoutMs, destroy)`。
- 响应头只复制 `content-type`、`content-encoding`、`retry-after`，另加 `cache-control: no-store`、`x-accel-buffering: no`。
- body 原字节 `pipeline`，不解析、不重组、不缓冲。
- 上游未发头即错误 → 502 + 通用文案；已发头 → `res.destroy()`。
- 客户端提前断开 → 销毁上游；客户端已断开时不创建上游请求。

状态码表：400 / 401 / 403 / 404 / 405 / 413 / 502 / 503（含义同 §8.2 与 `architecture.md` §8）。

### 8.6 `startHost`

- 端口必须是 1..65535 的整数，否则 `trae_bridge_port_invalid`。
- `listen` 失败（含 `EADDRINUSE`）→ `setTimeout(attempt, retryMs ?? LIMITS.bridgeRetryMs)`，定时器 `unref()`；非 `EADDRINUSE` 只打印一次通用提示。
- 成功后 `server.unref()`。
- `ready` 在首次成功后 resolve；`stop()` 置停止位、清重试定时器、关闭桥。

---

## 9. `src/client-refresh.mjs`

```js
export const MAIN_SHA256: Readonly<Record<string,string>>
export function installClientRefresh(options = {}): ClientRefreshResult
export function restoreClient(options = {}): ClientRefreshResult
```

`MAIN_SHA256` = `{"3.6.20": "8b2bf9bb…426dc2"}`（来自 `constants.MAIN_SHA256_TABLE`）。

选项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `appDir` | `resolveAppDir().appDir` | |
| `home` | `os.homedir()` | 备份根 |
| `expectedHash` | `MAIN_SHA256[version]` | 仅测试 |
| `restore` | `false` | |
| `dryRun` | `false` | 只报告 |

安装步骤（任何拒绝都发生在第一次写之前）：

1. `version = readProduct(appDir).appVersion`；不在 `MAIN_SHA256` → `trae_client_refresh_build_unsupported`。
2. `main = <appDir>/out/main.js`，`helper = <appDir>/out/magpie-model-refresh.cjs`。
3. 若当前内容以任一已知 loader 结尾，剥掉得到 `original`（支持升级后重装）。
4. `sha256(original) !== expectedHash` → `trae_client_refresh_build_unsupported`（只认哈希，不认版本字符串）。
5. 备份 `<home>/.config/magpie-trae-intl/client-backups/<version>/main.original.js`：不存在才写（`wx`）；写后再次校验哈希 → 否则 `trae_client_refresh_backup_invalid`。
6. 非 restore：把包内 `src/refresh-notifier.cjs` 复制为 `helper`；哈希不同才原子写。
7. 目标内容 = `original + loaderFor(version)`（restore 时为 `original`）；内容不同才原子写。
8. restore 时删除 `helper`。
9. 写 `manifest.json`：`{state, version, changed, backup, updatedAt}`。

loader 文本（插在最后一个 `//# sourceMappingURL` 之前，缺失时追加到末尾）：

```js
// Magpie model catalog refresh (reversible, Trae (International) 3.6.20).
import("./magpie-model-refresh.cjs").then(m => (m.default ?? m).startNotifier()).catch(() => {});
```

返回：

```ts
{ state: 'installed'|'restored'|'unchanged'|'absent', version: string,
  changed: boolean, backup?: string, updatedAt: string }
```

`restoreClient(options)`：`installClientRefresh({...options, restore:true})` 的薄包装；无备份时返回 `{state:'absent', changed:false}`，不抛错。若当前 `main.js` 不是已知 loader 变体，拒绝覆写（`trae_client_refresh_build_unsupported`）。

**默认关闭**：`index.mjs` 只在 `options.clientRefresh === true` 或 `MAGPIE_TRAE_INTL_CLIENT_REFRESH=1` 时调用；CLI `restore-client` 永远可用。

---

## 10. `src/refresh-notifier.cjs`

```js
module.exports = { startNotifier, CHANNEL }
function startNotifier(options = {}): { tick: () => number, stop: () => void }
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `electron` | `require('electron')` | 测试注入；失败 → `trae_notifier_unavailable` |
| `directory` | `<home>/.config/magpie-trae-intl` | 只读 `sync-status.json` |
| `interval` | `LIMITS.notifierIntervalMs`（1000） | |
| `windowUrlPrefix` | `HOT_REFRESH.windowUrlPrefix` | |

行为：

- 单例键 `Symbol.for('magpie.trae-intl.model-refresh.v1')`；重复调用返回同一实例。
- 每 tick：读 status；只接受 `state ∈ {synced, disconnected}` 且 `revision` 为 64 位小写 hex。
- 目标窗口：`!isDestroyed() && getURL().startsWith(prefix) && !isLoadingMainFrame()`。
- 去重：`Map<windowId, revision>`；关闭的窗口从 map 删除。
- 发送：`window.send(CHANNEL, {detail:{type:'update', model:{}, openSource:'magpie', source:'magpie', revision}})`。
- 成功发送后写 `client-refresh-status.json = {revision, windows, notifiedAt}`；写失败不影响刷新。
- `electron.app.once('will-quit', stop)`；定时器 `unref()`。
- `CHANNEL === HOT_REFRESH.mainToRenderer`。
- 不读 `connection.json`、不读凭据、不读聊天数据。

---

## 11. `trae.agent.js`

```js
export const agent = { id, name, icon, dir, config, format, ua, library, notice }
export function connect({ gateway, models }): Connection
```

### 11.1 描述符（精确值）

| 字段 | 值 |
| --- | --- |
| `id` | `trae-intl` |
| `name` | `Trae (International)` |
| `icon` | `data:image/svg+xml;base64,<assets/trae.svg>`（与 `package.json` 字节一致） |
| `dir` | `$APPDATA/Trae` |
| `config` | `~/.config/magpie-trae-intl/connection.json` |
| `format` | `json` |
| `ua` | `[]` |
| `library.instructions` | `~/.trae/user_rules/magpie.md` |
| `library.mcp` | `$APPDATA/Trae/User/mcp.json` |
| `library.mcpFormat` | `claude` |
| `library.skills` | `~/.trae/skills` |
| `notice` | 见文件；说明自动同步、目录变化需重载、`status` 可诊断 |

约束：不写 `model`（connect-only）；`library` 四项一次写全（`mcp` 缺 `mcpFormat` 会导致整包不加载）；零 import、零 Node API。

### 11.2 `connect`

入参：

```ts
{ gateway: { v1: string, key: string },
  models?: Array<{ id: string, name?: string, context?: number, output?: number,
                   images?: boolean, efforts?: string[] }> }
```

出参：

```json
{
  "version": 2,
  "baseURL": "<gateway.v1>",
  "gatewayKey": "<gateway.key>",
  "models": [
    { "id": "vendor/model", "name": "显示名", "context": 128000, "output": 16000,
      "images": true, "efforts": ["low", "high"] }
  ]
}
```

- `gateway.v1`/`gateway.key` 缺失 → `trae_gateway_required`（可读错误；宿主零写入）。
- `models` 缺省 `[]`；`name ?? id`；`context ?? 0`；`output ?? 0`；`images` 转布尔；`efforts ?? []`。
- 同步、无 I/O、无定时器、无 `import.meta.url`。

---

## 12. `index.mjs`

```js
export default async function TraeIntlBridge(input, options = {}): Promise<{}>
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `DEFAULT_PORT`（3499） | 也可由 `MAGPIE_TRAE_INTL_PORT` 提供 |
| `skipNativeSync` | `false` | 只起桥（测试/诊断） |
| `clientRefresh` | `false` | 安装客户端补丁 |

行为：

1. 单例 `Symbol.for('magpie.trae-intl.bridge.v1')`；已存在直接返回 `{}`。
2. 可选 `installClientRefresh()`：异常被捕获，只打印白名单化错误码（否则 `trae_client_refresh_install_failed`），不阻断启动。
3. `startHost({port})`；`await ready`。
4. 非 `skipNativeSync`：`startModelSync({port})`。
5. 非 `skipNativeSync`：`process.once('exit')` 时 detached 启动 `restore.mjs <port>`（`windowsHide`、`stdio:'ignore'`、`unref()`）。
6. 返回 `{}`（不是 API 对象）。

**只导出 default**：宿主会把每个导出函数当插件调用，因此任何辅助函数都必须放在其他模块中。

---

## 13. `cli.mjs`

```
magpie-trae-intl <command> [--port <n>]
```

端口：`--port` > `MAGPIE_TRAE_INTL_PORT` > `DEFAULT_PORT`。

| 命令 | 行为 | 输出 | 退出码 |
| --- | --- | --- | --- |
| `status`（默认） | `GET http://127.0.0.1:<port>/health`，2 s 超时，校验 `name === 'magpie-trae-intl'` | 完整 health JSON | 0 / 1（桥不在线） |
| `models` | `GET /v1/models`，带 `Bearer <LOCAL_TOKEN>` | `data` 数组 | 0 / 1 |
| `sync` | 调 `syncModels()` 一次 | 白名单化后的 `SyncResult` | 0 / 1 |
| `doctor` | 只读报告：产品版本、安装来源、区域、origin 主机名、session 布尔值、profile 可用性、credential mode、目录策略、补丁状态、status 文件摘要 | 见下 | 0 / 1 |
| `setup` | 打印人类安装指引 | 文本 | 0 |
| `serve` | 前台 `createBridge` + `listen` | `listening on 127.0.0.1:<port>`；SIGINT/SIGTERM 关闭 | 0 / 1 |
| `restore-client` | `restoreClient()` | 结果 JSON | 0 / 1 |
| 其他 / `--help` | 用法 | stdout/stderr | 0 / 1 |

`doctor` 的允许输出：`appVersion`、`providerCode`、`region`、主机名、`session: {signedIn, expiresAtPassed, deviceKeys: 1}`、`credential: {mode, profileAvailable, buildAllowed}`、`catalog: 'batch'`、`clientRefresh: 'off|installed|unsupported'`、`sync: {state, models, revision}`。
禁止输出：token、userId、deviceId、`gatewayKey`、`ak`/`sk`、完整 `storage.json` 内容、安装绝对路径（只给来源枚举）。

---

## 14. `restore.mjs`

```
node restore.mjs [port]
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `argv[2]` | `DEFAULT_PORT` | 桥端口 |

行为：

1. 读 `connection.json`；非 ENOENT 的读取/解析错误 → 安静退出。
2. 仅当 `!connection?.gatewayKey` 且 `managed-models.json` 存在时执行 `syncModels({port})`。
3. 所有异常吞掉；`exitCode = 0`。
4. 不恢复客户端补丁（那是 `restore-client`）。

---

## 15. 状态文件 schema

### 15.1 `connection.json`（宿主写，插件只读）

| 字段 | 类型 | 校验 |
| --- | --- | --- |
| `version` | number | `=== 2` |
| `baseURL` | string | `http(s)`；host ∈ `{127.0.0.1, localhost, [::1]}`；无 userinfo/query/hash；pathname 去尾斜杠 `=== '/v1'`；端口 ≠ 桥端口 |
| `gatewayKey` | string | 非空，匹配 `^[\x21-\x7e]+$` |
| `models` | array | 每项 `id` 为非空 string；可为空数组 |
| `models[].name/context/output/images/efforts` | 可选 | 展示用 |

### 15.2 `managed-models.json`

```json
{
  "version": 2,
  "account": "<64 hex>",
  "entries": {
    "<model id>": {
      "id": "123456789",
      "created": true,
      "last": "<fingerprint>",
      "credentialFormat": 2
    },
    "<adopted model id>": {
      "id": "123456790",
      "created": false,
      "before": { "id": "123456790", "model": "...", "provider": "...", "name": "...", "ak": "<envelope>", "baseURL": "...", "status": true, "config": {}, "detail": {} },
      "last": "<fingerprint>"
    }
  },
  "pending": null
}
```

`pending` 三种形状见 `src/state.mjs` 的 typedef；`credentialFormat`：`2` native、`0` plaintext；缺失表示需要一次格式修复。

### 15.3 `sync-status.json`

成功：`{state:'synced'|'disconnected', models:number, warnings:[{model,code}], revision:'64hex', updatedAt:string, origin:string}`。
失败：`{state:'pending', code:string, updatedAt:string}`（覆盖旧文件，故意丢失 revision）。
读不到/损坏 → 桥按 `{state:'pending', code:'sync_status_unavailable'}` 处理。

### 15.4 `local-credential.json`

```json
{ "version": 1, "mode": "native", "profile": "trae-intl-3.6.20:<64 hex>", "ak": "<base64 envelope>" }
```

`plaintext` 模式不写该文件。

### 15.5 `client-refresh-status.json`

```json
{ "revision": "64hex", "windows": 2, "notifiedAt": "ISO" }
```

### 15.6 `client-backups/<version>/manifest.json`

```json
{ "state": "installed|restored", "version": "3.6.20", "changed": true, "backup": "<path>", "updatedAt": "ISO" }
```

### 15.7 `model-sync.lock`

```json
{ "pid": 12345, "key": "<uuid>" }
```

---

## 16. 错误码总表

| 码 | 模块 | 触发 |
| --- | --- | --- |
| `trae_intl_not_implemented` | 全部 stub | 骨架未实现（发布前必须消失） |
| `trae_home_unavailable` / `trae_home_invalid` | paths | 无 home / home 非绝对 |
| `trae_platform_unsupported` | paths | 非 win32 |
| `trae_installation_unavailable` | paths / credential | 找不到安装或 DLL |
| `trae_product_unreadable` / `trae_product_not_international` | paths | product.json 坏 / providerCode 非 i18n |
| `trae_session_unreadable` / `trae_not_signed_in` / `trae_sign_in_expired` / `trae_device_unavailable` / `trae_codec_unsupported` / `trae_session_invalid` | session | 见 §3 |
| `trae_credential_version_unsupported` / `_build_unsupported` / `_profile_unknown` / `_input_invalid` / `_invalid` / `_cache_unreadable` / `_self_check_failed` / `_unavailable` / `_mode_invalid` | credential | 见 §4 |
| `trae_origin_unavailable` / `trae_origin_invalid` | api | 见 §5.6 |
| `unsupported_trae_operation` | api | 方法不在白名单 |
| `trae_api_<code|status>` | api | 业务码非 0 / HTTP 非 2xx |
| `trae_response_<status>` | api | 非 JSON 响应 |
| `trae_catalog_unknown` / `trae_catalog_<error_code>` / `trae_catalog_strategy_unsupported` | api | 见 §5.2 |
| `trae_model_invalid` / `trae_model_id_invalid` | sync / api | id 缺失或不可数字化 |
| `sync_file_unreadable` / `sync_file_unwritable` | state | 读写失败 |
| `sync_lock_invalid` / `sync_busy` | state | 锁 |
| `sync_state_version_unknown` | sync | 日志版本不在 `[1,2]` |
| `trae_account_changed` | sync | 账号哈希不符 |
| `trae_credential_required` | sync | `modelRequest` 无 ak |
| `ambiguous_managed_model` / `ambiguous_model_configuration` | sync | 匹配到多条 |
| `trae_pending_model_missing` / `trae_pending_model_edited` | sync | 恢复冲突 |
| `trae_model_create_unverified` / `_update_unverified` / `_delete_unverified` / `_restore_unverified` | sync | 回读失败 |
| `trae_sync_failed` | sync | 非白名单异常兜底 |
| `trae_bridge_port_invalid` | bridge | 端口非法 |
| `trae_client_not_installed` / `trae_client_refresh_build_unsupported` / `_backup_invalid` / `_write_failed` / `trae_client_refresh_install_failed` | client-refresh | 见 §9 |
| `trae_notifier_unavailable` | notifier | Electron/窗口 API 不可用 |
| `trae_gateway_required` | trae.agent.js | gateway 不完整 |

警告码（不失败，写入 `warnings[]`）：`model_edited_in_trae`、`managed_model_removed_in_trae`。

---

## 17. 导出清单自检

| 需求 | 文件 | 导出 |
| --- | --- | --- |
| `resolvePaths(env?)` | `src/paths.mjs` | ✅ |
| `resolveAppDir(env?)` | `src/paths.mjs` | ✅ |
| `readProduct(appDir)` | `src/paths.mjs` | ✅ |
| `ensureConfigDir()` | `src/paths.mjs` | ✅（可选参数） |
| `readSession({storageFile?, product?, codec?})` | `src/session.mjs` | ✅ |
| `buildHeaders(session, product)` | `src/session.mjs` | ✅ |
| `readNativeCredentialProfile({appDir})` | `src/credential.mjs` | ✅ |
| `encodeCredential(value, profile, nonce?)` | `src/credential.mjs` | ✅ |
| `decodeCredential(value, profile)` | `src/credential.mjs` | ✅ |
| `localCredential(file, {profile?, mode?})` | `src/credential.mjs` | ✅ |
| `credentialMode()` | `src/credential.mjs` | ✅ |
| `class TraeAPI` | `src/api.mjs` | ✅ constructor / `list` / `add` / `update` / `remove` / `call` |
| `syncPaths(home?)` | `src/state.mjs` | ✅ |
| `readJson(file, fallback)` | `src/state.mjs` | ✅ |
| `writeJsonAtomic(file, value)` | `src/state.mjs` | ✅ |
| `withLock(file, fn)` | `src/state.mjs` | ✅ |
| `syncModels(options?)` | `src/sync.mjs` | ✅ |
| `startModelSync(options?)` | `src/sync.mjs` | ✅ |
| `modelRequest(model, endpoint, ak)` | `src/sync.mjs` | ✅ |
| `createBridge(options?)` | `src/bridge.mjs` | ✅ |
| `startHost(options?)` | `src/bridge.mjs` | ✅ |
| `DEFAULT_PORT` / `LOCAL_TOKEN` | `src/bridge.mjs` | ✅（re-export） |
| `installClientRefresh(options?)` | `src/client-refresh.mjs` | ✅ |
| `restoreClient(options?)` | `src/client-refresh.mjs` | ✅ |
| `MAIN_SHA256` 允许表 | `src/client-refresh.mjs` | ✅ |
| `startNotifier(options?)` | `src/refresh-notifier.cjs` | ✅（+ `CHANNEL`） |
| `agent` + `connect({gateway, models})` | `trae.agent.js` | ✅ |
| `default async plugin(input, options)` | `index.mjs` | ✅（仅 default） |
| CLI 命令 | `cli.mjs` | ✅（§13） |
| `restore` worker | `restore.mjs` | ✅（§14） |

`test/skeleton.test.mjs` 对以上导出与固定值做结构性断言；实现者新增导出不会破坏测试，但删除/改名会。
