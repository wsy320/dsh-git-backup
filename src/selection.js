import readline from 'node:readline';
import { normalizeSelection } from './config.js';

export function itemId(entry) {
  if (entry.module === 'skills') {
    const cut = entry.path.indexOf('/');
    return `${entry.root}:${cut === -1 ? entry.path : entry.path.slice(0, cut)}`;
  }
  return `${entry.root}:${entry.path}`;
}

function moduleLabel(id) {
  return { skills: '技能', plugins: '插件', config: '配置' }[id] ?? id;
}

/** Build the checkbox item list from a full scan. */
export function selectableItems(scan) {
  const groups = [];
  for (const module of ['skills', 'plugins', 'config']) {
    const items = [];
    const seen = new Set();
    for (const entry of scan.entries) {
      if (entry.module !== module) continue;
      let id;
      let label;
      if (module === 'skills') {
        const cut = entry.path.indexOf('/');
        const name = cut === -1 ? entry.path : entry.path.slice(0, cut);
        id = `${entry.root}:${name}`;
        label = entry.root === 'skills' ? name : `${entry.root}/${name}`;
      } else {
        id = `${entry.root}:${entry.path}`;
        label = entry.root === 'profile' ? entry.path : `${entry.root}/${entry.path}`;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ module, id, label, kind: 'item' });
    }
    items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    groups.push(...items);
  }
  return groups;
}

export function applySelection(scan, selection) {
  const sel = normalizeSelection(selection);
  const excluded = new Set();
  for (const module of Object.keys(sel.exclude)) {
    for (const id of sel.exclude[module]) excluded.add(`${module}\u0000${id}`);
  }

  const entries = scan.entries.filter((entry) => {
    if (!sel.modules[entry.module]) return false;
    const id = itemId(entry);
    const bare = id.slice(id.indexOf(':') + 1);
    return !excluded.has(`${entry.module}\u0000${id}`) && !excluded.has(`${entry.module}\u0000${bare}`);
  });

  const modules = {};
  for (const [id, meta] of Object.entries(scan.modules)) {
    modules[id] = { ...meta, files: 0, bytes: 0, count: 0 };
    if (id === 'skills') modules[id]._dirs = new Set();
  }
  for (const entry of entries) {
    const mod = modules[entry.module];
    if (mod === undefined) continue;
    mod.files += 1;
    mod.bytes += entry.size;
    if (entry.module === 'skills') {
      const cut = entry.path.indexOf('/');
      mod._dirs.add(`${entry.root}:${cut === -1 ? entry.path : entry.path.slice(0, cut)}`);
    }
  }
  for (const mod of Object.values(modules)) {
    mod.count = mod._dirs !== undefined ? mod._dirs.size : mod.files;
    delete mod._dirs;
  }

  const filtered = {
    ...scan,
    entries,
    modules,
    totals: { files: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0) },
  };
  return { scan: filtered, excludedCount: scan.entries.length - entries.length };
}

function isAllChecked(selection, groups) {
  return groups.every((item) => selection.modules[item.module] && !selection.exclude[item.module].includes(item.id));
}

/**
 * Terminal checkbox picker. Returns a new selection or null when cancelled.
 * Only called when both stdin and stdout are TTYs.
 */
export async function pickSelection(scan, current) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('勾选界面需要交互式终端；非交互环境请用 --only / --exclude-* 参数');
  }
  const selection = normalizeSelection(current);
  const groups = selectableItems(scan);
  const rows = [];
  for (const module of ['skills', 'plugins', 'config']) {
    rows.push({ kind: 'module', module, label: moduleLabel(module) });
    for (const item of groups.filter((g) => g.module === module)) rows.push(item);
  }
  // Keep at least one visible row even for empty modules.
  let cursor = 0;
  let rendered = 0;
  let closed = false;

  const anyChecked = (row) => {
    if (row.kind === 'module') {
      return selection.modules[row.module] && groups.some((g) => g.module === row.module && isChecked(g));
    }
    return selection.modules[row.module] && !selection.exclude[row.module].includes(row.id);
  };
  const isChecked = (item) => !selection.exclude[item.module].includes(item.id);

  function toggle(row) {
    if (row.kind === 'module') {
      selection.modules[row.module] = !selection.modules[row.module];
      return;
    }
    selection.modules[row.module] = true;
    const list = selection.exclude[row.module];
    const index = list.indexOf(row.id);
    if (index === -1) list.push(row.id);
    else list.splice(index, 1);
    list.sort();
  }

  function toggleAll() {
    const all = isAllChecked(selection, groups);
    for (const module of ['skills', 'plugins', 'config']) {
      selection.modules[module] = !all;
      selection.exclude[module] = [];
    }
  }

  function draw() {
    const lines = [];
    lines.push('选择要备份的内容（空格勾选，a 全选/全不选，回车保存，Esc 取消）');
    lines.push('');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const active = i === cursor ? '>' : ' ';
      if (row.kind === 'module') {
        const children = groups.filter((g) => g.module === row.module && isChecked(g));
        const mark = !selection.modules[row.module] ? ' ' : children.length === 0 ? ' ' : children.length === groups.filter((g) => g.module === row.module).length ? 'x' : '~';
        lines.push(`${active} [${mark}] ${row.label} (${children.length})`);
      } else {
        const mark = anyChecked(row) ? 'x' : ' ';
        lines.push(`${active}   [${mark}] ${row.label}`);
      }
    }
    lines.push('');
    lines.push('提示：取消勾选的项目不会写入 Git；已在仓库中的旧文件会在下一次备份时被移除。');
    const text = lines.join('\n');
    if (rendered > 0) process.stdout.write(`\x1b[${rendered}A`);
    process.stdout.write('\x1b[2K' + text.split('\n').join('\n\x1b[2K') + '\n');
    rendered = lines.length;
  }

  return await new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isRaw;
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write('\x1b[?25l');
    draw();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      stdin.removeListener('keypress', onKey);
      try {
        stdin.setRawMode(wasRaw ?? false);
      } catch {
        // ignore
      }
      stdin.pause();
      stdout.write('\x1b[?25h');
    };

    const onKey = (str, key) => {
      try {
        if (key?.ctrl && key.name === 'c') {
          cleanup();
          resolve(null);
          return;
        }
        if (key?.name === 'escape' || str === 'q') {
          cleanup();
          resolve(null);
          return;
        }
        if (key?.name === 'return') {
          cleanup();
          resolve(normalizeSelection(selection));
          return;
        }
        if (key?.name === 'up') cursor = (cursor - 1 + rows.length) % rows.length;
        else if (key?.name === 'down') cursor = (cursor + 1) % rows.length;
        else if (key?.name === 'space') toggle(rows[cursor]);
        else if (str === 'a' || str === 'A') toggleAll();
        else return;
        draw();
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    stdin.on('keypress', onKey);
  });
}
