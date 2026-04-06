// SPDX-License-Identifier: Hippocratic-3.0
import { buildApp } from './app.ts';

async function main() {
  const app = await buildApp();
  const address = await app.listen({
    port: app.config.port,
    host: app.config.host,
  });
  app.log.info(`Babelr server listening at ${address}`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
