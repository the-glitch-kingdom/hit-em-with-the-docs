import * as core from '@actions/core';
import { resolve } from 'path';
import { createScaffold } from '../generators/scaffold.js';
import { syncMetadata } from '../core/metadata/sync.js';
import { checkLinks } from '../core/links/checker.js';
import { auditDocumentation, countActionableIssues } from '../core/audit/auditor.js';
import { runMaintenance } from '../core/maintain/orchestrator.js';
import { discoverPatterns } from '../core/discover/patterns.js';
import { discoverAntiPatterns } from '../core/discover/antipatterns.js';
import { discoverStandards } from '../core/discover/standards.js';
import { analyzeDependencies } from '../core/discover/dependencies.js';

async function run(): Promise<void> {
  try {
    // Get inputs
    const command = core.getInput('command', { required: true });
    const mode = core.getInput('mode') || 'quick';
    const docsPath = resolve(process.cwd(), core.getInput('docs-path') || '.documentation');
    const domain = core.getInput('domain') || undefined;
    const discoverType = core.getInput('discover-type') || 'patterns';
    const failOnError = core.getInput('fail-on-error') === 'true';
    const failThreshold = parseInt(core.getInput('fail-threshold') || '50', 10);

    core.info(`Running command: ${command}`);
    core.info(`Documentation path: ${docsPath}`);
    core.info(`Mode: ${mode}`);

    let healthScore = 100;
    let totalDocuments = 0;
    let issuesFound = 0;
    let issuesFixed = 0;
    let brokenLinks = 0;
    let metadataCompliance = 100;
    let reportPath = '';

    switch (command) {
      case 'init': {
        core.info('Initializing documentation structure...');
        const result = await createScaffold({
          rootPath: docsPath,
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
        const result = await runMaintenance({
          docsPath,
          quick: mode === 'quick',
          fix: mode === 'fix',
          silent: false,
        });

        healthScore = result.healthScore;
        totalDocuments = result.metadataSync?.totalFiles ?? 0;
        issuesFound = countActionableIssues(result.audit?.issues ?? []);
        issuesFixed = result.metadataSync?.fixedFiles ?? 0;
        brokenLinks = result.linkCheck?.brokenLinks.length ?? 0;
        metadataCompliance = result.audit?.stats.metadataCompliance ?? 100;
        reportPath = result.reportPath ?? '';

        if (result.errors.length > 0) {
          core.warning(`Maintenance completed with errors: ${result.errors.join(', ')}`);
        }
        break;
      }

      case 'metadata-sync': {
        core.info('Syncing metadata...');
        const result = await syncMetadata({
          docsPath,
          ...(domain ? { domain } : {}),
          fix: mode === 'fix',
          dryRun: mode !== 'fix',
          silent: false,
        });

        totalDocuments = result.totalFiles;
        issuesFound = result.errors.length;
        issuesFixed = result.fixedFiles;
        metadataCompliance = result.stats.avgCompleteness;
        break;
      }

      case 'link-check': {
        core.info('Checking links...');
        const result = await checkLinks({
          docsPath,
          ...(domain ? { domain } : {}),
          silent: false,
        });

        totalDocuments = result.totalFiles;
        brokenLinks = result.brokenLinks.length;
        issuesFound = brokenLinks;

        if (brokenLinks > 0) {
          core.warning(`Found ${brokenLinks} broken links`);
          for (const link of result.brokenLinks.slice(0, 10)) {
            core.warning(`  ${link.sourceFile}:${link.lineNumber} -> ${link.targetPath}`);
          }
        }
        break;
      }

      case 'audit': {
        core.info('Auditing documentation...');
        const result = await auditDocumentation({
          docsPath,
          ...(domain ? { domain } : {}),
          silent: false,
        });

        healthScore = result.healthScore;
        totalDocuments = result.totalFiles;
        issuesFound = countActionableIssues(result.issues);
        metadataCompliance = result.stats.metadataCompliance;

        const errors = result.issues.filter((i) => i.severity === 'error');
        if (errors.length > 0) {
          core.warning(`Found ${errors.length} critical issues`);
        }
        break;
      }

      case 'discover': {
        core.info(`Discovering ${discoverType}...`);

        switch (discoverType) {
          case 'patterns':
            await discoverPatterns({ rootPath: process.cwd(), silent: false });
            break;
          case 'anti-patterns':
            await discoverAntiPatterns({ rootPath: process.cwd(), silent: false });
            break;
          case 'standards':
            await discoverStandards({ rootPath: process.cwd(), silent: false });
            break;
          case 'dependencies':
            await analyzeDependencies({ rootPath: process.cwd(), silent: false });
            break;
          default:
            throw new Error(`Unknown discover type: ${discoverType}`);
        }
        break;
      }

      default:
        throw new Error(`Unknown command: ${command}`);
    }

    // Set outputs
    core.setOutput('health-score', healthScore.toString());
    core.setOutput('total-documents', totalDocuments.toString());
    core.setOutput('issues-found', issuesFound.toString());
    core.setOutput('issues-fixed', issuesFixed.toString());
    core.setOutput('broken-links', brokenLinks.toString());
    core.setOutput('metadata-compliance', metadataCompliance.toFixed(1));
    core.setOutput('report-path', reportPath);

    // Check fail conditions
    if (failOnError) {
      if (healthScore < failThreshold) {
        core.setFailed(`Health score ${healthScore.toFixed(1)} is below threshold ${failThreshold}`);
        return;
      }

      if (brokenLinks > 0) {
        core.setFailed(`Found ${brokenLinks} broken links`);
        return;
      }

      const criticalIssues = issuesFound;
      if (criticalIssues > 0 && mode !== 'fix') {
        core.setFailed(`Found ${criticalIssues} issues that need attention`);
        return;
      }
    }

    core.info('Command completed successfully!');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
}

run();
