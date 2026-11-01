import type { FastifyInstance } from 'fastify';
import type { AgentGateway } from './gateway.js';
import { toolRegistry } from './registry.js';

export function registerGatewayRest(app: FastifyInstance, gateway: AgentGateway): void {
  for (const tool of toolRegistry) {
    app.get(tool.path, { exposeHeadRoute: false }, async (request, reply) => {
      const params = request.params as Record<string, unknown>;
      const query = request.query as Record<string, unknown>;
      const input: Record<string, unknown> = { ...params };
      let duplicateScope = false;
      for (const [key, value] of Object.entries(query)) {
        // Path scope cannot be overridden by a query-string shop/order ID.
        if (Object.hasOwn(params, key)) duplicateScope = true;
        const field = Object.hasOwn(tool.inputSchema.properties, key) ? tool.inputSchema.properties[key] : undefined;
        input[key] = field?.type === 'integer' && typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
      }
      const result = await gateway.invoke(tool.name, duplicateScope ? undefined : input, request.headers.authorization);
      return reply.code(result.statusCode).send(result.body);
    });
  }
}
