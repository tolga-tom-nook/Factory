import type { Template } from './load';

/**
 * Fill template slot placeholders from an input context. Phase 1: literal
 * substitution plus deterministic field extraction from the description.
 */
export interface ParameterizedPlan {
  template_id: string;
  tier: 'green' | 'yellow' | 'red';
  steps: Array<{
    tool: string;
    slots: Record<string, unknown>;
    side_effects: 'none' | 'read-external' | 'write-app' | 'write-external';
  }>;
  audit: {
    matched_description: string;
    source: string;
    parameterized_at: number;
    extracted_slots?: Record<string, unknown>;
  };
}

type SlotAwareTemplate = Template & {
  slot_names?: string[];
  slot_validators?: Record<string, string>;
  slot_defaults?: Record<string, unknown>;
};

export function parameterize(
  template: Template,
  ctx: { description: string; source: string },
): ParameterizedPlan {
  const extractedSlots = extractSlots(template as SlotAwareTemplate, ctx.description);
  const steps = (template.steps ?? []).map((step) => ({
    tool: step.tool,
    slots: literalFill(step.slots ?? {}, ctx, extractedSlots) as Record<string, unknown>,
    side_effects: step.side_effects ?? 'none',
  }));
  return {
    template_id: template.id,
    tier: template.tier,
    steps,
    audit: {
      matched_description: ctx.description,
      source: ctx.source,
      parameterized_at: Date.now(),
      extracted_slots: extractedSlots,
    },
  };
}

function literalFill(
  value: unknown,
  ctx: { description: string; source: string },
  slots: Record<string, unknown>,
): unknown {
  if (Array.isArray(value)) return value.map((item) => literalFill(item, ctx, slots));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, literalFill(inner, ctx, slots)]),
    );
  }
  if (typeof value !== 'string') return value;

  const exactSlot = value.match(/^\$slots\.(\w+)$/);
  if (exactSlot) return slots[exactSlot[1]!] ?? value;

  return value
    .replace(/\{\{description\}\}/g, ctx.description)
    .replace(/\{\{source\}\}/g, ctx.source)
    .replace(/\$slots\.(\w+)/g, (match, name: string) => String(slots[name] ?? match));
}

function extractSlots(template: SlotAwareTemplate, description: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(template.slot_defaults ?? {}) };
  const names = new Set([
    ...(template.slot_names ?? []),
    ...Object.keys(template.slot_validators ?? {}),
    ...slotNamesFromSteps(template),
  ]);

  setIfPresent(out, names, 'target_path', field(description, ['target_path', 'path']));
  setIfPresent(out, names, 'branch_name', field(description, ['branch_name', 'branch']));
  setIfPresent(out, names, 'commit_message', field(description, ['commit_message', 'title']));
  setIfPresent(out, names, 'scope', field(description, ['scope']));
  setIfPresent(out, names, 'doc_body', bodyField(description, ['doc_body', 'content', 'body']));

  if (names.has('parent_dir') && typeof out.target_path === 'string' && typeof out.parent_dir !== 'string') {
    const parts = out.target_path.split('/');
    parts.pop();
    out.parent_dir = parts.join('/') || 'docs';
  }

  if (names.has('scope') && typeof out.scope !== 'string') {
    out.scope = 'general';
  }

  for (const [name, pattern] of Object.entries(template.slot_validators ?? {})) {
    if (typeof out[name] !== 'string') continue;
    try {
      if (!new RegExp(pattern).test(out[name] as string)) delete out[name];
    } catch {
      delete out[name];
    }
  }

  return out;
}


function slotNamesFromSteps(template: Template): string[] {
  const names = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\$slots\.(\w+)/g)) names.add(match[1]!);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(visit);
  };
  for (const step of template.steps ?? []) visit(step.slots ?? {});
  return [...names];
}

function setIfPresent(out: Record<string, unknown>, names: Set<string>, name: string, value: string | null): void {
  if (names.has(name) && value !== null && value !== '') out[name] = value;
}

function field(description: string, aliases: string[]): string | null {
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = description.match(new RegExp('(?:^|[;\\n])\\s*' + escaped + '\\s*[:=]\\s*([^;\\n]+)', 'i'));
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function bodyField(description: string, aliases: string[]): string | null {
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = description.match(new RegExp('(?:^|[;\\n])\\s*' + escaped + '\\s*[:=]\\s*([\\s\\S]+)$', 'i'));
    if (match?.[1]) return match[1].trim();
  }
  return null;
}
