// src/config/index.js
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default {
  grpc: {
    host: process.env.GRPC_HOST || '0.0.0.0',
    port: process.env.GRPC_PORT || 50051
  },
  ipfs: {
    repo: process.env.IPFS_REPO || './ipfs',
    start: true,
    EXPERIMENTAL: {
      pubsub: true
    }
  },
  orbitdb: {
    directory: process.env.ORBITDB_DIR || './orbitdb',
    dbName: process.env.ORBITDB_NAME || 'service.events'
  }
};
