// src/services/postgres.service.js
import pkg from 'pg';
const { Pool } = pkg;
import config from '../config/postgres.config.js';
import logger from '../utils/logger.js';

class PostgresService {
  constructor() {
    this.pool = new Pool(config);
  }

  async initialize() {
    try {
      await this.createSchema();
      logger.info('PostgreSQL service initialized');
    } catch (error) {
      logger.error('Failed to initialize PostgreSQL:', error);
      throw error;
    }
  }

  async createSchema() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${config.schema}.${config.table} (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          timestamp BIGINT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
    } finally {
      client.release();
    }
  }

  async upsertEvent(event) {
    const client = await this.pool.connect();
    try {
      const query = `
        INSERT INTO ${config.schema}.${config.table} (id, data, timestamp)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO UPDATE
        SET data = EXCLUDED.data,
            timestamp = EXCLUDED.timestamp;
      `;
      const values = [event.id, event.data, event.timestamp];
      await client.query(query, values);
      logger.info(`Upserted event with ID: ${event.id}`);
    } catch (error) {
      logger.error(`Failed to upsert event ${event.id}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  async beginTransaction() {
    this.client = await this.pool.connect();
    await this.client.query('BEGIN');
  }

  async commitTransaction() {
    await this.client.query('COMMIT');
    this.client.release();
  }

  async rollbackTransaction() {
    await this.client.query('ROLLBACK');
    this.client.release();
  }

  async saveMetrics(metrics) {
    const query = `
      INSERT INTO ${process.env.POSTGRES_SCHEMA}.event_sync_metrics
      (timestamp, total_events, synced_events, failed_events, 
       retry_count, avg_sync_time, batch_size, last_synced_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;
    
    const values = [
      metrics.timestamp,
      metrics.total_events,
      metrics.synced_events,
      metrics.failed_events,
      metrics.retry_count,
      metrics.avg_sync_time,
      metrics.batch_size,
      metrics.last_synced_hash
    ];

    await this.pool.query(query, values);
  }
}

export default new PostgresService();