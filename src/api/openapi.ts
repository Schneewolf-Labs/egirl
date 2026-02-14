/**
 * OpenAPI 3.1.0 specification for the egirl API.
 *
 * This is a static spec object — no codegen, no runtime schema compilation.
 * Hand-maintained because the API surface is small and stable.
 */

export interface OpenAPISpec {
  openapi: string
  info: { title: string; version: string; description: string }
  servers: Array<{ url: string; description: string }>
  paths: Record<string, unknown>
  components: { schemas: Record<string, unknown> }
}

export function buildOpenAPISpec(host: string, port: number): OpenAPISpec {
  return {
    openapi: '3.1.0',
    info: {
      title: 'egirl API',
      version: '0.1.0',
      description:
        'HTTP API for the egirl local-first AI agent. Send messages, manage memory, execute tools, and check system status.',
    },
    servers: [{ url: `http://${host}:${port}`, description: 'Local server' }],
    paths: {
      '/health': {
        get: {
          operationId: 'healthCheck',
          summary: 'Health check',
          tags: ['System'],
          responses: {
            '200': {
              description: 'Server is running',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } },
              },
            },
          },
        },
      },
      '/openapi.json': {
        get: {
          operationId: 'getOpenAPISpec',
          summary: 'OpenAPI specification',
          tags: ['System'],
          responses: {
            '200': {
              description: 'OpenAPI 3.1.0 spec',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/v1/chat': {
        post: {
          operationId: 'chat',
          summary: 'Send a message to the agent',
          description:
            'Sends a user message through the agent loop. The agent may use tools, escalate to a remote provider, and return a final response.',
          tags: ['Chat'],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'Agent response',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } },
              },
            },
            '400': {
              description: 'Invalid request',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
              },
            },
          },
        },
      },
      '/v1/tools': {
        get: {
          operationId: 'listTools',
          summary: 'List available tools',
          tags: ['Tools'],
          responses: {
            '200': {
              description: 'List of tool definitions',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ToolListResponse' } },
              },
            },
          },
        },
      },
      '/v1/tools/{name}/execute': {
        post: {
          operationId: 'executeTool',
          summary: 'Execute a tool directly',
          tags: ['Tools'],
          parameters: [
            {
              name: 'name',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Tool name',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ToolExecuteRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'Tool execution result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ToolExecuteResponse' },
                },
              },
            },
            '404': {
              description: 'Tool not found',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
              },
            },
          },
        },
      },
      '/v1/memory/{key}': {
        get: {
          operationId: 'getMemory',
          summary: 'Get a memory by key',
          tags: ['Memory'],
          parameters: [
            {
              name: 'key',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Memory key',
            },
          ],
          responses: {
            '200': {
              description: 'Memory value',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/MemoryResponse' } },
              },
            },
            '404': {
              description: 'Memory not found',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
              },
            },
            '503': {
              description: 'Memory system not initialized',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
              },
            },
          },
        },
        put: {
          operationId: 'setMemory',
          summary: 'Store a memory',
          tags: ['Memory'],
          parameters: [
            {
              name: 'key',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Memory key',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MemorySetRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'Memory stored',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
              },
            },
            '503': {
              description: 'Memory system not initialized',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
              },
            },
          },
        },
        delete: {
          operationId: 'deleteMemory',
          summary: 'Delete a memory',
          tags: ['Memory'],
          parameters: [
            {
              name: 'key',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Memory key',
            },
          ],
          responses: {
            '200': {
              description: 'Deletion result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/MemoryDeleteResponse' },
                },
              },
            },
            '503': {
              description: 'Memory system not initialized',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
              },
            },
          },
        },
      },
      '/v1/memory/search': {
        post: {
          operationId: 'searchMemory',
          summary: 'Search memories',
          tags: ['Memory'],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MemorySearchRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'Search results',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/MemorySearchResponse' },
                },
              },
            },
            '503': {
              description: 'Memory system not initialized',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
              },
            },
          },
        },
      },
      '/v1/status': {
        get: {
          operationId: 'getStatus',
          summary: 'System status',
          description:
            'Returns current configuration, provider status, and session usage statistics.',
          tags: ['System'],
          responses: {
            '200': {
              description: 'System status',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/StatusResponse' } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        ErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string' },
          },
        },
        SuccessResponse: {
          type: 'object',
          required: ['success'],
          properties: {
            success: { type: 'boolean' },
          },
        },
        HealthResponse: {
          type: 'object',
          required: ['status', 'uptime'],
          properties: {
            status: { type: 'string', enum: ['ok'] },
            uptime: { type: 'number', description: 'Uptime in seconds' },
          },
        },
        ChatRequest: {
          type: 'object',
          required: ['message'],
          properties: {
            message: { type: 'string', description: 'User message to send to the agent' },
            max_turns: {
              type: 'integer',
              description: 'Maximum agent turns (default 10)',
              default: 10,
            },
          },
        },
        ChatResponse: {
          type: 'object',
          required: ['content', 'target', 'provider', 'usage', 'escalated', 'turns'],
          properties: {
            content: { type: 'string', description: 'Agent response text' },
            target: { type: 'string', enum: ['local', 'remote'] },
            provider: {
              type: 'string',
              description: 'Provider name used (e.g. llamacpp/qwen3-vl-32b)',
            },
            usage: {
              type: 'object',
              properties: {
                input_tokens: { type: 'integer' },
                output_tokens: { type: 'integer' },
              },
            },
            escalated: {
              type: 'boolean',
              description: 'Whether the request was escalated to a remote provider',
            },
            turns: { type: 'integer', description: 'Number of agent loop turns used' },
          },
        },
        ToolDefinition: {
          type: 'object',
          required: ['name', 'description', 'parameters'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            parameters: { type: 'object', description: 'JSON Schema for tool parameters' },
          },
        },
        ToolListResponse: {
          type: 'object',
          required: ['tools'],
          properties: {
            tools: { type: 'array', items: { $ref: '#/components/schemas/ToolDefinition' } },
          },
        },
        ToolExecuteRequest: {
          type: 'object',
          properties: {
            arguments: { type: 'object', description: 'Tool arguments', default: {} },
            cwd: { type: 'string', description: 'Working directory for tool execution' },
          },
        },
        ToolExecuteResponse: {
          type: 'object',
          required: ['success', 'output'],
          properties: {
            success: { type: 'boolean' },
            output: { type: 'string' },
          },
        },
        MemoryResponse: {
          type: 'object',
          required: ['key', 'value'],
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
            imagePath: { type: 'string' },
          },
        },
        MemorySetRequest: {
          type: 'object',
          required: ['value'],
          properties: {
            value: { type: 'string', description: 'Memory value to store' },
          },
        },
        MemoryDeleteResponse: {
          type: 'object',
          required: ['deleted'],
          properties: {
            deleted: { type: 'boolean' },
          },
        },
        MemorySearchRequest: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Search query' },
            mode: {
              type: 'string',
              enum: ['text', 'semantic', 'hybrid'],
              default: 'hybrid',
              description: 'Search mode',
            },
            limit: { type: 'integer', default: 10, description: 'Maximum number of results' },
          },
        },
        MemorySearchResponse: {
          type: 'object',
          required: ['results'],
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                required: ['key', 'value', 'score', 'matchType'],
                properties: {
                  key: { type: 'string' },
                  value: { type: 'string' },
                  score: { type: 'number' },
                  matchType: { type: 'string', enum: ['fts', 'vector', 'hybrid'] },
                },
              },
            },
          },
        },
        StatusResponse: {
          type: 'object',
          required: ['config', 'providers', 'stats'],
          properties: {
            config: {
              type: 'object',
              properties: {
                workspace: { type: 'string' },
                localModel: { type: 'string' },
                localEndpoint: { type: 'string' },
                routingDefault: { type: 'string', enum: ['local', 'remote'] },
                escalationThreshold: { type: 'number' },
                hasRemoteAnthropic: { type: 'boolean' },
                hasRemoteOpenAI: { type: 'boolean' },
                hasEmbeddings: { type: 'boolean' },
                hasMemory: { type: 'boolean' },
              },
            },
            providers: {
              type: 'object',
              properties: {
                local: { type: 'string' },
                remote: { type: 'string', nullable: true },
              },
            },
            stats: {
              type: 'object',
              properties: {
                totalRequests: { type: 'integer' },
                localRequests: { type: 'integer' },
                remoteRequests: { type: 'integer' },
                escalations: { type: 'integer' },
                totalInputTokens: { type: 'integer' },
                totalOutputTokens: { type: 'integer' },
                totalCost: { type: 'number' },
                savedCost: { type: 'number' },
              },
            },
          },
        },
      },
    },
  }
}
