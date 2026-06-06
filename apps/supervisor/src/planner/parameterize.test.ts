import { describe, expect, it } from 'vitest';
import { parameterize } from './parameterize';
import type { Template } from './load';

const description = 'docs: add smoke doc; path: docs/supervisor/aos-green-smoke.md; branch: supervisor/docs/aos-green-smoke; commit_message: docs(supervisor): add aos green smoke doc; content: # AOS Green Smoke';

const docsTemplate: Template = {
  id: 'docs-naming-convention',
  tier: 'green',
  description: 'docs template',
  slot_names: ['target_path', 'parent_dir', 'commit_message', 'doc_body', 'branch_name', 'scope'],
  slot_validators: {
    target_path: '^(docs|documents)/.+\\.md$',
    parent_dir: '^(docs|documents)(/.+)?$',
    commit_message: '^(docs|chore)[(:]',
    doc_body: '^[\\s\\S]{1,200000}$',
    branch_name: '^(supervisor/docs|docs)/[a-z0-9][a-z0-9-]{0,60}$',
    scope: '^(naming|architecture|protocol|policy|readme|runbook|general)$',
  },
  slot_defaults: { scope: 'general' },
  steps: [
    { tool: 'github.readFile', slots: { path: '$slots.parent_dir', ref: 'main' }, side_effects: 'read-external' },
    { tool: 'github.openPR', slots: { branch: '$slots.branch_name', title: '$slots.commit_message', files: [{ path: '$slots.target_path', content: '$slots.doc_body' }] }, side_effects: 'write-external' },
  ],
};

describe('parameterize', () => {
  it('extracts deterministic docs slots and fills nested PR file params', () => {
    const plan = parameterize(docsTemplate, { source: 'test', description });

    expect(plan.audit.extracted_slots).toMatchObject({
      target_path: 'docs/supervisor/aos-green-smoke.md',
      parent_dir: 'docs/supervisor',
      branch_name: 'supervisor/docs/aos-green-smoke',
      commit_message: 'docs(supervisor): add aos green smoke doc',
      doc_body: '# AOS Green Smoke',
      scope: 'general',
    });
    expect(plan.steps[0]?.slots.path).toBe('docs/supervisor');
    expect(plan.steps[1]?.slots).toMatchObject({
      branch: 'supervisor/docs/aos-green-smoke',
      title: 'docs(supervisor): add aos green smoke doc',
      files: [{ path: 'docs/supervisor/aos-green-smoke.md', content: '# AOS Green Smoke' }],
    });
    expect(JSON.stringify(plan)).not.toContain('$slots.');
  });

  it('derives slot names from step placeholders when generated metadata is absent', () => {
    const { slot_names: _slotNames, slot_validators: _validators, ...templateWithoutMetadata } = docsTemplate;
    const plan = parameterize(templateWithoutMetadata, { source: 'test', description });

    expect(plan.audit.extracted_slots).toMatchObject({
      target_path: 'docs/supervisor/aos-green-smoke.md',
      parent_dir: 'docs/supervisor',
      branch_name: 'supervisor/docs/aos-green-smoke',
      commit_message: 'docs(supervisor): add aos green smoke doc',
      doc_body: '# AOS Green Smoke',
      scope: 'general',
    });
    expect(JSON.stringify(plan)).not.toContain('$slots.');
  });
});
