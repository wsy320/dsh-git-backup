# dsh-git-backup

把 DSH 的插件清单、配置和技能备份到 Git 仓库，并在需要时从快照一键还原。

提供两种使用方式：

- **DSH 桌面界面**：设置 → Git 备份
- **命令行**：`dsh-backup`
- 同时注册 Agent 工具，可供 DSH 内的智能体调用

备份内容是 **Git 仓库中的全量快照**，包含 `manifest.json` 和文件副本；不做增量差异存储。

## 功能

- 按模块、技能目录、插件清单文件、配置文件逐项勾选
- 备份前预览：会新增、更新、删除哪些文件
- 还原前预览：逐文件选择「保留本地」或使用备份版本
- 还原前自动生成本机快照，保留最近 10 份
- 默认过滤凭据文件，避免 Token、私钥进入 Git
- 支持多分支，适合不同机器使用不同插件环境
- CLI、桌面设置页、Agent 工具共用同一份配置和勾选

## 备份范围

| 模块 | 默认内容 |
|---|---|
| 插件 | `<DSH_HOME>/profiles/<profile>/package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` |
| 配置 | 同目录的 `cordis.patch.yml`，以及 `<DSH_HOME>/AGENTS.md`、`settings.yaml/json` 等 |
| 技能 | `~/.agents/skills`；如果存在 `~/.dsh/skills` 也会一起备份 |

说明：

- `package.json` 声明安装了哪些插件和 bundle。
- `pnpm-lock.yaml` 锁定依赖版本，建议一起备份。
- `pnpm-workspace.yaml` 影响 pnpm 安装方式和原生模块构建，存在时也应备份。
- `cordis.patch.yml` 是当前 profile 的配置补丁层，包含插件启停、模型 provider、UI 设置等。
- `node_modules` 不备份，还原后由 DSH/pnpm 重新安装依赖。

## 安装

要求：

- DSH
- Git
- Node.js >= 20（仅 CLI/开发需要）

把本仓库安装到目标 DSH profile。先退出 DSH 桌面应用：

```bash
dsh plugin --profile <profile> add "link:/path/to/dsh-backup"
```

`<profile>` 默认是 `desktop`，`/path/to/dsh-backup` 替换成本仓库所在目录。

也可以手动确认 profile 的 `package.json` 包含：

```json
{
  "dependencies": {
    "dsh-git-backup": "link:/path/to/dsh-backup"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-git-backup"]
    }
  }
}
```

安装后重启 DSH，打开「设置 → Git 备份」。

### 命令行

```bash
cd /path/to/dsh-backup
npm link
dsh-backup --help
```

也可以不执行 `npm link`，直接运行：

```bash
node bin/dsh-backup.js --help
```

CLI、桌面界面和 Agent 工具共用：

```text
~/.dsh-backup/config.json
~/.dsh-backup/selection.json
```

Windows 下 `~` 表示当前用户主目录。

## 快速开始

1. 在 Git 服务端创建一个**空的私有仓库**，不要自动生成 README。
2. 打开 **设置 → Git 备份 → 设置**，填写：
   - Git 仓库地址
   - 分支（默认 `main`）
   - 本地工作目录（默认 `~/.dsh-backup/repo`）
3. 保存配置。
4. 在「备份内容」里勾选要备份的模块和文件。
5. 点「预览」确认变更，再点「立即备份」。
6. 需要恢复时打开「还原」，先「预览还原」，确认后再执行。

CLI 等价流程：

```bash
dsh-backup init --repo <git-url> --profile <profile>
dsh-backup select
dsh-backup backup --dry-run
dsh-backup backup
```

## 桌面界面

### 备份内容

- 类型旁的勾选框：全选 / 全不选该类型
- 技能名、文件名、插件清单名：点击查看内容
- 顶部实时显示已选文件数和体积

### 预览

只读取，不写入、不推送。可以查看：

- 新增文件
- 更新文件
- 删除文件
- 是否需要提交

### 立即备份

保存当前勾选并推送到 Git。没有变化时不会产生空提交。

### 还原

先点「预览还原」，会显示：

```text
新建 N · 更新 N · 未变 N · 额外 N
```

每个 `update` 文件可以勾选 **「保留本地」**。勾选后该文件跳过，其余文件仍按备份还原。

还原前会生成本机快照，路径会显示在结果中。插件清单变化后，桌面端不会自动安装依赖：

1. 退出 DSH
2. 执行：
   ```bash
   dsh plugin --profile <profile> install
   ```
3. 重新启动 DSH

### 历史

显示**当前本地分支**最近 20 次备份提交，不显示其他分支。要看另一台机器的历史，先切换到对应分支。

## 命令行

### 初始化

```bash
dsh-backup init --repo <git-url>
```

支持 SSH、HTTPS 和本地路径：

```bash
dsh-backup init --repo git@example.com:you/dsh-backup.git
dsh-backup init --repo https://example.com/you/dsh-backup.git
dsh-backup init --repo /path/to/backup.git
```

常用覆盖项：

```bash
dsh-backup init --repo <git-url> \
  --profile <profile> \
  --dsh-home ~/.dsh \
  --skills-dir ~/.agents/skills \
  --workdir ~/.dsh-backup/repo \
  --branch main
```

