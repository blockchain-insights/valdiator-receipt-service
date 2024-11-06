import * as IPFS from 'ipfs-core';
import OrbitDB from 'orbit-db';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { u8aToHex, hexToU8a } from '@polkadot/util';
import { blake2AsHex } from '@polkadot/util-crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';
import dotenv from 'dotenv';
import { createRequire } from 'module';
import Identities from "orbit-db-identity-provider";
import {OwnerDatabaseInitializer} from "./init_ipfs.js";
import {createIdentity, PolkadotIdentityProvider} from "./identity.js";

const require = createRequire(import.meta.url);
const Keystore = require('orbit-db-keystore');

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const logger = winston.createLogger({
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
    try {
        await cryptoWaitReady()

        // === Private Key ===
        let privateKey = process.env.ADMIN_PRIVATE_KEY
        privateKey = privateKey.replace('0x', '')
        if (privateKey.length > 64) {
            logger.info('Converting extended key to 32-byte seed...');
            privateKey = blake2AsHex(privateKey).slice(2);
        }
        const seed = hexToU8a('0x' + privateKey);
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
            swarm: 4002,
            api: 5002,
            gateway: 9090
        }

        const ipfs = await IPFS.create({
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
            identity
        };
        const dbOptions = {
            directory: directories.orbitdb,
            identity,
        };
        const orbitdb = await OrbitDB.createInstance(ipfs, dbOptions);

        // TODO: call api here to query validator addresses, and give them write access to receipt event log
        const accessController = {
            type: 'ipfs',
            write: [
                orbitdb.identity.id,
            ]
        }

        let eventlog = null
        let databaseAddress = process.env.DATA_BASE_ADDRESS || null
        if (databaseAddress) {
            eventlog = await orbitdb.eventlog(databaseAddress, {accessController});
        } else {
            eventlog = await orbitdb.eventlog('receipts', {accessController});
            databaseAddress = eventlog.address.toString()
        }

        await eventlog.load();
        logger.info("Database address: ", databaseAddress)

        process.on('SIGINT', () => shutdown(ipfs, orbitdb, eventlog));
        process.on('SIGTERM', () => shutdown(ipfs, orbitdb, eventlog));

        logger.info('System is running. Press Ctrl+C to shut down.');

        setInterval(async () => {
            try {
                const entry = {
                    timestamp: Date.now(),
                    message: "Test message",
                    data: Math.random()
                };

                const hash = await eventlog.add(entry);
                logger.info('Written new entry:', { hash, entry });
            } catch (error) {
                logger.error('Error writing entry:', error);
            }
        }, 5000);

        await new Promise(() => {});


    } catch (error) {
        logger.error('Error:', error);
        process.exit(1);
    }
};

if (import.meta.url.startsWith('file:')) {
    const modulePath = fileURLToPath(import.meta.url);
    if (process.argv[1] === modulePath) {
        main().catch(console.error);
    }
}
