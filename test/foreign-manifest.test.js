import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readManifestFromWorktree } from '../src/repo.js';
import { runStatus } from '../src/status.js';

test('拒绝其他插件的 manifest.json，并让 status 报告 manifestError', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-backup-foreign-'));
  const workdir = join(root, 'repo');
  const dshHome = join(root, 'dsh');
  const profileDir = join(dshHome, 'profiles', 'desktop');
  const skillsDir = join(root, 'skills');
  await mkdir(join(workdir, '.git'), { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  await writeFile(
    join(workdir, 'manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, createdAt: '2026-11-14T10:05:29.068Z' }, null, 2)}\n`,
    'utf8',
  );

  await assert.rejects(readManifestFromWorktree(workdir), (error) => error.code === 'FOREIGN_MANIFEST');

  const status = await runStatus({
    repo: 'https://example.invalid/repo.git',
    branch: 'main',
    workdir,
    profile: 'desktop',
    dshHome,
    profileDir,
    skillsDir,
    selection: { version: 1, modules: { skills: true, plugins: true, config: true }, exclude: { skills: [], plugins: [], config: [] } },
  });
  assert.equal(status.manifest, null);
  assert.match(status.manifestError, /不是 dsh-git-backup 快照格式/);
});
