// src/services/db.service.js
import IPFS from 'ipfs';
import OrbitDB from 'orbit-db';
import config from '../config/index.js';
import logger from '../utils/logger.js';

class DBService {
  constructor() {
    this.ipfs = null;
    this.orbitdb = null;
    this.eventlog = null;
  }

  async initialize() {
    try {
      this.ipfs = await IPFS.create(config.ipfs);
      this.orbitdb = await OrbitDB.createInstance(this.ipfs, { directory: config.orbitdb.directory });
      this.eventlog = await this.orbitdb.eventlog(config.orbitdb.dbName);
      await this.eventlog.load();
      
      logger.info(`EventLog initialized at: ${this.eventlog.address.toString()}`);
      return this.eventlog;
    } catch (error) {
      logger.error('Failed to initialize database:', error);
      throw error;
    }
  }

  async close() {
    if (this.orbitdb) await this.orbitdb.disconnect();
    if (this.ipfs) await this.ipfs.stop();
  }
}

export default new DBService();