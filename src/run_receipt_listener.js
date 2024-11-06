import * as IPFS from 'ipfs-core';
import OrbitDB from 'orbit-db';
import winston from 'winston';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import Identities from "orbit-db-identity-provider";
import {createIdentity, PolkadotIdentityProvider} from "./identity.js";
import {cryptoWaitReady, mnemonicGenerate, mnemonicToMiniSecret} from "@polkadot/util-crypto";
import {u8aToHex} from "@polkadot/util";
import {Keyring} from "@polkadot/keyring";

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

Identities.addIdentityProvider(PolkadotIdentityProvider)

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
        await cryptoWaitReady()

        const databaseAddress = "/orbitdb/zdpuApW3eKKUNzyeShfBSaH8CnyMRJaVJoyf1g17Xb8V12pxp/receipts4";
        if (!databaseAddress) {
            logger.error('DATA_BASE_ADDRESS environment variable is required');
            return;
        }

        // === Private Key ===
        const mnemonic = mnemonicGenerate();
        const seed = mnemonicToMiniSecret(mnemonic);
        const keyring = new Keyring({ type: 'sr25519' });
        const keyPair = keyring.addFromSeed(seed);

        // === Setup storage directories
        const baseDir = path.join(process.cwd(), 'data', keyPair.address);
        const directories = {
            ipfs: path.join(baseDir, 'ipfs'),
            orbitdb: path.join(baseDir, 'orbitdb'),
            keystore: path.join(baseDir, 'keystore')
        };
        for (const dir of Object.values(directories)) {
            await fs.mkdir(dir, { recursive: true });
        }

        // === IPFS
        const ports = {
            swarm: 4022,
            api: 5022,
            gateway: 9910
        }

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

        // == Initialize OrbitDB ===
        const identity = await createIdentity(keyPair, directories.keystore);
        const options = {
            directory: directories.orbitdb,
            identity,
        };

        orbitdb = await OrbitDB.createInstance(ipfs, options);
        eventlog = await orbitdb.open(databaseAddress);
        await eventlog.load();

        const entries = await eventlog.iterator({ limit: -1 }).collect();
        logger.info('Current database entries:', {
            count: entries.length,
            latest: entries.slice(-5) // Show last 5 entries
        });

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