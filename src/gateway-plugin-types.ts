/**
 * gateway-plugin-types.ts
 *
 * Minimal type stubs for the OpenClaw Gateway Plugin API surface consumed by
 * this extension. Derived from docs.openclaw.ai/tools/plugin.
 *
 * When official types are published as an npm package, this file gets replaced
 * by a direct import from that package.
 */

export interface GatewayPluginApi {
  registerCommand(def: GatewayCommandDef): void;
  registerService(service: GatewayService): void;
}

export interface GatewayCommandDef {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (
    ctx: GatewayCommandContext,
  ) => GatewayCommandResult | Promise<GatewayCommandResult>;
}

export interface GatewayCommandContext {
  senderId: string;
  channel: GatewayChannelRef;
  isAuthorizedSender: boolean;
  args: string;
  commandBody: string;
  config: Record<string, unknown>;
}

/**
 * The gateway provides its own channel object at command invocation time.
 * Intentionally separate from {@link import('./types.js').OpenClawChannel} —
 * the gateway channel only exposes `sendMessage`.
 */
export interface GatewayChannelRef {
  sendMessage(text: string): Promise<void>;
}

export interface GatewayCommandResult {
  text: string;
}

export interface GatewayService {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}
