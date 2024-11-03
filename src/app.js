// src/app.js
import { startGRPCServer } from './grpc/server.js';
import dbService from './services/db.service.js';
import logger from './utils/logger.js';

async function main() {
  try {
    await dbService.initialize();
    await startGRPCServer();
  } catch (error) {
    logger.error('Application failed to start:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  await dbService.close();
  process.exit(0);
});

main();