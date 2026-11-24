/**
 * Browser half of dsh-git-backup.
 *
 * Loaded verbatim as a classic script by the DSH client module loader. Only
 * the factory side effect is registration; the panel is rendered by the
 * settings shell when the user selects "Git 备份".
 */
window.__ModuleLoader__.load({
  id: 'dsh-git-backup',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/api/dsh-git-backup';
    const PANEL_ID = 'git-backup';
    const PANEL_LABEL = 'Git 备份';
    const MODULES = ['skills', 'plugins', 'config'];
    const MODULE_LABEL = { skills: '技能', plugins: '插件', config: '配置' };

    function formatBytes(bytes) {
      const n = Number(bytes) || 0;
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / 1024 / 1024).toFixed(2)} MB`;
    }

    function itemChecked(selection, module, id) {
      if (!selection.modules[module]) return false;
      const excluded = selection.exclude[module] ?? [];
      const bare = id.slice(id.indexOf(':') + 1);
      return !excluded.includes(id) && !excluded.includes(bare);
    }

    function toggleModuleSelection(selection, module) {
      return {
        ...selection,
        modules: { ...selection.modules, [module]: !selection.modules[module] },
      };
    }

    function toggleGroupSelection(selection, module, selectAll) {
      if (selectAll) {
        return {
          ...selection,
          modules: { ...selection.modules, [module]: true },
          exclude: { ...selection.exclude, [module]: [] },
        };
      }
      return {
        ...selection,
        modules: { ...selection.modules, [module]: false },
      };
    }

    function toggleItemSelection(selection, module, id) {
      const list = new Set(selection.exclude[module] ?? []);
      const bare = id.slice(id.indexOf(':') + 1);
      const checked = !list.has(id) && !list.has(bare);
      if (checked) {
        list.add(id);
        list.delete(bare);
      } else {
        list.delete(id);
        list.delete(bare);
      }
      return {
        ...selection,
        modules: { ...selection.modules, [module]: true },
        exclude: { ...selection.exclude, [module]: [...list].sort() },
      };
    }

    const ALL_SELECTION = {
      modules: { skills: true, plugins: true, config: true },
      exclude: { skills: [], plugins: [], config: [] },
    };

    async function api(path, body) {
      const init = body === undefined
        ? { method: 'GET' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          };
      const response = await fetch(API + path, init);
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`接口返回 HTTP ${response.status}，不是 JSON。DSH 可能需要重启以加载新插件。`);
      }
      if (data.ok === false) throw new Error(data.error || '操作失败');
      return data;
    }

    function ensureStyles() {
      if (document.getElementById('dsh-git-backup-style')) return;
      const style = document.createElement('style');
      style.id = 'dsh-git-backup-style';
      style.textContent = `
.dgb { display:flex; flex-direction:column; gap:16px; padding:20px 24px; color:inherit; max-width:1100px; }
.dgb-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
.dgb-title { margin:0; font-size:18px; font-weight:600; }
.dgb-sub { margin:4px 0 0; opacity:.65; font-size:12px; line-height:1.5; }
.dgb-tabs { display:flex; gap:4px; border-bottom:1px solid rgba(127,127,127,.25); }
.dgb-tab { appearance:none; border:0; background:transparent; color:inherit; padding:8px 12px; cursor:pointer; font-size:13px; border-bottom:2px solid transparent; opacity:.7; }
.dgb-tab[data-active="true"] { opacity:1; border-bottom-color:currentColor; font-weight:600; }
.dgb-card { border:1px solid rgba(127,127,127,.25); border-radius:10px; padding:14px 16px; background:var(--dsh-surface, transparent); }
.dgb-row { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.dgb-group { border:1px solid rgba(127,127,127,.18); border-radius:10px; overflow:hidden; }
.dgb-group-head { display:flex; align-items:center; gap:10px; padding:10px 12px; background:rgba(127,127,127,.06); font-weight:600; }
.dgb-items { display:flex; flex-direction:column; }
.dgb-item { display:flex; align-items:center; gap:10px; padding:8px 12px 8px 34px; border-top:1px solid rgba(127,127,127,.1); font-size:13px; }
.dgb-item[data-disabled="true"] { opacity:.5; }
.dgb-item-main { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dgb-meta { opacity:.55; font-size:11px; white-space:nowrap; }
.dgb-btn { appearance:none; border:1px solid rgba(127,127,127,.35); background:transparent; color:inherit; border-radius:7px; padding:6px 11px; font-size:12px; cursor:pointer; }
.dgb-btn:hover:not(:disabled) { background:rgba(127,127,127,.1); }
.dgb-btn:disabled { opacity:.45; cursor:not-allowed; }
.dgb-btn-primary { background:#2f6fed; border-color:#2f6fed; color:#fff; }
.dgb-btn-primary:hover:not(:disabled) { background:#2458c0; }
.dgb-btn-danger { border-color:#c0392b; color:#c0392b; }
.dgb-banner { border-radius:8px; padding:10px 12px; font-size:12px; line-height:1.5; }
.dgb-banner[data-kind="error"] { background:rgba(192,57,43,.12); color:#c0392b; }
.dgb-banner[data-kind="ok"] { background:rgba(39,174,96,.12); color:#1e8449; }
.dgb-banner[data-kind="warn"] { background:rgba(230,126,34,.12); color:#b9770e; }
.dgb-field { display:flex; flex-direction:column; gap:6px; font-size:12px; }
.dgb-field > span { opacity:.7; }
.dgb-input { box-sizing:border-box; width:100%; border:1px solid rgba(127,127,127,.35); border-radius:7px; padding:7px 9px; background:transparent; color:inherit; font-size:13px; }
.dgb-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.dgb-chips { display:flex; gap:6px; flex-wrap:wrap; }
.dgb-chip { border:1px solid rgba(127,127,127,.3); border-radius:999px; padding:3px 9px; font-size:11px; opacity:.8; }
.dgb-list { display:flex; flex-direction:column; gap:6px; max-height:360px; overflow:auto; }
.dgb-action { display:flex; gap:8px; font-size:12px; padding:4px 0; border-bottom:1px solid rgba(127,127,127,.1); }
.dgb-action-code { width:18px; text-align:center; font-weight:600; }
.dgb-history-item { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid rgba(127,127,127,.1); font-size:12px; }
.dgb-muted { opacity:.6; }
.dgb-small { font-size:11px; }
.dgb-clickable { cursor:pointer; }
.dgb-clickable:hover { text-decoration:underline; }
.dgb-modal { position:fixed; inset:0; z-index:1000; background:rgba(0,0,0,.35); display:flex; align-items:center; justify-content:center; padding:24px; }
.dgb-modal-panel { width:min(1100px,100%); max-height:86vh; display:flex; flex-direction:column; background:var(--dsh-surface,#fff); color:inherit; border:1px solid rgba(127,127,127,.35); border-radius:12px; box-shadow:0 18px 60px rgba(0,0,0,.28); overflow:hidden; }
.dgb-modal-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; border-bottom:1px solid rgba(127,127,127,.2); }
.dgb-modal-body { display:grid; grid-template-columns:230px minmax(0,1fr); min-height:0; flex:1; }
.dgb-modal-body[data-layout="single"] { grid-template-columns:minmax(0,1fr); }
.dgb-file-list { border-right:1px solid rgba(127,127,127,.2); padding:8px; overflow:auto; max-height:66vh; }
.dgb-file-btn { display:block; width:100%; text-align:left; border:0; background:transparent; color:inherit; padding:5px 7px; border-radius:6px; font-size:11px; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dgb-file-btn:hover { background:rgba(127,127,127,.1); }
.dgb-file-btn[data-active="true"] { background:rgba(47,111,237,.14); color:#2f6fed; }
.dgb-modal-main { min-width:0; display:flex; flex-direction:column; }
.dgb-pre { margin:0; padding:12px 16px; overflow:auto; max-height:66vh; white-space:pre-wrap; word-break:break-word; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; line-height:1.5; }
.dgb-summary { padding:10px 16px; border-bottom:1px solid rgba(127,127,127,.15); font-size:12px; }
.dgb-summary-row { display:flex; justify-content:space-between; gap:12px; padding:2px 0; }
@media (max-width: 720px) { .dgb-grid { grid-template-columns:1fr; } .dgb { padding:14px; } .dgb-modal-body { grid-template-columns:1fr; } .dgb-file-list { max-height:180px; border-right:0; border-bottom:1px solid rgba(127,127,127,.2); } }
`;
      document.head.appendChild(style);
    }

    function StatusBar(props) {
      const { data } = props;
      if (data === null || !data.totals) return null;
      const counts = data.counts;
      const snapshot = data.manifestError
        ? '仓库快照格式不兼容'
        : data.manifest
          ? data.manifest.totals && typeof data.manifest.totals.files === 'number'
            ? `仓库快照 ${data.manifest.totals.files} 文件`
            : '仓库快照格式不兼容'
          : '仓库还没有快照';
      return h(
        'div',
        { className: 'dgb-chips' },
        h('span', { className: 'dgb-chip' }, `本地 ${data.totals.files} 文件 · ${formatBytes(data.totals.bytes)}`),
        h('span', { className: 'dgb-chip' }, snapshot),
        counts
          ? h(
              'span',
              { className: 'dgb-chip' },
              `新增 ${counts.added} · 修改 ${counts.modified} · 缺失 ${counts.missing} · 相同 ${counts.same}`,
            )
          : null,
        data.configured
          ? h('span', { className: 'dgb-chip' }, data.config.branch)
          : h('span', { className: 'dgb-chip' }, '未配置仓库'),
      );
    }

    function InspectModal(props) {
      const { inspect, onClose, onFile } = props;
      if (inspect === null) return null;
      const data = inspect.data;
      return h(
        'div',
        { className: 'dgb-modal', onClick: onClose },
        h(
          'div',
          { className: 'dgb-modal-panel', onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'dgb-modal-head' },
            h(
              'div',
              null,
              h('strong', null, inspect.title),
              data?.contentPath ? h('div', { className: 'dgb-small dgb-muted' }, data.contentPath) : null,
            ),
            h('button', { className: 'dgb-btn', onClick: onClose }, '关闭'),
          ),
          inspect.loading
            ? h('p', { className: 'dgb-pre dgb-muted' }, '正在读取…')
            : inspect.error
              ? h('p', { className: 'dgb-pre' }, inspect.error)
              : data
                ? h(
                    'div',
                    { className: 'dgb-modal-body', 'data-layout': data.kind === 'dir' && data.files.length > 0 ? 'split' : 'single' },
                    data.kind === 'dir' && data.files.length > 0
                      ? h(
                          'div',
                          { className: 'dgb-file-list' },
                          data.files.map((file) =>
                            h(
                              'button',
                              {
                                key: file.path,
                                className: 'dgb-file-btn',
                                'data-active': String(file.path === data.contentPath),
                                title: file.path,
                                onClick: () => onFile(file.path),
                              },
                              file.path,
                            ),
                          ),
                        )
                      : null,
                    h(
                      'div',
                      { className: 'dgb-modal-main' },
                      data.summary
                        ? h(
                            'div',
                            { className: 'dgb-summary' },
                            data.summary.dependencies.length > 0
                              ? h('div', null, h('strong', null, '依赖'), ...data.summary.dependencies.map((dep) => h('div', { className: 'dgb-summary-row', key: `d:${dep.name}` }, h('span', null, dep.name), h('span', { className: 'dgb-muted' }, dep.version))))
                              : null,
                            data.summary.bundles.length > 0
                              ? h('div', { style: { marginTop: 8 } }, h('strong', null, 'profile bundles'), ...data.summary.bundles.map((name) => h('div', { className: 'dgb-summary-row', key: `b:${name}` }, h('span', null, name))))
                              : null,
                          )
                        : null,
                      data.binary || data.truncated
                        ? h('p', { className: 'dgb-pre dgb-muted' }, data.message || '无法显示内容')
                        : h('pre', { className: 'dgb-pre' }, data.content ?? data.message ?? '（空）'),
                    ),
                  )
                : null,
        ),
      );
    }

    function BackupPreviewCard(props) {
      const { preview } = props;
      if (preview === null) return null;
      const changed = preview.changes ?? [];
      return h(
        'div',
        { className: 'dgb-card' },
        h(
          'div',
          { className: 'dgb-row' },
          h('strong', null, '备份预览'),
          h(
            'span',
            { className: 'dgb-meta' },
            `${preview.totals.files} 文件 · ${formatBytes(preview.totals.bytes)}`,
          ),
        ),
        h(
          'div',
          { className: 'dgb-chips', style: { marginTop: 8 } },
          h('span', { className: 'dgb-chip' }, `新增 ${preview.counts.add}`),
          h('span', { className: 'dgb-chip' }, `更新 ${preview.counts.update}`),
          h('span', { className: 'dgb-chip' }, `删除 ${preview.counts.remove}`),
          h('span', { className: 'dgb-chip' }, `不变 ${preview.counts.same}`),
          h('span', { className: 'dgb-chip' }, preview.commitNeeded ? (preview.pushNeeded ? '将提交并推送' : '将提交') : '没有变化'),
        ),
        !preview.configured
          ? h('div', { className: 'dgb-banner', 'data-kind': 'warn', style: { marginTop: 8 } }, '还没有配置 Git 仓库。先到“设置”页填写仓库地址，预览不会写入或推送。')
          : null,
        preview.selectionChanged ? h('div', { className: 'dgb-banner', 'data-kind': 'warn', style: { marginTop: 8 } }, '勾选与上次快照不同：备份会按当前勾选更新仓库内容。') : null,
        preview.profileChanged ? h('div', { className: 'dgb-banner', 'data-kind': 'warn', style: { marginTop: 8 } }, 'profile 与上次快照不同：需要 --force 才会覆盖。') : null,
        changed.length > 0
          ? h(
              'div',
              { className: 'dgb-list', style: { marginTop: 8 } },
              changed.slice(0, 150).map((action) =>
                h(
                  'div',
                  { className: 'dgb-action', key: `${action.status}:${action.root}:${action.path}` },
                  h('span', { className: 'dgb-action-code' }, action.status === 'add' ? '+' : action.status === 'update' ? '~' : '-'),
                  h('span', null, `${action.root}:${action.path}`),
                ),
              ),
            )
          : null,
        preview.credentials.length > 0
          ? h('p', { className: 'dgb-small dgb-muted', style: { marginTop: 8 } }, `已自动排除 ${preview.credentials.length} 个凭据文件。`)
          : null,
        h('p', { className: 'dgb-small dgb-muted', style: { marginTop: 8 } }, '预览基于本地工作副本；真正备份时会先拉取远端最新提交。'),
      );
    }

    function AssetsTab(props) {
      const { data, selection, setSelection, busy, onSave, onBackup, onPreview, preview, onInspect, message, setMessage } = props;
      if (data === null || selection === null) return null;

      const itemIsChecked = (module, item) => itemChecked(selection, module, item.id);
      const selectedFiles = data.groups.reduce(
        (n, group) => n + group.items.filter((item) => itemIsChecked(group.id, item)).reduce((m, item) => m + item.files, 0),
        0,
      );
      const selectedBytes = data.groups.reduce(
        (n, group) => n + group.items.filter((item) => itemIsChecked(group.id, item)).reduce((m, item) => m + item.bytes, 0),
        0,
      );

      const toggleModule = (module, allChecked) => {
        setSelection((prev) => toggleGroupSelection(prev, module, !allChecked));
      };

      const toggleItem = (module, id) => {
        setSelection((prev) => toggleItemSelection(prev, module, id));
      };

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dgb-card' },
          h(
            'div',
            { className: 'dgb-row' },
            h(
              'div',
              { className: 'dgb-row', style: { gap: 8 } },
              h('button', { className: 'dgb-btn', disabled: Boolean(busy), onClick: () => setSelection(ALL_SELECTION) }, '全选'),
              h('button', { className: 'dgb-btn', disabled: Boolean(busy), onClick: () => setSelection((prev) => ({ ...prev, modules: { skills: false, plugins: false, config: false } })) }, '全不选'),
              h('span', { className: 'dgb-meta' }, `已选 ${selectedFiles} 个文件 · ${formatBytes(selectedBytes)}`),
            ),
            h(
              'div',
              { className: 'dgb-row', style: { gap: 8 } },
              h('button', { className: 'dgb-btn', disabled: Boolean(busy), onClick: onSave }, '保存勾选'),
              h('button', { className: 'dgb-btn', disabled: Boolean(busy), onClick: onPreview }, busy === 'preview-backup' ? '预览中…' : '预览'),
              h('button', { className: 'dgb-btn dgb-btn-primary', disabled: Boolean(busy), onClick: onBackup }, busy === 'backup' ? '正在备份…' : '立即备份'),
            ),
          ),
          h(
            'div',
            { className: 'dgb-field', style: { marginTop: 12 } },
            h('span', null, '提交说明（可选）'),
            h('input', {
              className: 'dgb-input',
              value: message,
              placeholder: '例如：升级插件前',
              onChange: (event) => setMessage(event.target.value),
            }),
          ),
        ),
        h(BackupPreviewCard, { preview }),
        ...data.groups.map((group) => {
          const checkedItems = group.items.filter((item) => itemIsChecked(group.id, item)).length;
          const allChecked = group.items.length > 0 && checkedItems === group.items.length;
          return h(
            'div',
            { className: 'dgb-group', key: group.id },
            h(
              'div',
              { className: 'dgb-group-head' },
              h('input', {
                type: 'checkbox',
                checked: allChecked,
                disabled: Boolean(busy),
                onChange: () => toggleModule(group.id, allChecked),
              }),
              h('span', null, group.label),
              h('span', { className: 'dgb-meta' }, `${checkedItems}/${group.items.length} 项 · ${formatBytes(group.bytes)}`),
            ),
            h(
              'div',
              { className: 'dgb-items' },
              group.items.length === 0
                ? h('div', { className: 'dgb-item dgb-muted' }, '没有找到可备份的内容')
                : group.items.map((item) =>
                    h(
                      'div',
                      { className: 'dgb-item', key: item.id, 'data-disabled': String(!selection.modules[group.id]) },
                      h('input', {
                        type: 'checkbox',
                        checked: itemIsChecked(group.id, item),
                        disabled: Boolean(busy),
                        onChange: () => toggleItem(group.id, item.id),
                      }),
                      h(
                        'span',
                        {
                          className: 'dgb-item-main dgb-clickable',
                          title: '点击预览内容',
                          onClick: () => onInspect(item),
                        },
                        item.label,
                      ),
                      h('span', { className: 'dgb-meta' }, `${item.files} 文件 · ${formatBytes(item.bytes)}`),
                    ),
                  ),
            ),
          );
        }),
        data.credentials.length > 0
          ? h(
              'div',
              { className: 'dgb-banner', 'data-kind': 'warn' },
              `已自动排除 ${data.credentials.length} 个凭据文件，不会进入 Git。`,
              h(
                'div',
                { className: 'dgb-small', style: { marginTop: 6 } },
                data.credentials.slice(0, 6).map((item) => `${item.root}:${item.path}`).join('、'),
                data.credentials.length > 6 ? ' …' : '',
              ),
            )
          : null,
      );
    }

    function RestoreTab(props) {
      const { data, preview, busy, prune, setPrune, force, setForce, keepLocal, onToggleKeep, onPreview, onRestore, commit, setCommit } = props;
      if (data === null) return null;
      const keepSet = new Set(keepLocal);
      const keptCount = preview
        ? preview.dryRun
          ? preview.actions.filter((action) => action.status === 'update' && keepSet.has(`${action.root}:${action.path}`)).length
          : (preview.keptLocal?.length ?? 0)
        : 0;
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dgb-card' },
          h('div', { className: 'dgb-row' }, h('strong', null, '从 Git 快照还原'), h(StatusBar, { data })),
          h(
            'div',
            { className: 'dgb-grid', style: { marginTop: 12 } },
            h(
              'label',
              { className: 'dgb-field' },
              h('span', null, '提交（留空表示最新）'),
              h('input', { className: 'dgb-input', value: commit, onChange: (e) => setCommit(e.target.value), placeholder: '完整或短 commit' }),
            ),
            h(
              'div',
              { className: 'dgb-field' },
              h('span', null, '选项'),
              h(
                'label',
                { className: 'dgb-row', style: { justifyContent: 'flex-start' } },
                h('input', { type: 'checkbox', checked: prune, onChange: (e) => setPrune(e.target.checked) }),
                '删除备份里没有的技能',
              ),
              h(
                'label',
                { className: 'dgb-row', style: { justifyContent: 'flex-start' } },
                h('input', { type: 'checkbox', checked: force, onChange: (e) => setForce(e.target.checked) }),
                '忽略本地未推送提交',
              ),
            ),
          ),
          h(
            'div',
            { className: 'dgb-row', style: { marginTop: 12 } },
            h('span', { className: 'dgb-meta' }, '还原前会自动生成本机快照；插件文件变化后需退出 DSH 安装依赖。'),
            h('button', { className: 'dgb-btn dgb-btn-primary', disabled: Boolean(busy), onClick: onPreview }, busy === 'preview' ? '正在读取…' : '预览还原'),
          ),
        ),
        preview
          ? h(
              'div',
              { className: 'dgb-card' },
              h('div', { className: 'dgb-row' }, h('strong', null, preview.dryRun ? '还原预览' : '还原结果'), h('span', { className: 'dgb-meta' }, `${String(preview.commit).slice(0, 8)} · profile ${preview.profile}`)),
              h('div', { className: 'dgb-chips', style: { marginTop: 8 } }, h('span', { className: 'dgb-chip' }, `新建 ${preview.counts.create}`), h('span', { className: 'dgb-chip' }, `更新 ${preview.counts.update}`), h('span', { className: 'dgb-chip' }, `未变 ${preview.counts.same}`), h('span', { className: 'dgb-chip' }, `额外 ${preview.counts.extra}`), keptCount > 0 ? h('span', { className: 'dgb-chip' }, `保留本地 ${keptCount}`) : null),
              preview.dryRun && preview.actions.some((action) => action.status === 'update')
                ? h('p', { className: 'dgb-small dgb-muted' }, '勾选“保留本地”的文件在确认还原时会跳过，其余文件仍按快照覆盖。')
                : null,
              preview.snapshot ? h('p', { className: 'dgb-small dgb-muted' }, `还原前快照：${preview.snapshot}`) : null,
              preview.needsRestart ? h('div', { className: 'dgb-banner', 'data-kind': 'warn', style: { marginTop: 8 } }, '文件已还原。插件清单有变化时，请退出 DSH 后执行 dsh plugin --profile desktop install，再启动 DSH。') : null,
              h(
                'div',
                { className: 'dgb-list', style: { marginTop: 8 } },
                preview.actions.filter((a) => a.status !== 'same').slice(0, 200).map((action) => {
                  const key = `${action.root}:${action.path}`;
                  return h(
                    'div',
                    { className: 'dgb-action', key: `${action.status}:${key}` },
                    h('span', { className: 'dgb-action-code' }, action.status === 'create' ? '+' : action.status === 'update' ? '~' : '-'),
                    h('span', null, key),
                    action.status === 'update' && preview.dryRun
                      ? h(
                          'label',
                          { className: 'dgb-small', style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 } },
                          h('input', {
                            type: 'checkbox',
                            checked: keepSet.has(key),
                            disabled: Boolean(busy),
                            onChange: () => onToggleKeep(key),
                          }),
                          '保留本地',
                        )
                      : null,
                  );
                }),
              ),
              preview.dryRun
                ? h(
                    'div',
                    { className: 'dgb-row', style: { marginTop: 12 } },
                    h('span', { className: 'dgb-meta' }, '预览不会写入本机。确认后才会覆盖文件。'),
                    h('button', { className: 'dgb-btn dgb-btn-danger', disabled: Boolean(busy), onClick: onRestore }, busy === 'restore' ? '正在还原…' : '确认还原'),
                  )
                : null,
            )
          : null,
      );
    }

    function HistoryTab(props) {
      const { commits, loading, onSelect } = props;
      return h(
        'div',
        { className: 'dgb-card' },
        h('strong', null, '备份历史'),
        loading ? h('p', { className: 'dgb-muted' }, '正在读取…') : null,
        commits.length === 0 && !loading ? h('p', { className: 'dgb-muted' }, '还没有备份历史') : null,
        h(
          'div',
          null,
          commits.map((commit) =>
            h(
              'div',
              { className: 'dgb-history-item', key: commit.hash },
              h('div', null, h('div', null, commit.subject), h('div', { className: 'dgb-small dgb-muted' }, `${commit.hash.slice(0, 8)} · ${commit.date}`)),
              h('button', { className: 'dgb-btn', onClick: () => onSelect(commit.hash) }, '预览此版本'),
            ),
          ),
        ),
      );
    }

    function SettingsTab(props) {
      const { data, repo, setRepo, branch, setBranch, workdir, setWorkdir, onSave, busy } = props;
      if (data === null) return null;
      return h(
        'div',
        { className: 'dgb-card' },
        h('strong', null, '仓库与路径'),
        h(
          'div',
          { className: 'dgb-grid', style: { marginTop: 12 } },
          h('label', { className: 'dgb-field', style: { gridColumn: '1 / -1' } }, h('span', null, 'Git 仓库地址'), h('input', { className: 'dgb-input', value: repo, onChange: (e) => setRepo(e.target.value), placeholder: 'git@host:user/repo.git 或 https://…' })),
          h('label', { className: 'dgb-field' }, h('span', null, '分支'), h('input', { className: 'dgb-input', value: branch, onChange: (e) => setBranch(e.target.value) })),
          h('label', { className: 'dgb-field' }, h('span', null, '本地工作目录'), h('input', { className: 'dgb-input', value: workdir, onChange: (e) => setWorkdir(e.target.value) })),
        ),
        h('p', { className: 'dgb-small dgb-muted' }, `profile: ${data.config.profile} · DSH_HOME: ${data.config.dshHome} · 技能: ${data.config.skillsDir}`),
        h('p', { className: 'dgb-small dgb-muted' }, '凭据不会写入配置；HTTPS 使用 Git 凭据助手，SSH 使用系统密钥。'),
        h(
          'div',
          { className: 'dgb-row', style: { marginTop: 12 } },
          h('span', { className: 'dgb-meta' }, data.configured ? '仓库已配置' : '尚未配置仓库'),
          h('button', { className: 'dgb-btn dgb-btn-primary', disabled: Boolean(busy), onClick: onSave }, busy === 'settings' ? '保存中…' : '保存配置'),
        ),
      );
    }

    function GitBackupSection() {
      const [data, setData] = React.useState(null);
      const [selection, setSelection] = React.useState(null);
      const [tab, setTab] = React.useState('assets');
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState('');
      const [toast, setToast] = React.useState(null);
      const [message, setMessage] = React.useState('');
      const [preview, setPreview] = React.useState(null);
      const [backupPreview, setBackupPreview] = React.useState(null);
      const [inspect, setInspect] = React.useState(null);
      const [prune, setPrune] = React.useState(false);
      const [force, setForce] = React.useState(false);
      const [keepLocal, setKeepLocal] = React.useState([]);
      const [commit, setCommit] = React.useState('');
      const [commits, setCommits] = React.useState([]);
      const [historyLoading, setHistoryLoading] = React.useState(false);
      const [repo, setRepo] = React.useState('');
      const [branch, setBranch] = React.useState('main');
      const [workdir, setWorkdir] = React.useState('');

      const load = React.useCallback(async () => {
        const state = await api('/state');
        setData(state);
        setSelection(state.selection);
        setRepo(state.config.repo || '');
        setBranch(state.config.branch || 'main');
        setWorkdir(state.config.workdir || '');
        return state;
      }, []);

      React.useEffect(() => {
        setBusy('load');
        load()
          .catch((err) => setError(err.message))
          .finally(() => setBusy(null));
      }, [load]);

      React.useEffect(() => {
        setBackupPreview(null);
      }, [selection]);

      React.useEffect(() => {
        if (toast === null) return undefined;
        const timer = setTimeout(() => setToast(null), 6000);
        return () => clearTimeout(timer);
      }, [toast]);

      React.useEffect(() => {
        if (tab !== 'history' || data === null) return;
        setHistoryLoading(true);
        api('/history')
          .then((result) => setCommits(result.commits || []))
          .catch((err) => setError(err.message))
          .finally(() => setHistoryLoading(false));
      }, [tab, data?.config?.repo]);

      const run = async (label, fn) => {
        setBusy(label);
        setError('');
        try {
          const result = await fn();
          return result;
        } catch (err) {
          setError(err.message);
          return null;
        } finally {
          setBusy(null);
        }
      };

      const saveSelection = async () =>
        run('save', async () => {
          const result = await api('/selection', { selection });
          setData(result);
          setSelection(result.selection);
          setToast({ kind: 'ok', text: '勾选已保存' });
        });

      const backup = async () =>
        run('backup', async () => {
          await api('/selection', { selection });
          const result = await api('/backup', { selection, message });
          await load();
          setToast({
            kind: 'ok',
            text: result.commit
              ? `已备份 ${result.totals.files} 个文件，提交 ${result.commit.slice(0, 8)}${result.pushed ? '（已推送）' : '（仅本地）'}${result.archivedWorkdir ? `；旧工作目录已移到 ${result.archivedWorkdir}` : ''}`
              : '内容没有变化，未产生新提交',
          });
        });

      const previewBackup = async () =>
        run('preview-backup', async () => {
          const result = await api('/preview-backup', { selection });
          setBackupPreview(result);
        });

      const inspectItem = async (item) => {
        setInspect({ title: item.label, loading: true });
        try {
          const data = await api('/file-preview', { itemId: item.id });
          setInspect({ title: item.label, data });
        } catch (err) {
          setInspect({ title: item.label, error: err.message });
        }
      };

      const inspectFile = async (filePath) => {
        const current = inspect;
        if (!current?.data) return;
        setInspect({ ...current, loading: true });
        try {
          const data = await api('/file-preview', {
            itemId: `${current.data.root}:${current.data.path}`,
            file: filePath,
          });
          setInspect({ ...current, loading: false, data });
        } catch (err) {
          setInspect({ ...current, loading: false, error: err.message });
        }
      };

      const previewRestore = async (sha) => {
        const selectedCommit = sha ?? commit;
        await run('preview', async () => {
          const result = await api('/restore', {
            commit: selectedCommit || undefined,
            confirm: false,
            prune,
            force,
          });
          setKeepLocal([]);
          setPreview(result);
        });
      };

      const toggleKeepLocal = (key) => {
        setKeepLocal((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
      };

      const confirmRestore = async () =>
        run('restore', async () => {
          const result = await api('/restore', {
            commit: commit || preview?.commit || undefined,
            confirm: true,
            prune,
            force,
            keepLocal,
          });
          setPreview(result);
          await load();
          setToast({ kind: 'ok', text: '还原完成。插件清单有变化时，请退出 DSH 后执行 dsh plugin --profile desktop install，再启动。' });
        });

      const saveSettings = async () =>
        run('settings', async () => {
          const result = await api('/settings', { repo, branch, workdir });
          setData(result);
          setSelection(result.selection);
          setToast({ kind: 'ok', text: '配置已保存' });
        });

      const selectHistory = async (sha) => {
        setCommit(sha);
        setTab('restore');
        await previewRestore(sha);
      };

      return h(
        'div',
        { className: 'dgb' },
        h(
          'div',
          { className: 'dgb-header' },
          h(
            'div',
            null,
            h('h2', { className: 'dgb-title' }, 'Git 备份'),
            h('p', { className: 'dgb-sub' }, '选择要备份的插件清单、配置和技能，推送到 Git 仓库；需要时一键还原。'),
          ),
          h(StatusBar, { data }),
        ),
        error ? h('div', { className: 'dgb-banner', 'data-kind': 'error' }, error) : null,
        data && data.manifestError
          ? h(
              'div',
              { className: 'dgb-banner', 'data-kind': 'warn' },
              data.manifestError,
              h('div', { style: { marginTop: 6 } }, '如果目标仓库现在是空仓库，直接点“立即备份”会自动归档旧工作目录并重建。'),
            )
          : null,
        toast ? h('div', { className: 'dgb-banner', 'data-kind': toast.kind }, toast.text) : null,
        !data
          ? h('p', { className: 'dgb-muted' }, busy === 'load' ? '正在读取…' : '没有状态')
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'dgb-tabs' },
                ...[
                  ['assets', '备份内容'],
                  ['restore', '还原'],
                  ['history', '历史'],
                  ['settings', '设置'],
                ].map(([id, label]) => h('button', { key: id, className: 'dgb-tab', 'data-active': String(tab === id), onClick: () => setTab(id) }, label)),
              ),
              tab === 'assets'
                ? h(AssetsTab, { data, selection, setSelection, busy, onSave: saveSelection, onPreview: previewBackup, onBackup: backup, preview: backupPreview, onInspect: inspectItem, message, setMessage })
                : null,
              tab === 'restore'
                ? h(RestoreTab, { data, preview, busy, prune, setPrune, force, setForce, keepLocal, onToggleKeep: toggleKeepLocal, onPreview: () => previewRestore(), onRestore: confirmRestore, commit, setCommit })
                : null,
              tab === 'history' ? h(HistoryTab, { commits, loading: historyLoading, onSelect: selectHistory }) : null,
              tab === 'settings'
                ? h(SettingsTab, { data, repo, setRepo, branch, setBranch, workdir, setWorkdir, onSave: saveSettings, busy })
                : null,
            ),
        h(InspectModal, { inspect, onClose: () => setInspect(null), onFile: inspectFile }),
      );
    }

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error, info) {
        console.error('[dsh-git-backup] panel crashed:', error, info);
      }
      render() {
        if (this.state.error) {
          const error = this.state.error;
          return h(
            'div',
            { className: 'dgb' },
            h('h2', { className: 'dgb-title' }, 'Git 备份'),
            h('div', { className: 'dgb-banner', 'data-kind': 'error' }, `面板渲染失败：${error && error.message ? error.message : String(error)}`),
            h('pre', { className: 'dgb-preview-code' }, error && error.stack ? error.stack : ''),
          );
        }
        return this.props.children;
      }
    }

    function SafeGitBackupSection(props) {
      return h(PanelBoundary, null, h(GitBackupSection, props));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyles();
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: PANEL_ID,
                order: 55,
                label: PANEL_LABEL,
              },
              SafeGitBackupSection,
            ),
          );
        } catch (error) {
          console.warn('[dsh-git-backup] settings section registration failed:', error);
        }
        try {
          ctx.slots.inject('plugins.detail.section', () =>
            ctx.slots.register(
              {
                name: 'plugins.detail.section',
                id: 'git-backup-detail',
                order: 1,
              },
              SafeGitBackupSection,
            ),
          );
        } catch (error) {
          console.warn('[dsh-git-backup] plugin detail section registration failed:', error);
        }
      },
      __internals: { PANEL_ID, PANEL_LABEL, API, itemChecked, toggleModuleSelection, toggleGroupSelection, toggleItemSelection, ALL_SELECTION },
    };
  },
});
