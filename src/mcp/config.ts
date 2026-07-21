import { env } from '../config/env.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function readBaseUrl(): string {
  const override = process.env.SCRAPFORAI_MCP_BASE_URL?.trim();
  const baseUrl = override && override.length > 0 ? override : `http://127.0.0.1:${env.PORT}`;

  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`SCRAPFORAI_MCP_BASE_URL is not a valid URL: "${baseUrl}"`);
  }

  return baseUrl;
}

function readRequestTimeoutMs(): number {
  const raw = process.env.SCRAPFORAI_MCP_REQUEST_TIMEOUT_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REQUEST_TIMEOUT_MS;
}

export const mcpConfig = {
  baseUrl: readBaseUrl(),
  apiKey: env.SCRAPFORAI_API_KEY,
  requestTimeoutMs: readRequestTimeoutMs(),
};
