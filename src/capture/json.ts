// Shared by the hook runtime: keep this file free of other imports.
export type JsonObject = Record<string, any>;
export function object(value: unknown): JsonObject { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}; }
