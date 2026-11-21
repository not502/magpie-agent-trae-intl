# 第三方组件与来源

本包包含一个 vendored 源文件、一份官方品牌图标（Trae 物料）。没有把 Trae 客户端二进制、Magpie 组件、真实凭据、账号数据或模型密钥打进包内。

## 1. Trae 登录信息解码器

| 项 | 内容 |
| --- | --- |
| 文件 | `src/vendor/trae-client-codec.mjs` |
| 上游 | `magpie-community/plugins`，`packages/trae/index.mjs` |
| 上游版本 | `bc9f611e346a29d92e4ef96f225b8f73c2abbfca`（见参考实现的 `THIRD_PARTY.md`） |
| 许可证 | MIT；完整文本见 `src/vendor/LICENSE-magpie-community` |
| 用途 | 解码 Trae `storage.json` 中 `iCubeAuthInfo://icube.cloudide` 的值，供本机会话读取使用 |
| 行为边界 | 只解码；不登录、不刷新 token、不写 `storage.json`、不输出明文 |

### 改动范围

- 保留上游的 AES-128-CBC 解码算法、两个 salt 表、`sha512(sha512(random) || salt)` 密钥派生和 64 字节完整性前缀校验。
- 为适配本仓库调整注释头与文件格式；导出名保持 `clientDecode`。
- 没有加入任何网络请求、登录流程、token 续期、文件写入或遥测。
- 解码后的 JSON 只在内存中交给 `src/session.mjs`；调用方不得打印或持久化其中的 token、userId 或 deviceId。

### 为什么需要它

Trae 的登录信息不是明文 JSON，而是客户端编码后的 blob。插件需要读取本机已登录会话，才能调用 Trae 自己的模型管理接口。该解码器只负责这一步；真正的账号认证仍由 Trae 完成。

## 2. Trae 产品图标

| 项 | 内容 |
| --- | --- |
| 文件 | `assets/trae.svg` |
| 来源 | Trae（国际版）官方物料 `resources/app/out/media/trae-logo.svg`，字节原样拷贝、未修改 |
| 版权 | Trae / 字节跳动所有；**不**随本包按 MIT 再授权 |
| 用途 | 仅在标识与互操作目的下使用；Agent 描述符的 `icon` 和 `package.json` 的 `magpie.icon` data URI；测试断言三处字节一致 |

该图标是 Trae 官方品牌物料，**不是**本仓库原创，也**不是**以 MIT 许可证发布的资产；本项目属非官方插件。详见 [`ASSET_NOTICE.md`](ASSET_NOTICE.md)。

## 3. 没有随包分发的内容

- Trae 客户端二进制：`harness.dll`、`ai_agent.dll`、`out/main.js` 不进入本包。
- 构建指纹只以 SHA-256 允许表的形式记录在 `src/constants.mjs`；AES 密钥材料在运行时从已安装客户端派生，不写入磁盘。
- 没有 Trae 或 Magpie 的凭据、token、账号 ID、设备 ID 或密钥。
- 没有 npm 运行时依赖。

## 4. 许可证兼容性

本包使用 MIT。上游 `magpie-community/plugins` 使用 MIT，完整许可证文本已随 `src/vendor/LICENSE-magpie-community` 分发；`package.json` 的 `files` 包含 `src`，因此该许可证会随包发布。

如果你再分发本包或其中的 vendored 文件，请保留上游版权声明和 MIT 许可证文本。注意 `assets/trae.svg`（见第 2 节）不是 MIT 资产，其版权归 Trae / 字节跳动所有；再分发该图标时请自行确认符合权利人的使用条件。
