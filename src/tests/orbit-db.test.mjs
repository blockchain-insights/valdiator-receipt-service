/**
 * @jest-environment node
 */
import { beforeAll, describe, it, expect, afterAll } from '@jest/globals';
import OrbitDBInitializer, { logger } from '../init_ipfs.js';
import { mnemonicGenerate, mnemonicToMiniSecret, cryptoWaitReady } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import dotenv from 'dotenv';

dotenv.config();

beforeAll(() => {
    if (!process.env.ADMIN_PRIVATE_KEY) {
        throw new Error('ADMIN_PRIVATE_KEY environment variable is required for tests');
    }
});

describe('OrbitDB Authorization Tests', () => {
    let adminInitializer;
    let unauthorizedInitializer;
    let dbAddress;

    beforeAll(async () => {
        await cryptoWaitReady();

        // Create admin instance
        adminInitializer = new OrbitDBInitializer(process.env.ADMIN_PRIVATE_KEY, {
            swarm: 4002,
            api: 5002,
            gateway: 9090
        });
        dbAddress = await adminInitializer.initialize();

        // Create unauthorized instance
        const mnemonic = mnemonicGenerate();
        const unauthorizedSeed = mnemonicToMiniSecret(mnemonic);
        const unauthorizedPrivateKey = u8aToHex(unauthorizedSeed).slice(2);

        unauthorizedInitializer = new OrbitDBInitializer(unauthorizedPrivateKey, {
            swarm: 4102,
            api: 5102,
            gateway: 9190
        });
        await unauthorizedInitializer.initialize(dbAddress);
    }, 30000);

    afterAll(async () => {
        await unauthorizedInitializer?.close();
        await adminInitializer?.close();
    });

    it('should allow admin to write to database', async () => {
        const testData = { test: 'admin write', timestamp: Date.now() };
        const hash = await adminInitializer.eventlog.add(testData);
        expect(hash).toBeDefined();

        const entries = await adminInitializer.eventlog.iterator({ limit: 1 }).collect();
        expect(entries[0].payload.value).toEqual(testData);
    });

    it('should not allow unauthorized instance to write initially', async () => {
        await expect(async () => {
            await unauthorizedInitializer.eventlog.add({
                test: 'unauthorized write attempt',
                timestamp: Date.now()
            });
        }).rejects.toThrow();
    });

    it('should allow admin to grant write access', async () => {
        const accessController = adminInitializer.eventlog.access;
        await accessController.grant('write', unauthorizedInitializer.orbitdb.identity.id);

        await adminInitializer.eventlog.load();
        await unauthorizedInitializer.eventlog.load();

        const testData = { test: 'authorized write', timestamp: Date.now() };
        const hash = await unauthorizedInitializer.eventlog.add(testData);
        expect(hash).toBeDefined();

        const entries = await unauthorizedInitializer.eventlog.iterator({ limit: 1 }).collect();
        expect(entries[0].payload.value).toEqual(testData);
    });

    it('should allow admin to revoke write access', async () => {
        const accessController = adminInitializer.eventlog.access;
        await accessController.revoke('write', unauthorizedInitializer.orbitdb.identity.id);

        await adminInitializer.eventlog.load();
        await unauthorizedInitializer.eventlog.load();

        await expect(async () => {
            await unauthorizedInitializer.eventlog.add({
                test: 'unauthorized write after revoke',
                timestamp: Date.now()
            });
        }).rejects.toThrow();
    });
});