import * as IPFS from 'ipfs-core';
import OrbitDB from 'orbit-db';
import winston from 'winston';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs/promises';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        new winston.transports.File({
            filename: 'events.log',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            )
        })
    ]
});

const shutdown = async (ipfs, orbitdb, eventlog) => {
    logger.info('Shutting down...');
    try {
        if (eventlog) {
            logger.info('Closing eventlog database...');
            await eventlog.close();
        }

        if (orbitdb) {
            logger.info('Closing OrbitDB instance...');
            await orbitdb.disconnect();
        }

        if (ipfs) {
            logger.info('Stopping IPFS node...');
            await ipfs.stop();
        }

        logger.info('Shutdown complete');
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
    }
};

const main = async () => {
    let ipfs = null;
    let orbitdb = null;
    let eventlog = null;

    try {
        // Check for required environment variables
        const databaseAddress = process.env.DATA_BASE_ADDRESS;
        if (!databaseAddress) {
            logger.error('DATA_BASE_ADDRESS environment variable is required');
            return;
        }

        // Generate unique directory names based on ports to allow multiple instances
        const ports = {
            swarm: 4003,
            api: 5003,
            gateway: 9091
        };

        // Setup storage directories
        const baseDir = path.join(process.cwd(), 'data', `listener_${ports.swarm}`);
        const directories = {
            ipfs: path.join(baseDir, 'ipfs'),
            orbitdb: path.join(baseDir, 'orbitdb')
        };

        // Create directories
        for (const dir of Object.values(directories)) {
            await fs.mkdir(dir, { recursive: true });
        }

        // Initialize IPFS with custom ports
        logger.info('Starting IPFS node...', { ports });
        ipfs = await IPFS.create({
            repo: directories.ipfs,
            config: {
                Addresses: {
                    Swarm: [
                        `/ip4/0.0.0.0/tcp/${ports.swarm}`,
                        `/ip4/0.0.0.0/tcp/${ports.swarm + 1}/ws`
                    ],
                    API: `/ip4/0.0.0.0/tcp/${ports.api}`,
                    Gateway: `/ip4/0.0.0.0/tcp/${ports.gateway}`
                },
                API: {
                    HTTPHeaders: {
                        "Access-Control-Allow-Origin": ["*"]
                    }
                }
            },
            start: true,
            EXPERIMENTAL: { pubsub: true }
        });

        const id = await ipfs.id();
        logger.info('IPFS node started', { peerId: id.id });

        // Initialize OrbitDB
        logger.info('Initializing OrbitDB...');
        orbitdb = await OrbitDB.createInstance(ipfs, {
            directory: directories.orbitdb
        });

        // Connect to the existing database
        logger.info('Connecting to database...', { address: databaseAddress });
        eventlog = await orbitdb.open(databaseAddress);

        // Load the database
        await eventlog.load();

        // Get and log existing entries
        const entries = await eventlog.iterator({ limit: -1 }).collect();
        logger.info('Current database entries:', {
            count: entries.length,
            latest: entries.slice(-5) // Show last 5 entries
        });

        // Subscribe to new database updates
        eventlog.events.on('replicated', (address) => {
            logger.info('Database replicated', { address });
        });

        eventlog.events.on('replicate.progress', (address, hash, entry, progress, total) => {
            logger.info('Replication progress', {
                address,
                hash,
                entry: entry.payload.value,
                progress,
                total
            });
        });

        eventlog.events.on('write', (address, entry, heads) => {
            logger.info('New entry written', {
                address,
                hash: entry.hash,
                data: entry.payload.value
            });
        });

        // Set up signal handlers for graceful shutdown
        process.on('SIGINT', () => shutdown(ipfs, orbitdb, eventlog));
        process.on('SIGTERM', () => shutdown(ipfs, orbitdb, eventlog));

        logger.info('Listener is running. Press Ctrl+C to shut down.');
        await new Promise(() => {}); // Wait indefinitely

    } catch (error) {
        logger.error('Error:', error);
        await shutdown(ipfs, orbitdb, eventlog);
    }
};

if (import.meta.url.startsWith('file:')) {
    const modulePath = fileURLToPath(import.meta.url);
    if (process.argv[1] === modulePath) {
        main().catch(async (error) => {
            logger.error('Unhandled error:', error);
            process.exit(1);
        });
    }
}