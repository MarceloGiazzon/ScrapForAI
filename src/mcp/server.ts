import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { domInspectionRequestSchema } from '../schemas/domInspectionRequest.schema.js';
import { explorationRequestSchema } from '../schemas/explorationRequest.schema.js';
import { inspectDom, runExploration, ScrapForAiRequestError } from './client.js';

const server = new McpServer(
  { name: 'scrapforai', version: '1.0.0' },
  {
    instructions:
      'Tools for driving and inspecting allowlisted web pages through the ScrapForAI Playwright runner. ' +
      'Call inspect_dom first to discover forms/controls/selectors on a page, then use those selectors to ' +
      'author a run_exploration routine. Target URLs must be on the ScrapForAI server allowlist or every ' +
      'call will fail with TargetUrlNotAllowed.',
  },
);

function toToolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function toErrorResult(error: unknown) {
  const text =
    error instanceof ScrapForAiRequestError
      ? `${error.type}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Unknown error calling ScrapForAI';

  return { isError: true, content: [{ type: 'text' as const, text }] };
}

server.registerTool(
  'inspect_dom',
  {
    title: 'Inspect DOM',
    description:
      'Navigate to an allowlisted URL and return its forms, controls, selectors, labels, and (optionally) ' +
      'console/network evidence, without performing any actions. Use this to discover what is on a page ' +
      'before writing a run_exploration routine.',
    inputSchema: domInspectionRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      return toToolResult(await inspectDom(args));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

server.registerTool(
  'run_exploration',
  {
    title: 'Run exploration routine',
    description:
      'Execute a multi-step browser automation routine (goto, click, fill, assert*, extractText, evaluate, ' +
      'watch, etc.) against an allowlisted target URL and return structured step results, extracted data, ' +
      'and evidence (screenshots, console, network, optional trace).',
    inputSchema: explorationRequestSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      return toToolResult(await runExploration(args));
    } catch (error) {
      return toErrorResult(error);
    }
  },
);

try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (error) {
  console.error('ScrapForAI MCP server failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
}
