# E2E 验收环境

## M4 恢复流程验收（`m4/`）

```sh
cd /path/to/dsh-cloud-sync
bash packages/plugin/test/e2e/m4/run.sh   # KEEP_WORK=1 保留 /tmp 现场；E2E_PORT=8873 换服务端端口
```

自驱动、跑完即退，打印 `M4-E2E-PASS` 表示通过。脚本编排：起参考服务端（默认 127.0.0.1:8872）→ 跑 m4 种子 → 起真实 dsh web（临时 `DSH_HOME`，`--port 0 --no-open`，挂 `m4/patch.yml` 全量预配）→ driver 就绪后依次触发 目录拉取 → 恢复执行（`targetCwd=$E2E_WORK/proj-a`）→ 落位发现 → workspace 成员断言 → `verify.mts` 断言。

**预配凭据**（`m4/patch.yml`，云端种子设备与本机设备不同名）：

| 字段 | 值 |
|---|---|
| 服务器地址 | `http://127.0.0.1:8872` |
| 访问令牌 | `e2e-token` |
| 加密口令 | `seed-pass` |
| 种子设备名 | `e2e-device` |
| 本机设备名 | `m4-local` |

种子数据（`m4/seed-cloud.mts`）：`sessions/e2e-device/seed-session-1`，来源 cwd `/tmp/proj-a`。与 m3 种子的差别：log 明文是**两个独立 zstd 帧**（首帧仅 header 行，第二帧仅一个 title 事件行），header 用 dsh 真实形态（`type:'session'` + 必填 `delegationDepth`）；kdf sidecar **只种在种子设备名下、不镜像到本机**——本机设备（m4-local）名下无 sidecar，目录拉取必须经 kdf 跨设备发现（`sync/kdf.ts`：试派生 + meta 试解密验证 + 采纳镜像）才能解开种子，e2e 由此覆盖该路径。第二帧字节以 hex 落盘 `$E2E_WORK/seed-frame2.hex`，供恢复后做「首帧 cwd 已改写、第二帧字节原样」的帧级断言。

**driver 触发**（`$E2E_WORK` 下）：`touch restore-list` → 写回 `catalog.json`；写 `restore-run`（RestoreRequest JSON）→ 写回 `result.json` + `discovered.json` + `workspace.json`（恢复挂载后会话应出现在 targetCwd 对应工作区的成员里——web 侧边栏按此分组，verify 会校验 realpath 一致）。

## M3 设置卡验收（`m3/`）

```sh
cd /path/to/dsh-cloud-sync
bash packages/plugin/test/e2e/m3/run.sh
```

脚本会：起参考服务端（127.0.0.1:8871）→ 种子一个云端会话 → 起真实 dsh web（临时 `DSH_HOME`，不污染 `~/.dsh`）→ 打印带 token 的访问地址。

**测试凭据**（设置卡里照此填写）：

| 字段 | 值 |
|---|---|
| 服务器地址 | `http://127.0.0.1:8871` |
| 访问令牌 | `e2e-token` |
| 加密口令 | `seed-pass` |
| 设备名 | `e2e-device` |

种子数据：`sessions/e2e-device/seed-session-1`（口令 `seed-pass` 加密），填对后测试连接应显示「已连接 · 云端 1 个会话」。

**driver 触发**：`touch $E2E_WORK/trigger` 会在 dsh 内创建本地会话 `m3-session-1`（用于验证自动上传开关）。

**手动调试**（不起服务端、不带 driver）：用 `dev.patch.yml`，详见文件头注释。

## M2 上行验收（`run.sh`）

```sh
bash packages/plugin/test/e2e/run.sh   # KEEP_WORK=1 保留 /tmp 现场
```

自动建会话并断言云端出现密文对象（passphrase `e2e-passphrase`，见 `patch.yml`）。
