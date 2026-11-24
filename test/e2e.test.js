import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const BIN = fileURLToPath(new URL('../bin/dsh-backup.js', import.meta.url));

async function write(path, content) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function cli(args, env, cwd) {
  const merged = { ...process.env, ...env };
  if (merged.DSH_BIN === undefined) merged.DSH_BIN = 'dsh-does-not-exist';
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: merged,
    encoding: 'utf8',
  });
  return result;
}

function expectOk(result) {
  assert.equal(result.status, 0, `exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-backup-test-'));
  const home = join(root, 'home');
  const dshHome = join(root, 'dsh');
  const profileDir = join(dshHome, 'profiles', 'desktop');
  const skills = join(home, '.agents', 'skills');
  const workdir = join(home, '.dsh-backup', 'repo');
  const remote = join(root, 'remote.git');
  await mkdir(profileDir, { recursive: true });
  await mkdir(join(skills, 'alpha', 'scripts'), { recursive: true });
  await write(join(skills, 'alpha', 'SKILL.md'), '# alpha\n');
  await write(join(skills, 'alpha', 'scripts', 'run.sh'), '#!/bin/sh\necho alpha\n');
  await write(join(profileDir, 'package.json'), '{"name":"dsh-profile-desktop","dependencies":{"demo":"1.0.0"}}\n');
  await write(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await write(join(profileDir, 'cordis.patch.yml'), '- id: ui-chat\n  config:\n    enabled: true\n');
  await write(join(dshHome, 'AGENTS.md'), '# global contract\n');
  git(['init', '--bare', '-b', 'main', remote], root);
  const env = { HOME: home, USERPROFILE: home };
  expectOk(
    cli(
      [
        'init',
        '--repo',
        remote,
        '--dsh-home',
        dshHome,
        '--skills-dir',
        skills,
        '--profile',
        'desktop',
        '--workdir',
        workdir,
      ],
      env,
      root,
    ),
  );
  return { root, home, dshHome, profileDir, skills, workdir, remote, env };
}

test('备份 → 修改 → 一键还原；--prune 删除额外技能', async () => {
  const f = await fixture();

  const backup = expectOk(cli(['backup', '--json'], f.env, f.root));
  const payload = JSON.parse(backup.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.pushed, true);
  assert.equal(payload.totals.files, 6);

  assert.equal(git(['rev-parse', '--verify', 'main'], f.remote).length, 40);
  assert.equal(git(['config', '--get', 'http.postBuffer'], f.workdir), '268435456');
  assert.equal(await readFile(join(f.workdir, 'payload', 'skills', 'alpha', 'SKILL.md'), 'utf8'), '# alpha\n');
  assert.equal(
    JSON.parse(await readFile(join(f.workdir, 'manifest.json'), 'utf8')).format,
    'dsh-git-backup/v1',
  );

  await write(join(f.skills, 'alpha', 'SKILL.md'), '# changed\n');
  await write(join(f.skills, 'beta', 'SKILL.md'), '# beta\n');
  await write(join(f.dshHome, 'AGENTS.md'), '# changed contract\n');

  const dry = JSON.parse(expectOk(cli(['restore', '--dry-run', '--json'], f.env, f.root)).stdout);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.counts.update, 2);
  assert.equal(dry.counts.create, 0);
  assert.equal(dry.counts.extra, 1);
  assert.equal(await readFile(join(f.skills, 'alpha', 'SKILL.md'), 'utf8'), '# changed\n');

  // Restore overlays; beta was created after the backup, so without --prune it survives.
  expectOk(cli(['restore', '--no-install'], f.env, f.root));
  assert.equal(await readFile(join(f.skills, 'alpha', 'SKILL.md'), 'utf8'), '# alpha\n');
  assert.equal(await readFile(join(f.dshHome, 'AGENTS.md'), 'utf8'), '# global contract\n');
  assert.equal(await readFile(join(f.skills, 'beta', 'SKILL.md'), 'utf8'), '# beta\n');

  const pruned = JSON.parse(expectOk(cli(['restore', '--prune', '--no-install', '--json'], f.env, f.root)).stdout);
  assert.equal(pruned.counts.update, 0);
  assert.equal(pruned.counts.same, 6);
  assert.equal(pruned.extras.length, 1);
  await assert.rejects(readFile(join(f.skills, 'beta', 'SKILL.md'), 'utf8'));

  const status = JSON.parse(expectOk(cli(['status', '--json'], f.env, f.root)).stdout);
  assert.equal(status.counts.added, 0);
  assert.equal(status.counts.modified, 0);
  assert.equal(status.counts.missing, 0);
  assert.equal(status.counts.same, 6);

  const repeat = JSON.parse(expectOk(cli(['backup', '--json'], f.env, f.root)).stdout);
  assert.equal(repeat.commit, null);
});

test('凭据过滤：密钥文件与含令牌的配置不进入 Git', async () => {
  const f = await fixture();
  await write(join(f.skills, 'alpha', '.env'), 'API_KEY=sk-live-123\n');
  await write(join(f.skills, 'alpha', 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\n');
  await write(join(f.dshHome, 'settings.yaml'), 'theme: dark\napiKey: sk-abcdefghijklmnopqrstuvwxyz123456\n');
  await write(join(f.profileDir, '.npmrc'), '//registry.example/:_authToken=abcdefghijklmnopqrstuvwxyz\n');

  const result = expectOk(cli(['backup', '--json'], f.env, f.root));
  const payload = JSON.parse(result.stdout);
  const paths = payload.credentials.map((c) => `${c.root}:${c.path}`).sort();
  assert.deepEqual(paths, [
    'dsh:settings.yaml',
    'skills:alpha/.env',
    'skills:alpha/id_rsa',
  ]);

  const manifest = JSON.parse(await readFile(join(f.workdir, 'manifest.json'), 'utf8'));
  const files = manifest.files.map((x) => `${x.root}:${x.path}`);
  assert.ok(!files.includes('skills:alpha/.env'));
  assert.ok(!files.includes('skills:alpha/id_rsa'));
  assert.ok(!files.includes('dsh:settings.yaml'));
  assert.ok(files.includes('dsh:AGENTS.md'));
  await assert.rejects(readFile(join(f.workdir, 'payload', 'skills', 'alpha', '.env'), 'utf8'));
});

test('勾选：--only 与 --exclude 控制写入仓库的内容', async () => {
  const f = await fixture();
  await write(join(f.skills, 'beta', 'SKILL.md'), '# beta\n');

  expectOk(cli(['backup', '--only', 'skills', '--exclude-skill', 'beta', '--no-push'], f.env, f.root));
  let manifest = JSON.parse(await readFile(join(f.workdir, 'manifest.json'), 'utf8'));
  assert.deepEqual(
    manifest.files.map((x) => `${x.root}:${x.path}`).sort(),
    ['skills:alpha/SKILL.md', 'skills:alpha/scripts/run.sh'],
  );
  const status = JSON.parse(expectOk(cli(['status', '--json'], f.env, f.root)).stdout);
  assert.equal(status.counts.same, 2);
  assert.equal(status.counts.added, 0);

  expectOk(cli(['backup', '--all', '--no-push'], f.env, f.root));
  manifest = JSON.parse(await readFile(join(f.workdir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, 7);
  assert.ok(manifest.files.some((x) => x.root === 'profile' && x.path === 'package.json'));
  assert.ok(manifest.files.some((x) => x.root === 'skills' && x.path === 'beta/SKILL.md'));
});

test('本地有未推送备份时，restore 默认拒绝覆盖', async () => {
  const f = await fixture();
  expectOk(cli(['backup'], f.env, f.root));
  await write(join(f.skills, 'alpha', 'SKILL.md'), '# local only\n');
  expectOk(cli(['backup', '--no-push'], f.env, f.root));

  const blocked = cli(['restore', '--no-install'], f.env, f.root);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /未推送/);

  expectOk(cli(['restore', '--force', '--no-install'], f.env, f.root));
  assert.equal(await readFile(join(f.skills, 'alpha', 'SKILL.md'), 'utf8'), '# alpha\n');
});

test('还原插件清单后默认调用 dsh plugin install', async () => {
  const f = await fixture();
  expectOk(cli(['backup'], f.env, f.root));
  await write(join(f.profileDir, 'package.json'), '{"name":"dsh-profile-desktop","dependencies":{"changed":"2.0.0"}}\n');

  const script = process.platform === 'win32' ? join(f.root, 'fake-dsh.cmd') : join(f.root, 'fake-dsh.sh');
  const argsFile = join(f.root, 'dsh-args.txt');
  if (process.platform === 'win32') {
    await writeFile(script, `@echo off\r\necho %* > "${argsFile}"\r\nexit /b 0\r\n`);
  } else {
    await writeFile(script, `#!/bin/sh\necho "$@" > "${argsFile}"\n`);
    const { chmod } = await import('node:fs/promises');
    await chmod(script, 0o755);
  }
  const env = { ...f.env, DSH_BIN: script };
  const restored = JSON.parse(expectOk(cli(['restore', '--json'], env, f.root)).stdout);
  assert.equal(restored.installed, true);
  assert.equal(await readFile(argsFile, 'utf8').then((s) => s.trim()), 'plugin --profile desktop install');
});

