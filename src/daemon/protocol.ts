/**
 * Wire protocol between CLI client and daemon. NDJSON over a unix socket
 * (named pipe on Windows). One request per connection (Playwright's
 * sendAndClose pattern) — no message-id multiplexing needed.
 */

export type Request =
  | { method: "ping"; params: Record<string, never> }
  | { method: "stop"; params: Record<string, never> }
  | { method: "run"; params: RunParams };

export interface RunParams {
  /** Subcommand name (kebab-case): "find-symbol", "references", ... */
  cmd: string;
  /** Subcommand-specific arguments. */
  args: Record<string, unknown>;
  /** Caller's working directory; daemon resolves relative paths against this. */
  cwd: string;
}

export type Response =
  | { ok: true; text: string; exitCode?: number }
  | { ok: false; error: string; exitCode?: number };
