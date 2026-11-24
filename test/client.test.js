import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

async function loadClient() {
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let definition;
  const window = {
    __ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
  };
  const document = {
    getElementById() {
      return null;
    },
    createElement() {
      return { textContent: '' };
    },
    head: { appendChild() {} },
  };
  vm.runInNewContext(code, { window, document, console, setTimeout, clearTimeout, fetch: async () => ({}) });
  assert.ok(definition, 'client must register with __ModuleLoader__');
  return definition;
}

test('client bundle registers settings.section 并导出 apply', async () => {
  const definition = await loadClient();
  assert.equal(definition.id, 'dsh-git-backup');
  const module = definition.factory((name) => {
    if (name === 'react') return { createElement() {}, useState() {}, useEffect() {}, useCallback() {}, Fragment: {}, Component: class { constructor(props) { this.props = props; } } };
    throw new Error(`unexpected module ${name}`);
  });
  assert.equal(module.inject.join(','), 'slots');
  assert.equal(typeof module.apply, 'function');

  let registered = [];
  const ctx = {
    slots: {
      inject(name, callback) {
        callback();
      },
      register(slot, component) {
        registered.push({ slot, component });
      },
    },
  };
  module.apply(ctx);
  const settings = registered.find((item) => item.slot.name === 'settings.section');
  assert.equal(settings.slot.id, 'git-backup');
  assert.equal(settings.slot.label, 'Git 备份');
  assert.equal(typeof settings.component, 'function');
  const detail = registered.find((item) => item.slot.name === 'plugins.detail.section');
  assert.equal(detail.slot.id, 'git-backup-detail');
  assert.equal(typeof detail.component, 'function');

  const internals = module.__internals;
  const base = { modules: { skills: true, plugins: true, config: true }, exclude: { skills: [], plugins: [], config: [] } };
  assert.equal(internals.itemChecked(base, 'skills', 'skills:alpha'), true);
  const excluded = internals.toggleItemSelection(base, 'skills', 'skills:alpha');
  assert.equal(internals.itemChecked(excluded, 'skills', 'skills:alpha'), false);
  assert.equal(internals.toggleModuleSelection(base, 'plugins').modules.plugins, false);
  assert.equal(internals.itemChecked({ ...base, modules: { ...base.modules, skills: false } }, 'skills', 'skills:alpha'), false);

  const partial = { ...base, exclude: { ...base.exclude, skills: ['skills:alpha'] } };
  const selectAll = internals.toggleGroupSelection(partial, 'skills', true);
  assert.equal(selectAll.modules.skills, true);
  assert.equal(selectAll.exclude.skills.length, 0);
  const clearAll = internals.toggleGroupSelection(partial, 'skills', false);
  assert.equal(clearAll.modules.skills, false);
});