test('历史提交还原', async () => {
  const f = await fixture();
  expectOk(cli(['backup', '--no-push'], f.env, f.root));
  const first = git(['rev-list', '--max-parents=0', 'main'], f.workdir);

  await write(join(f.skills, 'alpha', 'SKILL.md'), '# v2\n');
  expectOk(cli(['backup', '--no-push'], f.env, f.root));
  assert.equal(await readFile(join(f.workdir, 'payload', 'skills', 'alpha', 'SKILL.md'), 'utf8'), '# v2\n');

  expectOk(cli(['restore', '--commit', first, '--no-install'], f.env, f.root));
  assert.equal(await readFile(join(f.skills, 'alpha', 'SKILL.md'), 'utf8'), '# alpha\n');

  const log = expectOk(cli(['log'], f.env, f.root)).stdout;
  assert.match(log, /dsh-backup: desktop/);
});

test('远端为空时，自动归档旧插件的本地工作目录并完成备份', async () => {
  const f = await fixture();
  await mkdir(f.workdir, { recursive: true });
  git(['init', '-b', 'main'], f.workdir);
  git(['remote', 'add', 'origin', f.remote], f.workdir);
  await write(
    join(f.workdir, 'manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, generator: { name: 'dsh-plugins-git-sync' }, createdAt: '2026-11-14T10:05:29.068Z' })}\n`,
  );
  git(['add', 'manifest.json'], f.workdir);
  git(['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-m', 'foreign'], f.workdir);

  const backup = JSON.parse(expectOk(cli(['backup', '--json'], f.env, f.root)).stdout);
  assert.equal(backup.ok, true);
  assert.equal(backup.pushed, true);
  assert.ok(backup.archivedWorkdir, 'archived worktree path must be reported');
  assert.ok(backup.archivedWorkdir.includes('.bak-'));
  assert.equal(
    JSON.parse(await readFile(join(f.workdir, 'manifest.json'), 'utf8')).format,
    'dsh-git-backup/v1',
  );
  assert.equal(git(['rev-parse', '--verify', 'main'], f.remote).length, 40);
});

test('还原时可选择保留本地冲突文件', async () => {
  const f = await fixture();
  expectOk(cli(['backup', '--json'], f.env, f.root));
  await write(join(f.dshHome, 'AGENTS.md'), '# local only\n');

  const result = JSON.parse(
    expectOk(cli(['restore', '--keep-local', 'dsh:AGENTS.md', '--no-install', '--json'], f.env, f.root)).stdout,
  );
  assert.deepEqual(result.keptLocal, [{ root: 'dsh', path: 'AGENTS.md' }]);
  assert.equal(result.counts.update, 0);
  assert.equal(await readFile(join(f.dshHome, 'AGENTS.md'), 'utf8'), '# local only\n');
});
