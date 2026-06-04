# @latimer-woods-tech/agent

Cloudflare-native LLM agent runtime for the Factory platform. One hardened
orchestration engine — tool registry, reasoning loop, memory, guardrails — that
powers the vertical SaaS products (Voice, Video, Astrology).

See [`docs/architecture/AGENT_RUNTIME.md`](../../docs/architecture/AGENT_RUNTIME.md)
for the full design.

## Status

Incremental build (Agent Runtime plan, Phase 2):

- ✅ **Tool registry** — the shared seam between the deterministic supervisor
  planner and the LLM reasoning loop.
- ⏳ Reasoning loop (session Durable Object, step loop, guardrails)
- ⏳ Memory tiers (working / episodic / semantic)
- ⏳ Agent recipes + gateway

## Tool registry

```ts
import { ToolRegistry, type Tool } from '@latimer-woods-tech/agent';

const registry = new ToolRegistry();
registry.register({
  name: 'humandesign.read.blueprint',
  description: 'Fetch a blueprint by id',
  side_effects: 'read-external',
  required_scope: 'read',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  invoke: async (slots) => ({ ok: true, result: await fetchBlueprint(slots.id) }),
});

// Deterministic planner path — match by name, filter by trust tier.
registry.byTier('green');

// LLM path — only schema-bearing, opted-in tools, optionally tier-scoped.
const tools = registry.llmTools('green'); // → pass to @lwt/llm complete({ tools })
```

A tool with `parameters` (JSON Schema) is offered to the LLM by default; omit
`parameters` for a template-only tool, or set `exposeToLLM: false` to keep a
schema'd tool off the LLM surface.
