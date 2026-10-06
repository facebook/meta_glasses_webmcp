/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Tool publishing: the seam where agent tools meet their host.
//
// Registrations are held in a local registry and published outward to
// `document.modelContext` when it exists. That is the only host path. The
// module holds the registry locally, with zero runtime dependencies.

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
  execute: (args: any) => unknown | Promise<unknown>;
}

export interface ToolFailure {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

interface ModelContext {
  registerTool?: (tool: unknown, options?: unknown) => void;
  unregisterTool?: (name: string) => void;
}

const tools = new Map<string, ToolDefinition>();

/** The host context, or null when the page has no host yet. */
function modelContext(): ModelContext | null {
  const scope = globalThis as {
    document?: { modelContext?: ModelContext };
  };
  return scope.document?.modelContext ?? null;
}

function failure(text: string): ToolFailure {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Dispatch a handler. A handler that throws on a hostile argument shape still
 * has to come back as a tool error: the contract is that failures are
 * returned, never thrown.
 */
async function runHandler(
  name: string,
  def: ToolDefinition,
  args: unknown,
): Promise<unknown> {
  try {
    return await def.execute(args);
  } catch (error) {
    return failure(`Tool "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function publishToContext(def: ToolDefinition): void {
  const ctx = modelContext();
  if (!ctx || typeof ctx.registerTool !== 'function') return;
  try {
    ctx.registerTool({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations,
      execute: def.execute,
    });
  } catch {
    /* host handoff is best-effort */
  }
}

function unpublishFromContext(name: string): void {
  const ctx = modelContext();
  if (!ctx || typeof ctx.unregisterTool !== 'function') return;
  try {
    ctx.unregisterTool(name);
  } catch {
    /* host handoff is best-effort */
  }
}

/** Publish a tool on `document.modelContext`, when present. Returns an unregister function. */
export function registerTool(def: ToolDefinition): () => void {
  if (!def || typeof def.name !== 'string' || def.name === '') {
    throw new Error('registerTool needs a tool with a name.');
  }
  if (tools.has(def.name)) {
    throw new Error(`Tool "${def.name}" is already registered.`);
  }
  if (typeof def.execute !== 'function') {
    throw new Error(`Tool "${def.name}" needs an execute function.`);
  }
  tools.set(def.name, def);
  publishToContext(def);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (tools.get(def.name) === def) tools.delete(def.name);
    unpublishFromContext(def.name);
  };
}

/** Every locally registered tool, in registration order. */
export function getTools(): ToolDefinition[] {
  return [...tools.values()];
}

/** Drop all local registrations. */
export function clearTools(): void {
  tools.clear();
}

/**
 * Run a tool the way a host would: required inputs are checked first, then
 * the handler runs. Unknown tools throw; everything else resolves to the
 * handler's answer or a failure value.
 */
export async function executeTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const def = tools.get(name);
  if (!def) throw new Error(`Unknown tool "${name}".`);
  const missing = (def.inputSchema.required ?? []).filter((key) => args[key] == null);
  if (missing.length > 0) {
    return failure(`Tool "${name}" is missing required input: ${missing.join(', ')}.`);
  }
  return runHandler(name, def, args);
}
