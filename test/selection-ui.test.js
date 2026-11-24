import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { pickSelection } from '../src/selection.js';

const scan = {
  entries: [
    { module: 'skills', root: 'skills', path: 'alpha/SKILL.md' },
    { module: 'skills', root: 'skills', path: 'beta/SKILL.md' },
    { module: 'plugins', root: 'profile', path: 'package.json' },
    { module: 'config', root: 'dsh', path: 'AGENTS.md' },
  ],
};

test('勾选界面：空格切换模块，回车返回选择', async () => {
  const fakeIn = new PassThrough();
  fakeIn.isTTY = true;
  fakeIn.setRawMode = () => {};
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stdoutIsTTY = process.stdout.isTTY;
  const rendered = [];

  Object.defineProperty(process, 'stdin', { value: fakeIn, configurable: true });
  process.stdout.isTTY = true;
  process.stdout.write = (chunk) => {
    rendered.push(String(chunk));
    return true;
  };

  try {
    const picked = pickSelection(scan, {
      modules: { skills: true, plugins: true, config: true },
      exclude: { skills: [], plugins: [], config: [] },
    });
    setTimeout(() => {
      fakeIn.write(' '); // first row: skills module → off
      fakeIn.write(' '); // toggles it back on
      fakeIn.write('\u001b[B'); // down to alpha
      fakeIn.write(' '); // exclude alpha
      fakeIn.write('\r');
    }, 20);
    const selection = await picked;
    assert.equal(selection.modules.skills, true);
    assert.deepEqual(selection.exclude.skills, ['skills:alpha']);
    const output = rendered.join('');
    assert.match(output, /选择要备份的内容/);
    assert.match(output, /alpha/);
    assert.match(output, /beta/);
  } finally {
    process.stdout.write = stdoutWrite;
    process.stdout.isTTY = stdoutIsTTY;
    if (stdinDescriptor) Object.defineProperty(process, 'stdin', stdinDescriptor);
  }
});