配置中**不保存 Token 或密码**。HTTPS 使用 Git 凭据助手，SSH 使用系统密钥。

### 勾选

```bash
dsh-backup select
```

操作：

- 空格：勾选 / 取消
- `a`：全选 / 全不选
- 回车：保存
- Esc：取消

非交互场景可以直接传参数：

```bash
dsh-backup backup --only skills,config
dsh-backup backup --exclude-skill <skill-name>
dsh-backup backup --exclude-plugin pnpm-lock.yaml
dsh-backup backup --exclude-config dsh:AGENTS.md
dsh-backup backup --all
```

### 备份

```bash
dsh-backup backup
```

流程：

1. 扫描勾选的文件并计算 SHA-256
2. 写入本地工作副本
3. 提交
4. 推送到配置的分支

常用参数：

```bash
dsh-backup backup --select
dsh-backup backup --no-push
dsh-backup backup -m "before upgrade"
dsh-backup backup --force
```

### 还原

```bash
dsh-backup restore --dry-run
dsh-backup restore
```

流程：

1. 拉取目标提交
2. 生成本机快照
3. 覆盖文件
4. 默认执行 `dsh plugin --profile <profile> install`
5. 重启 DSH

常用参数：

```bash
dsh-backup restore --commit <sha>
dsh-backup restore --prune
dsh-backup restore --keep-local dsh:AGENTS.md
dsh-backup restore --no-install
```

说明：

- `--prune` 只删除备份里没有的技能文件和空目录
- 配置和插件清单只覆盖，不删除本机额外文件
- `--keep-local` 可重复，格式为预览里的 `root:path`
- 本地和远端提交分叉时，默认拒绝还原；确认后用 `--force`

### 状态与历史

```bash
dsh-backup status
dsh-backup log -n 20
dsh-backup config
```

`status`、`backup`、`restore` 都支持 `--json`。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `dsh_git_backup_status` | 查看仓库、profile、本地数量和差异 |
| `dsh_git_backup_backup` | 备份，可传模块和排除项 |
| `dsh_git_backup_restore` | 默认预览；`confirm: true` 才写入 |
| `dsh_git_backup_history` | 查看备份历史 |
| `dsh_git_backup_selection` | 读取或保存勾选 |

`dsh_git_backup_restore` 支持：

- `commit`
- `prune`
- `noInstall`
- `keepLocal`：`root:path` 数组

## 仓库结构

```text
manifest.json                  # 快照元数据和文件哈希
payload/
  skills/<skill-name>/...      # ~/.agents/skills
  dshSkills/...                # ~/.dsh/skills（如果存在）
  profile/package.json         # profiles/<profile>/
  profile/cordis.patch.yml
  dsh/AGENTS.md                # ~/.dsh/
```

工具只管理 `manifest.json` 和 `payload/`，不会删除仓库中的其他文件。建议使用专用仓库。

如果仓库中已有其他工具生成的 `manifest.json`：

- 远端为空：点「立即备份」会自动归档旧工作目录并重建
- 远端已有内容：拒绝覆盖，请换空仓库或迁走旧内容

## 安全边界

以下内容默认不备份：

- `.env`、`.env.local`、`.env.production` 等
- `.credentials.*`、`secrets.*`、`auth.json`
- `id_rsa`、`id_ed25519`、`*.pem`、`*.key`、`*.pfx`、`*.p12`
- `.npmrc`、`.yarnrc`、`.git-credentials`、`.netrc`
- 内容中检测到 GitHub / OpenAI / AWS / Slack 令牌、私钥头、JWT、Bearer Token 的文件

被过滤的文件会显示在备份结果中。技能文件会原样进入 Git，建议使用私有仓库。

## 多机使用

备份是单分支全量快照，同一分支上后备份的会覆盖先备份的。

两台机器插件不同时，推荐一台机器一个分支：

```text
机器 A → 分支 machine-a
机器 B → 分支 machine-b
```

每台机器在设置里填写自己的分支，互不覆盖。

注意：

- 历史页只显示当前分支
- 切换分支后，需要让本地工作目录 checkout 到该分支
- `package.json` 中的 `link:` / `file:` 依赖包含本机路径，换机器后可能需要修改
- 不同机器技能不同的话，不要启用「删除备份里没有的技能」

## 常见问题

**还原后插件没装好**

退出 DSH 后执行：

```bash
dsh plugin --profile <profile> install
```

**还原后想找回旧版本**

还原结果会打印本机快照目录，手动拷回即可。

**推送报 HTTP 411、RPC failed 或 curl 56**

通常是 Git 前的 HTTP 反向代理不接受 chunked 请求。工具已自动设置：

```bash
git config http.postBuffer 268435456
```

旧工作目录可以手动执行这行后重试。备份文件超过 256 MB 时可以继续调大，或改用 SSH。

**仓库提示 manifest.json 格式不兼容**

目标仓库不是本工具生成的快照。换一个空仓库；如果远端已经是空的，直接备份会自动归档旧工作目录。

**Windows 换行**

工作副本强制 `core.autocrlf=false`，备份和还原保持字节一致。

## 开发

```bash
npm test
```

测试使用临时 DSH 目录和临时 Git 仓库，不会读写真实的 `~/.dsh` 或 `~/.dsh-backup`。
