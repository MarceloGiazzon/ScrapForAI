/**
 * Version of the `--json` contract (see schemas/cliOutput.schema.ts). Lives in its own file so the CLI can
 * import it WITHOUT loading the schemas, which load the server configuration: a broken .env must be
 * reported as a clean exit 2, not crash the process while it is still importing.
 */
export const CLI_SCHEMA_VERSION = 1;
