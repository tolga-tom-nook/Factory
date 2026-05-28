#!/usr/bin/env node
import { relative, resolve } from 'path';
import { validateBriefDirectory } from './brief-contract.js';

function parseArgs(argv) {
  const args = { command: argv[2], briefDir: '', strict: false, json: false, briefKeys: [] };
  for (let i = 3; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--strict') args.strict = true;
    else if (value === '--json') args.json = true;
    else if (value === '--brief-key') {
      args.briefKeys.push(argv[i + 1] || '');
      i += 1;
    } else if (value.startsWith('--brief-key=')) {
      args.briefKeys.push(value.slice('--brief-key='.length));
    }
    else if (value === '--brief-dir') {
      args.briefDir = argv[i + 1] || '';
      i += 1;
    } else if (value.startsWith('--brief-dir=')) {
      args.briefDir = value.slice('--brief-dir='.length);
    }
  }
  return args;
}

function printUsage() {
  console.log([
    'Usage:',
    '  node src/cli.js validate-briefs --brief-dir <path> [--brief-key <key>] [--strict] [--json]',
    '',
    'Examples:',
    '  node src/cli.js validate-briefs --brief-dir ../video-studio/content-briefs/prime-self',
    '  node src/cli.js validate-briefs --brief-dir ../video-studio/content-briefs/prime-self --strict',
  ].join('\n'));
}

function printTextReport(summary, root) {
  console.log(`Media Room brief readiness: ${summary.ready}/${summary.checked} ready, ${summary.blocked} blocked`);
  for (const result of summary.results) {
    const status = result.status === 'ready' ? 'READY' : 'BLOCKED';
    const file = relative(root, result.file);
    console.log(`\n[${status}] ${result.briefKey} (${result.composition})`);
    console.log(`  file: ${file}`);
    console.log(`  words: ${result.scriptWords || 'generated'} | duration: ${result.durationSeconds}s | min: ${result.minimumDurationSeconds || 'n/a'}s`);
    console.log(`  visuals: steps=${result.renderPlan.steps.length}, beats=${result.renderPlan.visualBeats.length}, screenshots=${result.renderPlan.screenshotUrls.length}, chapters=${result.renderPlan.chapters.length}`);
    for (const issue of result.issues) {
      console.log(`  ${issue.severity.toUpperCase()}: ${issue.code} - ${issue.message}`);
    }
  }
}

const args = parseArgs(process.argv);

if (args.command !== 'validate-briefs' || !args.briefDir) {
  printUsage();
  process.exit(args.command ? 1 : 0);
}

const root = process.cwd();
const briefDir = resolve(root, args.briefDir);
const summary = validateBriefDirectory(briefDir, {
  strict: args.strict,
  briefKeys: args.briefKeys.filter(Boolean),
});

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printTextReport(summary, root);
}

if (args.strict && summary.blockers.length > 0) {
  process.exit(1);
}
