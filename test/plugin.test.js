import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject, name } from '../lib/index.js';

function fakeHost({ withTools = true } = {}) {
  const registered = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(service) {
      if (service === 'tools' && withTools) {
        return {
          register(definition) {
            registered.push(definition);
            return () => {};
          },
        };
      }
      if (service === 'profileContext') return { name: 'desktop', dir: 'C:/Users/x/.dsh/profiles/desktop' };
      return false;
    },
    inject(_services, callback) {
      callback(this);
    },
  };
  return { ctx, registered };
}

test('插件导出 DSH 宿主形状并注册 agent 工具', () => {
  assert.equal(name, 'dsh-git-backup');
  assert.deepEqual(inject, []);
  const { ctx, registered } = fakeHost();
  apply(ctx);
  assert.deepEqual(
    registered.map((tool) => tool.name),
    [
      'dsh_git_backup_status',
      'dsh_git_backup_backup',
      'dsh_git_backup_restore',
      'dsh_git_backup_history',
      'dsh_git_backup_selection',
    ],
  );
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
  }
});

test('tools 服务缺失时插件仍可加载', () => {
  const { ctx, registered } = fakeHost({ withTools: false });
  assert.doesNotThrow(() => apply(ctx));
  assert.equal(registered.length, 0);
});
