[English](README.md) | 简体中文

# dsh-cloud-sync

DeepSeek Harness（dsh）的云端会话同步插件：**自动把你本机的对话会话备份到你自己服务器上，换电脑或新设备时一键恢复，恢复出的会话可以像本地会话一样继续对话。**

- **端到端加密**——会话标题、路径、对话内容全部加密后才离开你的电脑，服务器（哪怕是云厂商）看到的只是密文。
- **自动后台同步**——正常使用 dsh 即可，无需手动操作；同步失败自动重试，不影响本地使用。
- **自建服务器**——数据在你自己的服务器上，不依赖任何第三方云服务。

## 准备条件

- 本机已安装 dsh（pre-release 版本）
- 一台跑服务端的机器（云服务器、NAS 或本机均可，要求 Node 22+）

## 第一步：部署服务端

服务端是一个极简的存储程序（一个 Node 进程，无数据库），只负责存取密文，不理解内容。

先把本仓库放到服务器上（`git clone` 或直接拷贝 `packages/server/` 目录均可），然后在 `packages/server/` 目录执行：

```sh
pnpm install   # 首次

# 个人使用（单用户）
DSH_SYNC_TOKEN=<自定义一个访问令牌> PORT=8787 pnpm start

# 多人共用一台服务器（每人一个用户名 + 令牌）
DSH_SYNC_TOKENS="alice:<token-a>,bob:<token-b>" PORT=8787 pnpm start
```

- **访问令牌**自己生成即可（建议长随机串，如 `openssl rand -base64 32`）；多用户模式下把「用户名 + 令牌」成对发给每个用户，数据互相完全隔离。
- 服务器长期使用建议 systemd 常驻（示例：`packages/server/deploy/dsh-cloud-sync-server.service`）。
- 公网部署建议前面加一层 nginx/caddy 启用 HTTPS：会话内容虽然加密，但访问令牌走 HTTP 明文，有被嗅探的风险。

## 第二步：在 dsh 中安装插件

标准安装（发布到 npm 后）：

```sh
dsh plugin --profile web add dsh-cloud-sync
```

也可以手动安装：在 profile 目录（默认 `~/.dsh/profiles/web/`）执行 `pnpm add dsh-cloud-sync`，再把包名追加进该目录 `package.json` 的 `dsh.profile.bundles` 数组，重启 dsh。

尚未发布到 npm 时，可先在本仓库构建 tarball 安装：`pnpm --filter dsh-cloud-sync build && pnpm --filter dsh-cloud-sync pack`，然后 `dsh plugin --profile web add <tarball 路径>`。

## 第三步：配置

打开 dsh web → 设置 → 插件 → **Cloud Sync** 卡片，填写：

| 字段 | 填什么 |
|---|---|
| 服务器地址 | 如 `http://你的服务器IP:8787` |
| 用户名 | 多用户服务端填管理员分配给你的用户名；单用户服务端留空 |
| 访问令牌 | 服务端启动时配置的令牌（多用户模式填**你自己**的那个） |
| 加密口令 | 自己定一个口令。**多台设备必须填同一个**，它是解密的唯一钥匙 |
| 设备名 | 给这台电脑起个名字；**多台设备不能重名** |

填完点「测试连接」，显示「已连接 · 云端 N 个会话」即配置成功。之后正常使用 dsh，会话会自动加密上传。

## 日常使用

- **备份**：全自动，无需操作。设置卡上可查看同步状态、手动「立即全部同步」。
- **恢复到新设备**：新设备装好插件、填同样的服务器地址/用户名/令牌/**加密口令**（设备名换一个）→ 启动时的提示或设置卡「从云端恢复会话…」→ 勾选要恢复的会话（落盘路径可改）→ 恢复完成后会话出现在对应工作区下，打开即可继续对话。

## FAQ

- **忘了加密口令怎么办？** 无法找回。密钥由口令派生，服务器上只有密文——口令丢失即数据丢失，请妥善保管。
- **服务器上存的是什么？** 只有加密后的会话数据。服务器管理者能看到对象大小、时间和设备名，看不到任何会话内容。
- **多台设备怎么用？** 同一加密口令 + 不同设备名。第二台设备配好后即可直接读取第一台的备份。
- **同步失败会丢数据吗？** 不会。本地会话是唯一写入方，同步只是单向备份；失败会自动重试，也可随时手动重试。
- **能备份哪些会话？** dsh 默认存储形态（zstd 压缩 JSONL）的会话；`compression: none` 明文 profile 的会话不支持，会在状态行提示。

## 设计与开发

本仓库是 monorepo：`packages/plugin`（插件本体）、`packages/server`（参考服务端）。设计与协议文档为内部文档，随仓库维护但不随源码发布。

```sh
pnpm install
pnpm test                                        # 全部单测
pnpm --filter dsh-cloud-sync typecheck && pnpm --filter dsh-cloud-sync build
bash packages/plugin/test/e2e/m4/run.sh          # 恢复流程 e2e（自驱动）
```
