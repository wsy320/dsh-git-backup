import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MODULE_IDS } from './assets.js';
import { runBackup } from './backup.js';
import { configPath, loadConfig, normalizeSelection, resolveContext, saveConfig, saveSelection, selectionPath } from './config.js';
import { gitLog, headShort, redactRepoUrl } from './repo.js';
import { runRestore } from './restore.js';
import { scanAssets } from './assets.js';
import { pickSelection } from './selection.js';
import { runStatus } from './status.js';
import { formatBytes, pathExists } from './util.js';

const BOOLEAN_FLAGS = new Set([
  'help',
  'version',
  'json',
  'select',
  'interactive',
  'all',
  'force',
  'noPush',
  'dryRun',
  'prune',
  'noInstall',
  'yes',
]);

const ALIASES = { '-h': 'help', '-v': 'version', '-m': 'message', '-n': 'limit', '-i': 'select' };

const KEY_MAP = {
  'dsh-home': 'dshHome',
  'skills-dir': 'skillsDir',
  'no-push': 'noPush',
  'dry-run': 'dryRun',
  'no-install': 'noInstall',
  'exclude-skill': 'excludeSkill',
  'exclude-plugin': 'excludePlugin',
  'exclude-config': 'excludeConfig',
  'keep-local': 'keepLocal',
};

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (!raw.startsWith('-') || raw === '-') {
      opts._.push(raw);
      continue;
    }
    let key = raw;
    let value;
    const eq = raw.indexOf('=');
    if (eq !== -1) {
      key = raw.slice(0, eq);
      value = raw.slice(eq + 1);
    }
    key = ALIASES[key] ?? key.replace(/^--/, '');
    key = KEY_MAP[key] ?? key;
    if (BOOLEAN_FLAGS.has(key)) {
      opts[key] = value === undefined ? true : value !== 'false';
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new Error(`参数 ${raw} 缺少值`);
    }
    if (key === 'excludeSkill' || key === 'excludePlugin' || key === 'excludeConfig' || key === 'exclude' || key === 'keepLocal') {
      opts[key] = [...(opts[key] ?? []), ...String(value).split(',').map((s) => s.trim()).filter(Boolean)];
    } else {
      opts[key] = value;
    }
  }
  return opts;
}

const HELP = `dsh-backup — 把 DSH 的插件、配置、技能备份到 Git 仓库，并一键还原

用法:
  dsh-backup init --repo <git-url> [选项]       配置备份仓库
  dsh-backup select                             勾选要备份的内容（交互式）
  dsh-backup backup [选项]                      备份到 Git 仓库
  dsh-backup restore [选项]                     从 Git 仓库一键还原
  dsh-backup status                             对比本地与仓库快照
  dsh-backup log [-n 10]                        查看备份历史
  dsh-backup config                             查看当前配置

通用选项:
  --profile <name>      DSH profile（默认 desktop）
  --dsh-home <path>     DSH_HOME（默认 ~/.dsh）
  --skills-dir <path>   技能目录（默认 ~/.agents/skills）
  --workdir <path>      本地 Git 工作目录（默认 ~/.dsh-backup/repo）
  --json                输出机器可读 JSON

init:
  --repo <url>          Git 仓库地址（必填；支持 HTTPS / SSH / 本地路径）
  --branch <name>       分支（默认 main）

backup:
  --select, -i          打开勾选界面（结果会保存）
  --all                 忽略已保存的勾选，备份全部
  --only <列表>         只备份指定模块，如 skills,config
  --exclude-skill <名>  排除技能（可重复，或逗号分隔）
  --exclude-plugin <名> 排除插件清单文件（如 package.json）
  --exclude-config <名> 排除配置文件（如 dsh:AGENTS.md）
  -m, --message <文本>  自定义提交说明
  --no-push             只提交到本地工作目录，不推送
  --force               允许覆盖远端已有的其他 profile / 分叉提交

restore:
  --commit <sha>        还原指定历史提交（默认远端最新）
  --dry-run             只预览，不写本机
  --prune               删除备份里没有的技能文件（默认不删）
  --keep-local <id>     冲突时保留本地版本，如 dsh:AGENTS.md；可重复
  --no-install          还原后不执行 dsh plugin install
  --force               允许检出与本地分叉的远端

示例:
  dsh-backup init --repo git@192.168.50.2:wsy/dsh-backup.git
  dsh-backup select
  dsh-backup backup
  dsh-backup restore --dry-run
  dsh-backup restore
`;

