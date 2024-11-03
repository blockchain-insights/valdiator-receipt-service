import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MigrationService {
  constructor(postgresService) {
    this.postgresService = postgresService;
    this.migrationsPath = path.join(__dirname, '../migrations');
  }

  async initialize() {
    const client = await this.postgresService.pool.connect();
    try {
      await this.createMigrationsTable(client);
      await this.runPendingMigrations(client);
    } finally {
      client.release();
    }
  }

  async createMigrationsTable(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${process.env.POSTGRES_SCHEMA}.migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  async runPendingMigrations(client) {
    const files = await fs.readdir(this.migrationsPath);
    const migrations = files
      .filter(f => f.endsWith('.js'))
      .sort();

    const executedMigrations = await this.getExecutedMigrations(client);

    for (const migration of migrations) {
      if (!executedMigrations.includes(migration)) {
        await this.runMigration(client, migration);
      }
    }
  }

  async getExecutedMigrations(client) {
    const result = await client.query(
      'SELECT name FROM ${process.env.POSTGRES_SCHEMA}.migrations'
    );
    return result.rows.map(row => row.name);
  }

  async runMigration(client, migrationFile) {
    const migration = await import(path.join(this.migrationsPath, migrationFile));
    
    await client.query('BEGIN');
    try {
      await migration.up(client);
      await client.query(
        'INSERT INTO ${process.env.POSTGRES_SCHEMA}.migrations (name) VALUES ($1)',
        [migrationFile]
      );
      await client.query('COMMIT');
      logger.info(`Migration executed: ${migrationFile}`);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Migration failed: ${migrationFile}`, error);
      throw error;
    }
  }
}