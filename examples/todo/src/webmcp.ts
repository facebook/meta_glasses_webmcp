/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Tool publishing: the seam where agent tools meet their host.
//
// Registrations fan out to whatever host surfaces exist — a page-owned
// `globalThis.__webmcp` registry, or a `modelContext` on document/navigator —
// and when none exists yet, an in-page `__webmcp` surface is installed with
// the standard shape (`registerTool`/`unregisterTool`/`listTools`/
// `getTools`/`callTool` plus `toolchange` events) so hosts arriving later,
// DevTools, and tests all see the same tools. The module holds that contract
// locally, with zero runtime dependencies.

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

/** Public snapshot of a tool: everything except the handler. */
export interface PublicTool {
  name: string;
  description: string;
  parameters: ToolInputSchema;
  annotations?: ToolAnnotations;
}

interface HostSurface {
  registerTool?: (tool: { name: string; description: string; parameters: ToolInputSchema; handler: unknown }) => void;
  unregisterTool?: (name: string) => void;
}

interface ModelContext {
  registerTool?: (tool: unknown, options?: unknown) => void;
  unregisterTool?: (name: string) => void;
}

const tools = new Map<string, ToolDefinition>();
const listeners = new Set<() => void>();
// The surface we installed, if we installed one. Ownership is checked by
// identity rather than a flag: a host can replace __webmcp at any time, and a
// stale flag would hide every tool from it.
let ourSurface: HostSurface | null = null;
// The foreign surface we have already replayed the tool set into.
let syncedHost: HostSurface | null = null;

/** The current host-owned surface, or null when the surface is ours. */
function hostSurface(): HostSurface | null {
  const surface = (globalThis as { __webmcp?: HostSurface }).__webmcp;
  if (!surface || surface === ourSurface) return null;
  return typeof surface.registerTool === 'function' ? surface : null;
}

function modelContexts(): ModelContext[] {
  const scope = globalThis as {
    document?: { modelContext?: ModelContext };
    navigator?: { modelContext?: ModelContext };
  };
  // The May 2026 draft moved the getter to Document. Navigator is read only
  // for hosts that predate it: polyfills warn on that read, and may expose
  // one context on both, which would register every tool twice.
  const ctx = scope.document?.modelContext ?? scope.navigator?.modelContext;
  return ctx == null ? [] : [ctx];
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

function toPublic(def: ToolDefinition): PublicTool {
  const snapshot: PublicTool = {
    name: def.name,
    description: def.description,
    parameters: JSON.parse(JSON.stringify(def.inputSchema)) as ToolInputSchema,
  };
  if (def.annotations !== undefined) snapshot.annotations = { ...def.annotations };
  return snapshot;
}

function emitChange(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* listener errors must not break registration */
    }
  }
  const surface = (globalThis as { __webmcp?: { dispatchEvent?: (event: unknown) => void } }).__webmcp;
  try {
    // A standard EventTarget rejects a plain object, so send a real Event.
    surface?.dispatchEvent?.(new Event('toolchange'));
  } catch {
    /* event delivery is best-effort */
  }
}

/** The in-page surface, created on first registration when no host owns one. */
function ensureSurface(): void {
  const scope = globalThis as { __webmcp?: HostSurface };
  if (scope.__webmcp && typeof scope.__webmcp.registerTool === 'function') return;
  const surface: HostSurface & {
    listTools: () => PublicTool[];
    getTools: () => PublicTool[];
    callTool: (name: string, args: unknown) => Promise<unknown>;
    addEventListener: (type: string, fn: () => void) => void;
    removeEventListener: (type: string, fn: () => void) => void;
    dispatchEvent: () => boolean;
  } = {
    registerTool(def) {
      if (!def || typeof def.name !== 'string' || def.name === '') {
        throw new Error('Tool name must be a non-empty string.');
      }
      if ([...tools.values()].some((entry) => entry.name === def.name)) {
        throw new Error(`Tool "${def.name}" is already registered.`);
      }
      if (typeof def.handler !== 'function') {
        throw new Error(`Tool "${def.name}" needs a handler.`);
      }
      tools.set(def.name, {
        name: def.name,
        description: def.description,
        inputSchema: def.parameters,
        execute: def.handler as ToolDefinition['execute'],
      });
      emitChange();
    },
    unregisterTool(name) {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('Tool name must be a non-empty string.');
      }
      if (tools.delete(name)) emitChange();
    },
    listTools() {
      return [...tools.values()].map(toPublic);
    },
    getTools() {
      return [...tools.values()].map(toPublic);
    },
    async callTool(name, args) {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('Tool name must be a non-empty string.');
      }
      const def = tools.get(name);
      if (!def) throw new Error(`Tool "${name}" is not registered.`);
      const missing = (def.inputSchema.required ?? []).filter(
        (key) => (args as Record<string, unknown> | null)?.[key] == null,
      );
      if (missing.length > 0) {
        return failure(`Tool "${name}" is missing required input: ${missing.join(', ')}.`);
      }
      return runHandler(name, def, args);
    },
    addEventListener(_type, fn) {
      listeners.add(fn);
    },
    removeEventListener(_type, fn) {
      listeners.delete(fn);
    },
    dispatchEvent() {
      return true;
    },
  };
  scope.__webmcp = surface;
  ourSurface = surface;
}

function registerOnHost(host: HostSurface, def: ToolDefinition): void {
  try {
    host.registerTool?.({
      name: def.name,
      description: def.description,
      parameters: def.inputSchema,
      handler: def.execute,
    });
  } catch {
    /* host handoff is best-effort */
  }
}

function publishOutward(def: ToolDefinition): void {
  ensureSurface();
  // A host-owned surface gets the translated entry; the in-page surface
  // already wraps the same map, so it needs nothing more.
  const host = hostSurface();
  if (host) {
    if (host === syncedHost) {
      registerOnHost(host, def);
    } else {
      // A host that arrived after earlier registrations has seen none of
      // them, so replay the whole set instead of just this one.
      syncedHost = host;
      for (const entry of tools.values()) registerOnHost(host, entry);
    }
  }
  for (const ctx of modelContexts()) {
    if (typeof ctx.registerTool !== 'function') continue;
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
}

function unpublishOutward(name: string): void {
  const host = hostSurface();
  if (host && typeof host.unregisterTool === 'function') {
    try {
      host.unregisterTool(name);
    } catch {
      /* host handoff is best-effort */
    }
  }
  // Unregister wherever register reached, or the tool outlives it on a host.
  for (const ctx of modelContexts()) {
    if (typeof ctx.unregisterTool !== 'function') continue;
    try {
      ctx.unregisterTool(name);
    } catch {
      /* host handoff is best-effort */
    }
  }
}

/** Publish a tool on every available surface. Returns an unregister function. */
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
  publishOutward(def);
  emitChange();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (tools.get(def.name) === def) tools.delete(def.name);
    unpublishOutward(def.name);
    emitChange();
  };
}

/** Every locally registered tool, in registration order. */
export function getTools(): ToolDefinition[] {
  return [...tools.values()];
}

/** Drop all local registrations and the in-page surface, if it is ours. */
export function clearTools(): void {
  tools.clear();
  listeners.clear();
  const scope = globalThis as { __webmcp?: unknown };
  if (ourSurface !== null && scope.__webmcp === ourSurface) delete scope.__webmcp;
  ourSurface = null;
  syncedHost = null;
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
