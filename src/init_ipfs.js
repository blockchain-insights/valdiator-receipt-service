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

async function createIdentity(keyPair, keystoreDir) {  // Add keystoreDir parameter
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const polkaKeys = keyring.addPair(keyPair);

  const id = polkaKeys.address;
  // Create instance-specific keystore
  const keystore = new Keystore(keystoreDir);
  const key = await keystore.getKey(id) || await keystore.createKey(id);

  const idSignature = await keystore.sign(key, id);
  const polkaSignature = polkaKeys.sign(idSignature);

  const identity = await Identities.createIdentity({
    type: 'Polkadot',
    id,
    keystore,
    polkaSignature,
    polkaKeys
  });

  return identity;
}

const { signatureVerify } = require('@polkadot/util-crypto')
class PolkadotIdentityProvider {
  constructor(options) {
    this.id = options.id;
    this.polkaKeys = options.polkaKeys;
    this.idSignature = options.idSignature;
    this.publicKey = u8aToHex(options.polkaKeys.publicKey);
  }

  getId() {
    return this.id;
  }

  async signIdentity(data) {
    const signature = this.polkaKeys.sign(data);
    return u8aToHex(signature);
  }

  static get type() {
    return 'Polkadot';
  }

  static async verifyIdentity(identity) {
    try {
      const { id, signatures } = identity;

      // If any required field is missing, return false instead of throwing
      if (!signatures || !signatures.id || !id) {
        logger.warn('Missing required identity fields for verification');
        return false;
      }

      // Ensure we have proper hex format
      const publicKey = signatures.publicKey.startsWith('0x') ?
          signatures.publicKey :
          `0x${signatures.publicKey}`;

      const signature = signatures.id.startsWith('0x') ?
          signatures.id :
          `0x${signatures.id}`;

      const { isValid } = signatureVerify(
          signature,
          publicKey,
          id
      );

      return isValid;
    } catch (error) {
      // Log error but don't throw
      logger.warn('Identity verification failed:', error.message);
      return false;
    }
  }
}
Identities.addIdentityProvider(PolkadotIdentityProvider)

class GuestDatabaseInitializer{
  constructor(privateKey, ports = {}) {
    this.ipfs = null;
    this.orbitdb = null;
    this.eventlog = null;
    this.privateKey = privateKey;
    this.ports = {
      swarm: ports.swarm || 4002,
      api: ports.api || 5002,
      gateway: ports.gateway || 9090
    };

    if (!this.privateKey) {
      throw new Error('Admin private key is required. Set ADMIN_PRIVATE_KEY in .env or provide as argument');
    }

    this.privateKey = this.privateKey.replace('0x', '');

    if (this.privateKey.length > 64) {
      logger.info('Converting extended key to 32-byte seed...');
      this.privateKey = blake2AsHex(this.privateKey).slice(2);
    }

    this.seed = hexToU8a('0x' + this.privateKey);
  }
}

export class OwnerDatabaseInitializer {
  constructor(privateKey,
              ports = {
                  swarm: 4002,
                  api: 5002,
                  gateway: 9090
                },
              options = {
                accessController: {
                  type: 'ipfs',
                  write: [this.orbitdb.identity.id]
                }
              }) {

    this.ipfs = null;
    this.orbitdb = null;
    this.eventlog = null;
    this.privateKey = privateKey.replace('0x', '');
    this.databaseAddress = null;
    this.ports = ports
    this.options = options

    if (this.privateKey.length > 64) {
      logger.info('Converting extended key to 32-byte seed...');
      this.privateKey = blake2AsHex(this.privateKey).slice(2);
    }

    this.seed = hexToU8a('0x' + this.privateKey);
  }

  async initialize() {
    try {
      await cryptoWaitReady();
      this.keyring = new Keyring({ type: 'sr25519' });
      this.adminKey = this.keyring.addFromSeed(this.seed);

      const baseDir = path.join(process.cwd(), 'data', this.adminKey.address);
      this.directories = {
        ipfs: path.join(baseDir, 'ipfs'),
        orbitdb: path.join(baseDir, 'orbitdb'),
        keystore: path.join(baseDir, 'keystore')
      };

      for (const dir of Object.values(this.directories)) {
        await fs.mkdir(dir, { recursive: true });
      }

      logger.info(`Initializing with admin address: ${this.adminKey.address}`);
      logger.info(`Admin public key: ${u8aToHex(this.adminKey.publicKey)}`);

      await this.initializeIPFS();
      await this.initializeOrbitDB(this.databaseAddress);

      this.databaseAddress = this.eventlog?.address.toString();
      return this.databaseAddress
    } catch (error) {
      logger.error('Failed to initialize OrbitDB:', error);
      throw error;
    }
  }

  async initializeIPFS() {
    logger.info('Starting IPFS node...');

    this.ipfs = await IPFS.create({
      repo: this.directories.ipfs,
      config: {
        Addresses: {
          Swarm: [
            `/ip4/0.0.0.0/tcp/${this.ports.swarm}`,
            `/ip4/0.0.0.0/tcp/${this.ports.swarm + 1}/ws`
          ],
          API: `/ip4/0.0.0.0/tcp/${this.ports.api}`,
          Gateway: `/ip4/0.0.0.0/tcp/${this.ports.gateway}`
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

    const id = await this.ipfs.id();
    logger.info(`IPFS node started with ID: ${id.id}`);
  }

  async initializeOrbitDB() {
    logger.info('Initializing OrbitDB...');

    const identity = await createIdentity(this.adminKey, this.directories.keystore);
    const options = {
      directory: this.directories.orbitdb,
      identity
    };

    logger.info('OrbitDB options:', options);
    this.orbitdb = await OrbitDB.createInstance(this.ipfs, options);
    logger.info('Created OrbitDB instance with identity:', this.orbitdb.identity.id);

    if (this.databaseAddress) {
      logger.info('Opening existing database...');
      this.eventlog = await this.orbitdb.eventlog(this.databaseAddress, this.options);
      logger.info(`Opened existing database: ${this.databaseAddress}`);
    } else {
      logger.info('Creating new database...');
      this.eventlog = await this.orbitdb.eventlog('eventlog', this.options);
      logger.info(`Created new database: ${this.eventlog.address.toString()}`);
    }

    await this.eventlog.load();
  }

  async close() {
    logger.info('Closing connections...');
    if (this.eventlog) await this.eventlog.close();
    if (this.orbitdb) await this.orbitdb.disconnect();
    if (this.ipfs) await this.ipfs.stop();
    logger.info('All connections closed');
  }
}


