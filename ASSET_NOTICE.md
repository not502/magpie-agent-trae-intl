# 图标来源

`assets/trae.svg` 来自 **Trae（国际版）官方物料**：Trae 安装目录内的官方 logo 文件 `resources/app/out/media/trae-logo.svg`（16×16，深色圆角方块 + 绿色品牌标），字节**原样拷贝、未做任何修改**。该图标的版权归 **Trae / 字节跳动** 所有。

## 使用位置

| 位置 | 用途 |
| --- | --- |
| `assets/trae.svg` | 源文件（官方原始字节） |
| `trae.agent.js` 的 `agent.icon` | Agent 描述符图标（base64 data URI） |
| `package.json` 的 `magpie.icon` | Magpie 插件列表图标（base64 data URI） |

`test/skeleton.test.mjs` 断言这三处字节一致。

## 版权与使用性质

- 图标版权**归 Trae / 字节跳动所有**，不随本包按 MIT 许可证再授权；[`LICENSE`](LICENSE) 只覆盖本项目自身代码。
- 本仓库**仅在标识与互操作目的**下使用该官方物料：用于标示本插件接入的是 Trae（国际版）客户端，不用于其他用途，也不暗示任何官方授权、合作或背书。
- 本项目是**非官方插件**，是独立的第三方适配器，与 Trae / 字节跳动无任何隶属、授权或合作关系。
- 物料为官方文件的未修改副本，不含本仓库添加的任何图形改动；如权利人提出要求，将移除或替换该图标。
