import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildRoutes } from '../lib/routes.js';

async function write(path, content) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function request(route, body) {
  const response = await route.fetch(
    new Request(`http://local${route.path}`, {
      method: route.methods[0],
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}

test('HTTP API：配置、扫描、勾选、备份、预览还原', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-backup-api-'));
  const home = join(root, 'home');
  const dshHome = join(root, 'dsh');
  const profileDir = join(dshHome, 'profiles', 'desktop');
  const skills = join(home, '.agents', 'skills');
  const workdir = join(home, '.dsh-backup', 'repo');
  const remote = join(root, 'remote.git');
  await write(join(profileDir, 'package.json'), '{"name":"dsh-profile-desktop","dependencies":{}}\n');
  await write(join(profileDir, 'cordis.patch.yml'), '- id: ui-chat\n');
  await write(join(dshHome, 'AGENTS.md'), '# agents\n');
  await write(join(skills, 'alpha', 'SKILL.md'), '# alpha\n');
  await write(join(skills, 'beta', 'SKILL.md'), '# beta\n');
  git(['init', '--bare', '-b', 'main', remote], root);

  const saved = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    DSH_AGENTS_SKILLS: process.env.DSH_AGENTS_SKILLS,
    DSH_BACKUP_CONFIG: process.env.DSH_BACKUP_CONFIG,
  };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.DSH_AGENTS_SKILLS = skills;
  delete process.env.DSH_BACKUP_CONFIG;

  try {
    const hostCtx = {
      get(name) {
        if (name === 'profileContext') return { name: 'desktop', dir: profileDir };
        return undefined;
      },
      logger: { info() {}, warn() {}, error() {} },
    };
    const routes = buildRoutes(hostCtx);
    const byPath = new Map(routes.map((route) => [route.path, route]));

    const initial = await request(byPath.get('/api/dsh-git-backup/state'));
    assert.equal(initial.status, 200);
    assert.equal(initial.body.ok, true);
    assert.equal(initial.body.configured, false);
    assert.equal(initial.body.groups.find((g) => g.id === 'skills').items.length, 2);

    const skillPreview = await request(byPath.get('/api/dsh-git-backup/file-preview'), { itemId: 'skills:alpha' });
    assert.equal(skillPreview.body.kind, 'dir');
    assert.equal(skillPreview.body.contentPath, 'SKILL.md');
    assert.equal(skillPreview.body.content, '# alpha\n');
    assert.ok(skillPreview.body.files.some((file) => file.path === 'SKILL.md'));

    const pluginPreview = await request(byPath.get('/api/dsh-git-backup/file-preview'), { itemId: 'profile:package.json' });
    assert.equal(pluginPreview.body.kind, 'file');
    assert.deepEqual(pluginPreview.body.summary.dependencies, []);
    assert.match(pluginPreview.body.content, /dsh-profile-desktop/);

    const settings = await request(byPath.get('/api/dsh-git-backup/settings'), {
      repo: remote,
      branch: 'main',
      workdir,
    });
    assert.equal(settings.body.configured, true);
    assert.equal(settings.body.config.repo, remote);

    const previewBackup = await request(byPath.get('/api/dsh-git-backup/preview-backup'), {});
    assert.equal(previewBackup.body.ok, true);
    assert.equal(previewBackup.body.counts.add, 5);
    assert.equal(previewBackup.body.commitNeeded, true);
    assert.equal(previewBackup.body.pushNeeded, true);
    assert.equal(git(['ls-remote', '--heads', remote, 'main'], root), '');

    const backup = await request(byPath.get('/api/dsh-git-backup/backup'), {});
    assert.equal(backup.body.ok, true);
    assert.equal(backup.body.pushed, true);
    assert.equal(backup.body.totals.files, 5);
    assert.equal(git(['rev-parse', '--verify', 'main'], remote).length, 40);

    const upToDate = await request(byPath.get('/api/dsh-git-backup/preview-backup'), {});
    assert.equal(upToDate.body.commitNeeded, false);
    assert.equal(upToDate.body.counts.same, 5);

    const afterBackup = await request(byPath.get('/api/dsh-git-backup/state'));
    assert.deepEqual(afterBackup.body.counts, { added: 0, modified: 0, missing: 0, same: 5 });

    const selection = {
      version: 1,
      modules: { skills: true, plugins: false, config: false },
      exclude: { skills: ['skills:beta'], plugins: [], config: [] },
    };
    const savedSelection = await request(byPath.get('/api/dsh-git-backup/selection'), { selection });
    assert.equal(savedSelection.body.selection.modules.plugins, false);
    const beta = savedSelection.body.groups.find((g) => g.id === 'skills').items.find((i) => i.label === 'beta');
    assert.equal(beta.checked, false);

    const preview = await request(byPath.get('/api/dsh-git-backup/restore'), { confirm: false });
    assert.equal(preview.body.dryRun, true);
    assert.equal(preview.body.counts.same, 5);
    assert.equal(await readFile(join(skills, 'alpha', 'SKILL.md'), 'utf8'), '# alpha\n');

    await write(join(dshHome, 'AGENTS.md'), '# changed\n');
    const restored = await request(byPath.get('/api/dsh-git-backup/restore'), { confirm: true, prune: true });
    assert.equal(restored.body.dryRun, false);
    assert.equal(restored.body.counts.update, 1);
    assert.equal(await readFile(join(dshHome, 'AGENTS.md'), 'utf8'), '# agents\n');

    const history = await request(byPath.get('/api/dsh-git-backup/history'));
    assert.ok(history.body.commits.length >= 1);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
