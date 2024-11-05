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
  constructor (options) {
    this.id = options.id
    this.polkaKeys = options.polkaKeys
    this.idSignature = options.idSignature
  }

  getId () { return this.id }

  async signIdentity (_, options) {
    return options.polkaSignature
  }

  static get type () { return 'Polkadot' }

  static async verifyIdentity (identity) {
    const { id, signatures } = identity
    const { isValid } = signatureVerify(signatures.id, signatures.publicKey, id)
    return isValid
  }
}
Identities.addIdentityProvider(PolkadotIdentityProvider)

class PolkadotAccessController {
  constructor (orbitdb, idProvider, options) {
    this._orbitdb = orbitdb
    this._options = options || {}
    this.idProvider = idProvider
  }

  static get type () { return 'Polkadot' }

  get type () {
    return this.constructor.type
  }

  async canAppend (entry, identityProvider) {
    const orbitIdentity = this._orbitdb.identity
    const entryIdentity = entry.identity
    const verified = await verifyIdentity(entryIdentity)

    if (!verified) return false
    if (orbitIdentity.id !== entryIdentity.id) return false
    if (this._options.write.indexOf(orbitIdentity.id) === -1) return false
    if (!(await identityProvider._keystore.hasKey(entryIdentity.id))) return false

    return true
  }

  static async create (orbitdb, options) {
    return new PolkadotAccessController(orbitdb, {}, options)
  }

  async load (address) {
    const manifest = await this._orbitdb._ipfs.dag.get(address)
    return manifest.value
  }

  async save () {
    const cid = await this._orbitdb._ipfs.dag.put(this._options)
    return { address: cid.toString(base58btc) }
  }
}
//const AccessControllers = require('orbit-db-access-controllers')
//AccessControllers.addAccessController({ AccessController: PolkadotAccessController })


class OrbitDBInitializer {
  constructor(privateKey, ports = {}) {
    this.ipfs = null;
    this.orbitdb = null;
    this.eventlog = null;
    this.privateKey = privateKey || process.env.ADMIN_PRIVATE_KEY;
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
    // Don't initialize keyring or adminKey in constructor
  }

  async initialize(existingDbAddress = null) {
    try {
      await cryptoWaitReady();
      // Initialize keyring after cryptoWaitReady
      this.keyring = new Keyring({ type: 'sr25519' });
      this.adminKey = this.keyring.addFromSeed(this.seed);

      // Set up instance-specific directories after we have the address
      const baseDir = path.join(process.cwd(), 'data', this.adminKey.address);
      this.directories = {
        ipfs: path.join(baseDir, 'ipfs'),
        orbitdb: path.join(baseDir, 'orbitdb'),
        keystore: path.join(baseDir, 'keystore')
      };

      // Create all directories
      for (const dir of Object.values(this.directories)) {
        await fs.mkdir(dir, { recursive: true });
      }

      logger.info(`Initializing with admin address: ${this.adminKey.address}`);
      logger.info(`Admin public key: ${u8aToHex(this.adminKey.publicKey)}`);

      await this.initializeIPFS();
      await this.initializeOrbitDB(existingDbAddress);
      return this.eventlog?.address.toString();
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

  async initializeOrbitDB(existingDbAddress = null) {
    logger.info('Initializing OrbitDB...');

    // Create instance-specific identity
    const identity = await createIdentity(this.adminKey, this.directories.keystore);

    const options = {
      directory: this.directories.orbitdb,
      identity
    };

    logger.info('OrbitDB options:', options);
    this.orbitdb = await OrbitDB.createInstance(this.ipfs, options);

    logger.info('Created OrbitDB instance with identity:', this.orbitdb.identity.id);

    const dbOptions = {
      accessController: {
        type: 'ipfs',
        write: [this.orbitdb.identity.id]
      }
    };

    if (existingDbAddress) {
      logger.info('Opening existing database...');
      this.eventlog = await this.orbitdb.eventlog(existingDbAddress, dbOptions);
      logger.info(`Opened existing database: ${existingDbAddress}`);
    } else {
      logger.info('Creating new database...');
      this.eventlog = await this.orbitdb.eventlog('eventlog', dbOptions);
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
// Main execution
const main = async () => {
  const privateKey = process.argv[2] || process.env.ADMIN_PRIVATE_KEY;
  
  try {
    const initializer = new OrbitDBInitializer(privateKey);
    const dbAddress = await initializer.initialize();
    
    logger.info('\nInitialization Summary:');
    logger.info('-----------------------');
    logger.info(`Database Address: ${dbAddress}`);
    logger.info(`Admin Address: ${initializer.keyring.pairs[0].address}`);
    
    await initializer.close();
  } catch (error) {
    logger.error('Initialization failed:', error);
    process.exit(1);
  }
};

// ESM entry point
if (import.meta.url.startsWith('file:')) {
  const modulePath = fileURLToPath(import.meta.url);
  if (process.argv[1] === modulePath) {
    main().catch(console.error);
  }
}

export default OrbitDBInitializer;