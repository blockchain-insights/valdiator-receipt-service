// src/migrations/run.js
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import pg from 'pg';
import dotenv from 'dotenv';
import config from '../config/postgres.config.js';
import logger from '../utils/logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigrations() {
  const client = new pg.Client(config);

  try {
    await client.connect();
    logger.info('Connected to PostgreSQL');

    // Create migrations table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${config.schema}.migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Get list of executed migrations
    const { rows: executedMigrations } = await client.query(
      `SELECT name FROM ${config.schema}.migrations ORDER BY id`
    );
    const executedMigrationNames = new Set(executedMigrations.map(row => row.name));

    // Read migration files
    const migrationsDir = join(__dirname, 'sql');
    const files = await fs.readdir(migrationsDir);
    const migrationFiles = files
      .filter(f => f.endsWith('.sql'))
      .sort();

    // Execute new migrations
    for (const file of migrationFiles) {
      if (!executedMigrationNames.has(file)) {
        logger.info(`Running migration: ${file}`);
        
        const migrationSql = await fs.readFile(
          join(migrationsDir, file),
          'utf-8'
        );

        // Replace placeholders with config values
        const sql = migrationSql
          .replace(/\${POSTGRES_SCHEMA}/g, config.schema)
          .replace(/\${POSTGRES_TABLE}/g, config.table);

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            `INSERT INTO ${config.schema}.migrations (name) VALUES ($1)`,
            [file]
          );
          await client.query('COMMIT');
          logger.info(`Migration completed: ${file}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    }

    logger.info('All migrations completed successfully');

  } catch (error) {
    logger.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

async function main() {
    try {
      await runMigrations();
    } catch (error) {
      logger.error('Migration setup failed:', error);
      process.exit(1);
    }
  }
  
  main();