function parseModules(value) {
  if (value === undefined) return undefined;
  const list = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = list.filter((id) => !MODULE_IDS.includes(id));
  if (invalid.length > 0) throw new Error(`未知模块: ${invalid.join(', ')}（可用: ${MODULE_IDS.join(', ')}）`);
  return list;
}

function applySelectionOverrides(selection, opts) {
  const next = normalizeSelection(selection);
  const only = parseModules(opts.only);
  if (only !== undefined) {
    for (const id of MODULE_IDS) next.modules[id] = only.includes(id);
  }
  if (opts.all) {
    for (const id of MODULE_IDS) {
      next.modules[id] = true;
      next.exclude[id] = [];
    }
  }
  for (const id of opts.excludeSkill ?? []) next.exclude.skills.push(id);
  for (const id of opts.excludePlugin ?? []) next.exclude.plugins.push(id);
  for (const id of opts.excludeConfig ?? []) next.exclude.config.push(id);
  for (const value of opts.exclude ?? []) {
    const [module, ...rest] = value.split(':');
    const id = rest.join(':');
    if (!MODULE_IDS.includes(module) || id === '') throw new Error(`--exclude 格式应为 <模块>:<条目>，收到 ${value}`);
    next.exclude[module].push(id);
  }
  for (const id of MODULE_IDS) next.exclude[id] = [...new Set(next.exclude[id])].sort();
  return next;
}

async function contextFor(opts) {
  const ctx = await resolveContext(opts);
  ctx.selection = applySelectionOverrides(ctx.selection, opts);
  return ctx;
}

function printModules(modules) {
  for (const [id, mod] of Object.entries(modules)) {
    const label = mod.label ?? id;
    const unit = id === 'skills' ? `个技能 / ${mod.files} 个文件` : `${mod.files} 个文件`;
    console.log(`  ${label}: ${unit}, ${formatBytes(mod.bytes)}`);
  }
}

function printCredentials(credentials) {
  if (credentials.length === 0) return;
  console.log(`\n凭据过滤: ${credentials.length} 个文件未备份（不会进入 Git）`);
  for (const item of credentials.slice(0, 10)) {
    console.log(`  - ${item.module}/${item.root}:${item.path} — ${item.reason}`);
  }
  if (credentials.length > 10) console.log(`  … 其余 ${credentials.length - 10} 个`);
}

function printWarnings(warnings) {
  if (warnings.length === 0) return;
  console.log(`\n读取警告: ${warnings.length} 个`);
  for (const item of warnings.slice(0, 5)) console.log(`  - ${item.path}: ${item.reason}`);
}

async function cmdInit(opts) {
  const existing = await loadConfig();
  const repo = opts.repo || existing.repo;
  if (!repo) throw new Error('请用 --repo 指定 Git 仓库地址');
  if (String(repo).includes('@') && /\/\/[^/]*:[^/]*@/.test(String(repo))) {
    console.error('警告: 仓库 URL 里包含账号密码/令牌。工具不会保存凭据到配置里，但 URL 本身会被写入本机配置。建议改用 SSH 或 Git 凭据助手。');
  }
  const ctx = await resolveContext({ ...opts, repo });
  const config = {
    ...existing,
    version: 1,
    repo: String(repo),
    branch: ctx.branch,
    profile: ctx.profile,
    dshHome: ctx.dshHome,
    skillsDir: ctx.skillsDir,
    workdir: ctx.workdir,
    updatedAt: new Date().toISOString(),
  };
  await saveConfig(config);
  console.log('已保存配置');
  console.log(`  仓库: ${redactRepoUrl(config.repo)} (${config.branch})`);
  console.log(`  profile: ${config.profile}`);
  console.log(`  DSH_HOME: ${config.dshHome}`);
  console.log(`  技能: ${config.skillsDir}`);
  console.log(`  工作目录: ${config.workdir}`);
  console.log('\n下一步: dsh-backup select（可选）→ dsh-backup backup');
}

