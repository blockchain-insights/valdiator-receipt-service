import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const up = async (client) => {
  const sql = await fs.readFile(
    path.join(__dirname, 'sql/20240103001_initial_schema.sql'),
    'utf-8'
  );
  await client.query(sql);
};

export const down = async (client) => {
  await client.query(`
    DROP TABLE IF EXISTS ${process.env.POSTGRES_SCHEMA}.events;
    DROP TABLE IF EXISTS ${process.env.POSTGRES_SCHEMA}.event_sync_metrics;
    DROP TABLE IF EXISTS ${process.env.POSTGRES_SCHEMA}.migrations;
  `);
};