import * as core from '@actions/core';
import { resolve } from 'path';
import { create_scaffold } from '../generators/scaffold.js';
import { sync_metadata } from '../core/metadata/sync.js';
import { check_links } from '../core/links/checker.js';
import { check_documentation, count_actionable_issues } from '../core/audit/auditor.js';
import { run_maintenance } from '../core/maintain/orchestrator.js';
import { discover_patterns } from '../core/discover/patterns.js';
import { discover_anti_patterns } from '../core/discover/antipatterns.js';
import { discover_standards } from '../core/discover/standards.js';
import { discover_dependencies } from '../core/discover/dependencies.js';

async function run_action(): Promise<void> {
  try {
    // Get inputs
    const command = core.getInput('command', { required: true });
    const mode = core.getInput('mode') || 'quick';
    const docs_path = resolve(process.cwd(), core.getInput('docs-path') || '.documentation');
    const domain = core.getInput('domain') || undefined;
    const discover_type = core.getInput('discover-type') || 'patterns';
    const fail_on_error = core.getInput('fail-on-error') === 'true';
    const fail_threshold = parseInt(core.getInput('fail-threshold') || '50', 10);

    core.info(`Running command: ${command}`);
    core.info(`Documentation path: ${docs_path}`);
    core.info(`Mode: ${mode}`);

    let health_score = 100;
    let total_documents = 0;
    let issues_found = 0;
    let issues_fixed = 0;
    let broken_links = 0;
    let metadata_compliance = 100;
    let report_path = '';

    switch (command) {
      case 'init': {
        core.info('Initializing documentation structure...');
        const result = await create_scaffold({
          root_path: docs_path,
          overwrite: false,
          silent: false,
        });

        if (!result.success) {
          throw new Error(`Init failed: ${result.errors.join(', ')}`);
        }

        core.info(`Created ${result.created.length} files/directories`);
        break;
      }

      case 'maintain': {
        core.info('Running maintenance...');
        const result = await run_maintenance({
          docs_path,
          quick: mode === 'quick',
          fix: mode === 'fix',
          silent: false,
        });

        health_score = result.health_score;
        total_documents = result.metadata_sync?.total_files ?? 0;
        issues_found = count_actionable_issues(result.audit?.issues ?? []);
        issues_fixed = result.metadata_sync?.fixed_files ?? 0;
        broken_links = result.link_check?.broken_links.length ?? 0;
        metadata_compliance = result.audit?.stats.metadataCompliance ?? 100;
        report_path = result.report_path ?? '';

        if (result.errors.length > 0) {
          core.warning(`Maintenance completed with errors: ${result.errors.join(', ')}`);
        }
        break;
      }

      case 'metadata-sync': {
        core.info('Syncing metadata...');
        const result = await sync_metadata({
          docs_path,
          ...(domain ? { domain } : {}),
          fix: mode === 'fix',
          dry_run: mode !== 'fix',
          silent: false,
        });

        total_documents = result.total_files;
        issues_found = result.errors.length;
        issues_fixed = result.fixed_files;
        metadata_compliance = result.stats.avg_completeness;
        break;
      }

      case 'link-check': {
        core.info('Checking links...');
        const result = await check_links({
          docs_path,
          ...(domain ? { domain } : {}),
          silent: false,
        });

        total_documents = result.total_files;
        broken_links = result.broken_links.length;
        issues_found = broken_links;

        if (broken_links > 0) {
          core.warning(`Found ${broken_links} broken links`);
          for (const link of result.broken_links.slice(0, 10)) {
            core.warning(`  ${link.sourceFile}:${link.lineNumber} -> ${link.targetPath}`);
          }
        }
        break;
      }

      case 'audit': {
        core.info('Auditing documentation...');
        const result = await check_documentation({
          docs_path,
          ...(domain ? { domain } : {}),
          silent: false,
        });

        health_score = result.health_score;
        total_documents = result.total_files;
        issues_found = count_actionable_issues(result.issues);
        metadata_compliance = result.stats.metadataCompliance;

        const errors = result.issues.filter((i) => i.severity === 'error');
        if (errors.length > 0) {
          core.warning(`Found ${errors.length} critical issues`);
        }
        break;
      }

      case 'discover': {
        core.info(`Discovering ${discover_type}...`);

        switch (discover_type) {
          case 'patterns':
            await discover_patterns({ root_path: process.cwd(), silent: false });
            break;
          case 'anti-patterns':
            await discover_anti_patterns({ root_path: process.cwd(), silent: false });
            break;
          case 'standards':
            await discover_standards({ root_path: process.cwd(), silent: false });
            break;
          case 'dependencies':
            await discover_dependencies({ root_path: process.cwd(), silent: false });
            break;
          default:
            throw new Error(`Unknown discover type: ${discover_type}`);
        }
        break;
      }

      default:
        throw new Error(`Unknown command: ${command}`);
    }

    // Set outputs
    core.setOutput('health-score', health_score.toString());
    core.setOutput('total-documents', total_documents.toString());
    core.setOutput('issues-found', issues_found.toString());
    core.setOutput('issues-fixed', issues_fixed.toString());
    core.setOutput('broken-links', broken_links.toString());
    core.setOutput('metadata-compliance', metadata_compliance.toFixed(1));
    core.setOutput('report-path', report_path);

    // Check fail conditions
    if (fail_on_error) {
      if (health_score < fail_threshold) {
        core.setFailed(`Health score ${health_score.toFixed(1)} is below threshold ${fail_threshold}`);
        return;
      }

      if (broken_links > 0) {
        core.setFailed(`Found ${broken_links} broken links`);
        return;
      }

      const critical_issues = issues_found;
      if (critical_issues > 0 && mode !== 'fix') {
        core.setFailed(`Found ${critical_issues} issues that need attention`);
        return;
      }
    }

    core.info('Command completed successfully!');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
}

run_action();
