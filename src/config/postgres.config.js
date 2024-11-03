// src/config/postgres.config.js
export default {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: process.env.POSTGRES_PORT || 5432,
    database: process.env.POSTGRES_DB || 'eventstore',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    schema: process.env.POSTGRES_SCHEMA || 'public',
    table: process.env.POSTGRES_TABLE || 'events'
  };