async function cmdSelect(opts) {
  const ctx = await contextFor(opts);
  const scan = await scanAssets({
    dshHome: ctx.dshHome,
    profileDir: ctx.profileDir,
    skillsDir: ctx.skillsDir,
  });
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('select 需要交互式终端；非交互环境请用 --only / --exclude-* 参数');
  }
  const picked = await pickSelection(scan, ctx.selection);
  if (picked === null) {
    console.log('已取消，未修改勾选');
    return;
  }
  const saved = await saveSelection(picked);
  const enabled = Object.entries(saved.modules).filter(([, v]) => v).map(([k]) => k);
  const excluded = Object.values(saved.exclude).reduce((n, list) => n + list.length, 0);
  console.log(`已保存勾选：模块 ${enabled.join(', ') || '无'}；排除 ${excluded} 项`);
}

async function cmdBackup(opts) {
  const ctx = await contextFor(opts);
  const modules = parseModules(opts.only);
  const result = await runBackup(ctx, {
    interactive: Boolean(opts.select || opts.interactive),
    modules,
    force: Boolean(opts.force),
    noPush: Boolean(opts.noPush),
    message: opts.message,
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          commit: result.commit,
          short: result.commit ? result.commit.slice(0, 8) : null,
          pushed: result.pushed,
          repo: result.remote,
          branch: result.branch,
          profile: result.manifest.profile,
          totals: result.manifest.totals,
          modules: result.manifest.modules,
          excludedCount: result.excludedCount,
          credentials: result.credentials,
          warnings: result.warnings,
          archivedWorkdir: result.archivedWorkdir ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`备份完成: ${result.manifest.totals.files} 个文件, ${formatBytes(result.manifest.totals.bytes)}`);
  printModules(result.manifest.modules);
  if (result.commit === null) {
    console.log('\n提交: 无变化，未产生新提交');
  } else {
    console.log(`\n提交: ${result.commit.slice(0, 8)}${result.pushed ? ' · 已推送到远端' : ' · 仅本地提交（--no-push）'}`);
  }
  if (result.excludedCount > 0) console.log(`按勾选排除: ${result.excludedCount} 个文件`);
  if (result.archivedWorkdir) console.log(`旧工作目录已归档: ${result.archivedWorkdir}`);
  printCredentials(result.credentials);
  printWarnings(result.warnings);
}

async function cmdRestore(opts) {
  const ctx = await contextFor(opts);
  if (!ctx.repo) throw new Error('未配置 Git 仓库地址，请先运行 dsh-backup init --repo <url>');
  const result = await runRestore(ctx, {
    commit: opts.commit,
    dryRun: Boolean(opts.dryRun),
    prune: Boolean(opts.prune),
    keepLocal: opts.keepLocal ?? [],
    noInstall: Boolean(opts.noInstall),
    force: Boolean(opts.force),
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: result.dryRun,
          commit: result.commit,
          profile: result.manifest.profile,
          createdAt: result.manifest.createdAt,
          counts: result.plan.counts,
          actions: result.plan.actions,
          extras: result.plan.extras.map((e) => ({ root: e.root, path: e.path })),
          keptLocal: result.keptLocal,
          snapshot: result.snapshot?.dir ?? null,
          installed: result.installed,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`快照提交: ${result.commit.slice(0, 8)} · profile ${result.manifest.profile} · ${result.manifest.createdAt}`);
  console.log(`规划: 新建 ${result.plan.counts.create}, 更新 ${result.plan.counts.update}, 未变 ${result.plan.counts.same}`);
  if (result.plan.extras.length > 0) {
    console.log(`本机额外技能文件: ${result.plan.extras.length} 个${opts.prune ? '（将删除）' : '（保留，--prune 可删除）'}`);
  }
  if (result.keptLocal.length > 0) {
    console.log(`保留本地版本: ${result.keptLocal.map((item) => `${item.root}:${item.path}`).join(', ')}`);
  }

  if (result.dryRun) {
    const changed = result.plan.actions.filter((a) => a.status !== 'same');
    for (const action of changed.slice(0, 40)) {
      console.log(`  ${action.status === 'create' ? '+' : '~'} ${action.root}:${action.path}`);
    }
    if (changed.length > 40) console.log(`  … 其余 ${changed.length - 40} 个`);
    console.log('\n这是预览，未写入本机。');
    return;
  }

  if (result.snapshot) console.log(`还原前本机快照: ${result.snapshot.dir}`);
  if (result.installed === true) console.log('插件依赖安装: 成功');
  else if (result.installed === false) {
    console.log('插件依赖安装: 失败 —— 文件已还原，请进入 profile 手动执行 dsh plugin --profile ' + ctx.profile + ' install');
    process.exitCode = 2;
  } else if (!opts.noInstall && result.manifest.files.some((f) => f.module === 'plugins')) {
    console.log('插件依赖安装: 未执行（插件清单未变化）');
  } else if (!opts.noInstall) {
    console.log('插件依赖安装: 未执行（备份中没有插件清单）');
  }

  console.log('\n还原完成。重启 DSH 后生效。');
}

async function cmdStatus(opts) {
  const ctx = await contextFor(opts);
  const status = await runStatus(ctx);
  if (opts.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`仓库: ${redactRepoUrl(status.repo) || '(未配置)'} (${status.branch})`);
  console.log(`profile: ${status.profile}`);
  console.log(`本地: ${status.local.totals.files} 个文件, ${formatBytes(status.local.totals.bytes)}`);
  printModules(status.local.modules);
  if (status.manifest !== null) {
    console.log(`仓库快照: ${status.manifest.createdAt} · ${status.manifest.totals.files} 个文件`);
    console.log(
      `差异: 新增 ${status.counts.added}, 修改 ${status.counts.modified}, 缺失 ${status.counts.missing}, 相同 ${status.counts.same}`,
    );
    const changed = status.changes.filter((c) => c.status !== 'same');
    for (const change of changed.slice(0, 30)) {
      const mark = { added: '+', modified: '~', missing: '-' }[change.status];
      console.log(`  ${mark} ${change.root}:${change.path}`);
    }
    if (changed.length > 30) console.log(`  … 其余 ${changed.length - 30} 个`);
    if (changed.length === 0) console.log('  本地与仓库快照一致');
  } else {
    console.log(status.manifestError ? `仓库快照: ${status.manifestError}` : '仓库快照: 尚未备份');
  }
  printCredentials(status.credentials);
}

async function cmdLog(opts) {
  const ctx = await contextFor(opts);
  if (!ctx.repo) throw new Error('未配置 Git 仓库地址，请先运行 dsh-backup init --repo <url>');
  if (!(await pathExists(join(ctx.workdir, '.git')))) throw new Error(`本地还没有工作副本: ${ctx.workdir}`);
  const entries = gitLog({ workdir: ctx.workdir, limit: Number(opts.limit ?? 10) });
  if (entries.length === 0) {
    console.log('还没有备份历史');
    return;
  }
  console.log(`当前位置: ${headShort(ctx.workdir)}`);
  for (const entry of entries) {
    console.log(`${entry.hash.slice(0, 8)}  ${entry.date}  ${entry.subject}`);
  }
}

async function cmdConfig(opts) {
  const ctx = await contextFor(opts);
  const config = await loadConfig();
  console.log(JSON.stringify(
    {
      configPath: configPath(),
      selectionPath: selectionPath(),
      repo: redactRepoUrl(config.repo),
      branch: config.branch ?? 'main',
      profile: ctx.profile,
      dshHome: ctx.dshHome,
      skillsDir: ctx.skillsDir,
      workdir: ctx.workdir,
      selection: ctx.selection,
    },
    null,
    2,
  ));
}

async function version() {
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.version) {
    console.log(await version());
    return;
  }
  const command = opts._[0];
  if (opts.help || command === undefined) {
    console.log(HELP);
    return;
  }
  switch (command) {
    case 'init':
      await cmdInit(opts);
      break;
    case 'select':
      await cmdSelect(opts);
      break;
    case 'backup':
    case 'push':
      await cmdBackup(opts);
      break;
    case 'restore':
    case 'pull':
      await cmdRestore(opts);
      break;
    case 'status':
      await cmdStatus(opts);
      break;
    case 'log':
      await cmdLog(opts);
      break;
    case 'config':
      await cmdConfig(opts);
      break;
    default:
      throw new Error(`未知命令: ${command}\n运行 dsh-backup --help 查看用法`);
  }
}
