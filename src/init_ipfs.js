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
import {verifyIdentity} from "./identity/polkadot-identity-provider.js";
import {base58btc} from "multiformats/bases/base58";


const require = createRequire(import.meta.url);
const Keystore = require('orbit-db-keystore');


dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    })
  ]
});

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

class OrbitDBInitializer {
  constructor(privateKey) {
    this.ipfs = null;
    this.orbitdb = null;
    this.eventlog = null;
    this.keyring = new Keyring({ type: 'sr25519' });
    this.privateKey = privateKey || process.env.ADMIN_PRIVATE_KEY;
    
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

  async initialize() {
    try {
      await cryptoWaitReady();
      this.adminKey = this.keyring.addFromSeed(this.seed);

      logger.info(`Initializing with admin address: ${this.adminKey.address}`);
      logger.info(`Admin public key: ${u8aToHex(this.adminKey.publicKey)}`);

      await this.initializeIPFS();
      await this.initializeOrbitDB();
      return this.eventlog.address.toString();
    } catch (error) {
      logger.error('Failed to initialize OrbitDB:', error);
      throw error;
    }
  }

  async initializeIPFS() {
    logger.info('Starting IPFS node...');
    this.ipfs = await IPFS.create({
      repo: './ipfs',
      start: true,
      EXPERIMENTAL: { pubsub: true }
    });
    const id = await this.ipfs.id();
    logger.info(`IPFS node started with ID: ${id.id}`);
  }

  async initializeOrbitDB() {
    logger.info('Initializing OrbitDB...');

    const orbitdbDir = path.join(process.cwd(), './orbitdb');
    const keystoreDir = path.join(orbitdbDir, 'keystore');
    await fs.mkdir(keystoreDir, { recursive: true });

    const keystore = new Keystore(keystoreDir);
    if (!keystore) {
      throw new Error('Failed to initialize keystore');
    }

    /*const identity = await Identities.createIdentity({
      keyPair: this.adminKey,
      keystore: keystore,
      type: 'polkadot',
    });*/
    identity = null
    const options = {
      directory: orbitdbDir,
      identity,
    };

    logger.info('OrbitDB options:', options);
    this.orbitdb = await OrbitDB.createInstance(this.ipfs, options);

    logger.info('Created OrbitDB instance with identity:', this.orbitdb.identity.id);

    let dbAddress;
    try {
      dbAddress = process.env.DB_ADDRESS;
      if (!dbAddress) {
        const addressFile = path.join(process.cwd(), '.db-address');
        dbAddress = await fs.readFile(addressFile, 'utf8').catch(() => null);
      }
    } catch (error) {
      logger.warn('No existing database address found');
    }

    const dbOptions = {
      accessController: {
        type: 'ipfs',
        write: [this.orbitdb.identity.id]
      }
    };

    if (dbAddress) {
      logger.info('Opening existing database...');
      this.eventlog = await this.orbitdb.eventlog(dbAddress, dbOptions);
      logger.info(`Opened existing database: ${dbAddress}`);
    } else {
      logger.info('Creating new database...');
      this.eventlog = await this.orbitdb.eventlog('eventlog', dbOptions);
      
      const address = this.eventlog.address.toString();
      await fs.writeFile(path.join(process.cwd(), '.db-address'), address);
      logger.info(`Created new database: ${address}`);
    }

    await this.eventlog.load();
    
    // Test write access
    try {
      const hash = await this.eventlog.add({ test: 'write access', timestamp: Date.now() });
      logger.info('Successfully tested write access, entry hash:', hash);
    } catch (error) {
      logger.error('Write access test failed:', error);
      throw error;
    }

    logger.info('Database loaded and tested successfully');
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

    const identity = await createIdentity(privateKey)
    const verifyIdentity = await PolkadotIdentityProvider.verifyIdentity(identity)

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