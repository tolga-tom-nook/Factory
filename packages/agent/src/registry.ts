/**
 * Tool registry — the shared seam between the deterministic supervisor planner
 * and the LLM reasoning loop. A tool declares a name, trust `side_effects`, the
 * JWT `required_scope` needed to invoke it, and a pure `invoke` function.
 *
 * This is the canonical home for `Tool` / `ToolRegistry` (extracted down from
 * `apps/supervisor` per the Agent Runtime plan §20). The same registry serves
 * two consumers — the template path (matches a tool by name) and the LLM path
 * (exposes tools with a JSON-Schema `parameters` shape to `complete({ tools })`).
 */

/** Trust classification controlling which tiers may invoke a tool. */
export type SideEffects = 'none' | 'read-external' | 'write-app' | 'write-external';

/** Result of a tool invocation. */
export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string };

export interface Tool {
  /** Fully-qualified name, e.g. "humandesign.admin.users.suspend". */
  name: string;
  description: string;
  side_effects: SideEffects;
  /** JWT scope claim required to invoke. */
  required_scope: string;
  invoke: (slots: Record<string, unknown>) => Promise<ToolResult>;
  /**
   * JSON Schema for the tool's input. Present ⇒ the tool can be offered to an
   * LLM via `complete({ tools })`. Absent ⇒ template-only (planner) tool.
   */
  parameters?: Record<string, unknown>;
  /**
   * Explicit opt-in/out of LLM exposure. Defaults to `true` when `parameters`
   * is present, `false` otherwise. Set `false` to keep a schema'd tool off the
   * LLM surface (template-only).
   */
  exposeToLLM?: boolean;
}

/** Whether a tool should be offered to the LLM. */
export function isLLMExposed(tool: Tool): boolean {
  if (tool.parameters === undefined) return false;
  return tool.exposeToLLM ?? true;
}

export class ToolRegistry {
  private byName = new Map<string, Tool>();
  private byId = new Map<string, Tool>();

  register(tool: Tool, id?: string): void {
    this.byName.set(tool.name, tool);
    // If an ID is provided (for test fixtures), also register by ID.
    if (id) {
      this.byId.set(id, tool);
    }
  }

  get(name: string): Tool | undefined {
    // Try by name first, then by ID.
    return this.byName.get(name) ?? this.byId.get(name);
  }

  list(): Tool[] {
    return Array.from(this.byName.values());
  }

  /**
   * Filter tools by tier trust. The deterministic planner uses this to restrict
   * the tool set based on the Green/Yellow/Red tier of the run.
   */
  byTier(tier: 'green' | 'yellow' | 'red'): Tool[] {
    return this.list().filter((t) => {
      if (tier === 'green') return t.side_effects === 'none' || t.side_effects === 'read-external';
      if (tier === 'yellow') return t.side_effects !== 'write-external';
      return true;
    });
  }

  /**
   * Tools eligible to be offered to an LLM (see {@link isLLMExposed}), optionally
   * intersected with a trust tier. The reasoning loop uses this to build the
   * `tools` array for `complete()`.
   */
  llmTools(tier?: 'green' | 'yellow' | 'red'): Tool[] {
    const base = tier ? this.byTier(tier) : this.list();
    return base.filter(isLLMExposed);
  }
}
