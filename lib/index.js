/**
 * DSH host half of dsh-git-backup.
 *
 * It reuses the CLI core in ../src and exposes the same operations as agent
 * tools. The plugin is deliberately inert when the tool service is absent: a
 * backup helper must never prevent a DSH profile from booting.
 */
import { join } from 'node:path';
import { runBackup } from '../src/backup.js';
import { saveSelection } from '../src/config.js';
import { gitLog } from '../src/repo.js';
import { runRestore } from '../src/restore.js';
import { runStatus } from '../src/status.js';
import { pathExists } from '../src/util.js';
import {
  MODULES,
  errorResult,
  lossless,
  makeCoreContext,
  renderJson,
  requireRepo,
  selectionFromArgs,
} from './context.js';
import { registerRoutes } from './routes.js';

export const name = 'dsh-git-backup';
export const inject = [];

function buildTools() {
  return [
    {
      name: 'dsh_git_backup_status',
      description:
        'Show dsh-git-backup status: repository, profile, local asset counts, differences against the checked-out snapshot, and credential files that were filtered out. Read-only.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: renderJson },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      execute: async () => {
        try {
          const core = await makeCoreContext();
          const status = await runStatus(core);
          return lossless({
            ok: true,
            repo: status.repo,
            branch: status.branch,
            profile: status.profile,
            local: status.local,
            snapshot: status.manifest,
            counts: status.counts,
            credentials: status.credentials,
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    },
    {
      name: 'dsh_git_backup_backup',
      description:
        'Back up the selected DSH skills, plugin manifests and config files to the configured Git repository. Optionally pass modules / exclude lists; these override the saved selection for this call only. This may commit and push.',
      parameters: {
        type: 'object',
        properties: {
          modules: { type: 'array', items: { type: 'string', enum: MODULES }, description: 'Modules to include, e.g. ["skills","config"].' },
          excludeSkills: { type: 'array', items: { type: 'string' }, description: 'Skill directory names to exclude.' },
          excludePlugins: { type: 'array', items: { type: 'string' }, description: 'Plugin manifest file names to exclude, e.g. ["pnpm-lock.yaml"].' },
          excludeConfig: { type: 'array', items: { type: 'string' }, description: 'Config file ids to exclude, e.g. ["dsh:AGENTS.md"].' },
          message: { type: 'string', description: 'Optional commit message.' },
          noPush: { type: 'boolean', description: 'Commit to the local worktree without pushing.' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: renderJson },
      timeoutMs: 300_000,
      isConcurrencySafe: () => false,
      execute: async (args) => {
        try {
          const core = await makeCoreContext();
          requireRepo(core);
          core.selection = selectionFromArgs(args, core.selection);
          const result = await runBackup(core, {
            noPush: args?.noPush === true,
            message: typeof args?.message === 'string' && args.message.trim() !== '' ? args.message.trim() : undefined,
          });
          return lossless({
            ok: true,
            commit: result.commit,
            pushed: result.pushed,
            repo: result.remote,
            branch: result.branch,
            totals: result.manifest.totals,
            modules: result.manifest.modules,
            excludedCount: result.excludedCount,
            credentials: result.credentials,
            warnings: result.warnings,
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    },
    {
      name: 'dsh_git_backup_restore',
      description:
        'Restore DSH assets from the Git backup. Without confirm=true it only previews the plan. With confirm=true it snapshots the current local assets first, then writes files and (unless noInstall) runs dsh plugin install.',
      parameters: {
        type: 'object',
        properties: {
          commit: { type: 'string', description: 'History commit to restore; defaults to the newest remote commit.' },
          confirm: { type: 'boolean', description: 'Execute the restore. Omit or false to preview only.' },
          prune: { type: 'boolean', description: 'Delete local skill files that are absent from the backup.' },
          keepLocal: {
            type: 'array',
            items: { type: 'string' },
            description: 'Conflict ids (root:path) whose local version should win and be skipped during restore.',
          },
          noInstall: { type: 'boolean', description: 'Do not run dsh plugin install after restoring files.' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: renderJson },
      timeoutMs: 900_000,
      isConcurrencySafe: () => false,
      execute: async (args) => {
        try {
          const core = await makeCoreContext();
          requireRepo(core);
          const preview = await runRestore(core, {
            commit: typeof args?.commit === 'string' && args.commit.trim() !== '' ? args.commit.trim() : undefined,
            dryRun: args?.confirm !== true,
            prune: args?.prune === true,
            keepLocal: Array.isArray(args?.keepLocal) ? args.keepLocal.filter((value) => typeof value === 'string') : [],
            noInstall: args?.noInstall === true,
          });
          return lossless({
            ok: true,
            dryRun: preview.dryRun,
            commit: preview.commit,
            profile: preview.manifest.profile,
            createdAt: preview.manifest.createdAt,
            counts: preview.plan.counts,
            actions: preview.plan.actions.map((a) => ({
              status: a.status,
              module: a.module,
              root: a.root,
              path: a.path,
            })),
            extras: preview.plan.extras.map((e) => ({ root: e.root, path: e.path })),
            keptLocal: preview.keptLocal,
            snapshot: preview.snapshot?.dir ?? null,
            installed: preview.installed,
            hint: args?.confirm === true ? undefined : 'Review the plan, then call again with confirm: true.',
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    },
    {
      name: 'dsh_git_backup_history',
      description: 'List recent dsh-git-backup commits (hash, time, subject). Read-only.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Number of commits, default 10.' } },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: renderJson },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      execute: async (args) => {
        try {
          const core = await makeCoreContext();
          requireRepo(core);
          if (!(await pathExists(join(core.workdir, '.git')))) throw new Error(`本地还没有工作副本: ${core.workdir}`);
          const limit = Number.isFinite(args?.limit) ? Math.min(200, Math.max(1, Math.round(args.limit))) : 10;
          return lossless({ ok: true, commits: gitLog({ workdir: core.workdir, limit }) });
        } catch (error) {
          return errorResult(error);
        }
      },
    },
    {
      name: 'dsh_git_backup_selection',
      description:
        'Read or save which assets dsh-git-backup includes. Omit modules to read the current saved selection; pass modules and/or exclude lists to save a new selection.',
      parameters: {
        type: 'object',
        properties: {
          modules: { type: 'array', items: { type: 'string', enum: MODULES }, description: 'Modules to include.' },
          excludeSkills: { type: 'array', items: { type: 'string' } },
          excludePlugins: { type: 'array', items: { type: 'string' } },
          excludeConfig: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: renderJson },
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      execute: async (args) => {
        try {
          const core = await makeCoreContext();
          const hasUpdate = Array.isArray(args?.modules) || Array.isArray(args?.excludeSkills) || Array.isArray(args?.excludePlugins) || Array.isArray(args?.excludeConfig);
          if (!hasUpdate) return lossless({ ok: true, selection: core.selection });
          const selection = selectionFromArgs(args, core.selection);
          await saveSelection(selection);
          return lossless({ ok: true, saved: true, selection });
        } catch (error) {
          return errorResult(error);
        }
      },
    },
  ];
}

function registerTools(hostCtx) {
  const tools = hostCtx.get('tools');
  if (tools === undefined || typeof tools.register !== 'function') {
    hostCtx.logger?.warn?.('[dsh-git-backup] tools service unavailable; agent tools not registered');
    return () => undefined;
  }
  const disposers = [];
  for (const definition of buildTools()) {
    try {
      disposers.push(tools.register(definition));
    } catch (error) {
      hostCtx.logger?.error?.(`[dsh-git-backup] failed to register ${definition.name}: ${error?.message ?? error}`);
    }
  }
  hostCtx.logger?.info?.(`[dsh-git-backup] registered ${disposers.length} agent tools`);
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        void dispose();
      } catch {
        // owned by the plugin fiber
      }
    }
  };
}

export function apply(ctx) {
  try {
    ctx.inject(['tools'], (scoped) => registerTools(scoped));
    ctx.inject(['connection'], (scoped) => registerRoutes(scoped));
    ctx.logger?.info?.('[dsh-git-backup] loaded');
  } catch (error) {
    // Never throw during profile boot.
    try {
      ctx.logger?.error?.(`[dsh-git-backup] load failed: ${error?.message ?? error}`);
    } catch {
      // nothing left to report to
    }
  }
}
