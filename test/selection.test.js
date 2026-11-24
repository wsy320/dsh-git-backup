import assert from 'node:assert/strict';
import test from 'node:test';
import { applySelection, itemId, selectableItems } from '../src/selection.js';

const scan = {
  modules: { skills: { label: '技能' }, plugins: { label: '插件' }, config: { label: '配置' } },
  entries: [
    { module: 'skills', root: 'skills', path: 'alpha/SKILL.md', size: 1 },
    { module: 'skills', root: 'skills', path: 'alpha/scripts/x.sh', size: 2 },
    { module: 'skills', root: 'skills', path: 'beta/SKILL.md', size: 3 },
    { module: 'skills', root: 'skills', path: 'root-file.md', size: 4 },
    { module: 'plugins', root: 'profile', path: 'package.json', size: 5 },
    { module: 'config', root: 'profile', path: 'cordis.patch.yml', size: 6 },
    { module: 'config', root: 'dsh', path: 'AGENTS.md', size: 7 },
  ],
  totals: { files: 7, bytes: 28 },
};

test('selectableItems 按技能目录聚合，按文件列出配置与插件', () => {
  assert.deepEqual(
    selectableItems(scan).map((x) => x.id),
    [
      'skills:alpha',
      'skills:beta',
      'skills:root-file.md',
      'profile:package.json',
      'dsh:AGENTS.md',
      'profile:cordis.patch.yml',
    ],
  );
});

test('applySelection 支持关闭模块与按条目排除', () => {
  const result = applySelection(scan, {
    modules: { skills: true, plugins: false, config: true },
    exclude: { skills: ['skills:beta'], plugins: [], config: ['dsh:AGENTS.md'] },
  });
  assert.deepEqual(
    result.scan.entries.map((e) => itemId(e)),
    ['skills:alpha', 'skills:alpha', 'skills:root-file.md', 'profile:cordis.patch.yml'],
  );
  assert.equal(result.scan.modules.skills.count, 2);
  assert.equal(result.scan.modules.plugins.files, 0);
  assert.equal(result.excludedCount, 3);
});

test('applySelection 接受不带 root 前缀的排除名', () => {
  const result = applySelection(scan, {
    modules: { skills: true, plugins: true, config: true },
    exclude: { skills: ['beta'], plugins: ['package.json'], config: ['AGENTS.md'] },
  });
  assert.ok(!result.scan.entries.some((e) => e.path === 'beta/SKILL.md'));
  assert.ok(!result.scan.entries.some((e) => e.path === 'package.json'));
  assert.ok(!result.scan.entries.some((e) => e.path === 'AGENTS.md'));
});
