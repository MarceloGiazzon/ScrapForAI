#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';

import { type CliConfig, runCli } from './cli/runCli.js';

/**
 * Entry point of `scrapforai`. Kept thin: everything testable lives in cli/runCli.ts. The configuration
 * (API key, base URL) is loaded here, lazily, so a broken .env is reported as exit 2 with a message
 * instead of a stack trace, and so `--help` works without one.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const err = (text: string): void => void process.stderr.write(text);
  const out = (text: string): void => void process.stdout.write(text);

  let config: CliConfig;
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    config = { baseUrl: 'http://127.0.0.1:3000', apiKey: '', requestTimeoutMs: 1000 };
  } else {
    try {
      const { mcpConfig } = await import('./mcp/config.js');
      config = { baseUrl: mcpConfig.baseUrl, apiKey: mcpConfig.apiKey, requestTimeoutMs: mcpConfig.requestTimeoutMs };
    } catch (error) {
      const message = `cannot load the configuration (.env): ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
      if (argv.includes('--json')) {
        out(`${JSON.stringify({ cliSchema: 1, command: argv[0] ?? '', exitCode: 2, error: { type: 'ConfigError', message } })}\n`);
      } else {
        err(`error: ConfigError: ${message}\n`);
      }
      return 2;
    }
  }

  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());

  return runCli(argv, config, {
    out,
    err,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    readFile: (file) => readFile(file, 'utf8'),
    writeFile: (file, data) => writeFile(file, data),
    isDirectory: async (file) => (await stat(file).catch(() => undefined))?.isDirectory() === true,
    signal: controller.signal,
  });
}

process.exitCode = await main();
