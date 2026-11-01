import { createHash, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { redact } from '../logging.js';
import { validTime } from '../orders/models.js';
import type { Result } from '../tiktok/client.js';
import type { AgentGrant, ToolOutput } from './contracts.js';
import { definitionFor, validateInput } from './registry.js';
import { GatewayError, errorBody } from './errors.js';
import type { GatewayService } from './service.js';

export interface GatewayReply { statusCode: number; body: Result<ToolOutput> }
export interface GatewayAudit {
  event: 'gateway_read'; agent_id: string | null; shop_id: string | null;
  tool: string | null; parameter_summary: { field_count: number; valid: boolean };
  result: 'OK' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'INTERNAL_ERROR'; status_code: number; duration_ms: number;
}
const identity = /^[A-Za-z0-9_-]{1,128}$/;
const digest = (value: string) => createHash('sha256').update(value).digest();

/** One entry point for every transport. Grants are trusted local configuration,
 * never accepted from request parameters. Defaults grant access to nobody.
 */
export class AgentGateway {
  private readonly grants: Array<Omit<AgentGrant, 'bearer_token'> & { hash: Buffer }>;
  constructor(private readonly service: GatewayService, agents: readonly AgentGrant[] = [],
    private readonly options: { now?: () => number; audit?: (record: GatewayAudit) => void } = {}) {
    const ids = new Set<string>(), tokens = new Set<string>();
    this.grants = agents.map(agent => {
      if (!identity.test(agent.agent_id) || ids.has(agent.agent_id) || typeof agent.bearer_token !== 'string'
        || !agent.bearer_token.length || /\s/.test(agent.bearer_token) || tokens.has(agent.bearer_token)
        || !Array.isArray(agent.shop_ids) || !agent.shop_ids.every(id => typeof id === 'string' && identity.test(id))
        || !Array.isArray(agent.tools) || !agent.tools.every(name => !!definitionFor(name))) throw new Error('Invalid gateway configuration');
      ids.add(agent.agent_id); tokens.add(agent.bearer_token);
      return { agent_id: agent.agent_id, hash: digest(agent.bearer_token),
        shop_ids: [...new Set(agent.shop_ids)], tools: [...new Set(agent.tools)] };
    });
  }
  async invoke(name: unknown, rawInput: unknown, authorization?: unknown): Promise<GatewayReply> {
    const started = performance.now();
    const definition = definitionFor(name);
    let agent: typeof this.grants[number] | undefined;
    let input: ReturnType<typeof validateInput>;
    let response: GatewayReply = { statusCode: 500, body: errorBody(500) };
    try {
      if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization)) throw new GatewayError(401);
      const hash = digest(authorization.slice(7));
      agent = this.grants.find(grant => timingSafeEqual(grant.hash, hash));
      if (!agent) throw new GatewayError(401);
      if (!definition) throw new GatewayError(404);
      if (!agent.tools.includes(definition.name)) throw new GatewayError(403);
      input = validateInput(definition, rawInput);
      if (!input) throw new GatewayError(400);
      if (!agent.shop_ids.includes(input.shop_id)) throw new GatewayError(403);
      const queried_at = (this.options.now ?? Date.now)();
      if (!validTime(queried_at)) throw new GatewayError(500);
      response = { statusCode: 200, body: { error: false, data: await this.service.run(definition.name, input, queried_at) } };
    } catch (error) {
      const statusCode = error instanceof GatewayError ? error.statusCode : 500;
      response = { statusCode, body: errorBody(statusCode) };
    } finally {
      // Only configuration-backed identifiers and fixed summaries reach logs.
      // Raw parameters, auth headers, response bodies and exceptions never do.
      const record: GatewayAudit = { event: 'gateway_read', agent_id: agent?.agent_id ?? null,
        shop_id: input && agent?.shop_ids.includes(input.shop_id) ? input.shop_id : null,
        tool: definition?.name ?? null, parameter_summary: {
          field_count: input ? Object.keys(input).length : 0, valid: !!input },
        result: response.body.error ? response.body.code as GatewayAudit['result'] : 'OK',
        status_code: response.statusCode, duration_ms: Math.max(0, Math.round(performance.now() - started)) };
      try { this.options.audit?.(redact(record) as GatewayAudit); } catch { /* audit sink failure cannot expose raw data */ }
    }
    return response;
  }
}
