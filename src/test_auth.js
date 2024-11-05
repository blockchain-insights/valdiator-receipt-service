import { Keyring } from '@polkadot/keyring';
import {cryptoWaitReady, mnemonicGenerate, mnemonicToMiniSecret} from '@polkadot/util-crypto';
import OrbitDBInitializer, {logger} from "./init_ipfs.js";
import {fileURLToPath} from "url";
import {u8aToHex} from "@polkadot/util";
import {waitForClientReady} from "@grpc/grpc-js";


async function testUnauthorizedAccess() {
    let adminInitializer = null;
    let unauthorizedInitializer = null;

    try {
        // Initialize admin instance with first set of ports
        logger.info('\n1. Initializing admin instance...');
        adminInitializer = new OrbitDBInitializer(process.env.ADMIN_PRIVATE_KEY, {
            swarm: 4002,
            api: 5002,
            gateway: 9090
        });

        const dbAddress = await adminInitializer.initialize();
        logger.info('Admin database initialized at:', dbAddress);

        // Wait for IPFS to be ready
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Create unauthorized instance with completely different ports
        logger.info('\n2. Creating unauthorized instance...');
        const mnemonic = mnemonicGenerate();
        const unauthorizedSeed = mnemonicToMiniSecret(mnemonic);
        const unauthorizedPrivateKey = u8aToHex(unauthorizedSeed).slice(2);

        // Use completely different port ranges
        unauthorizedInitializer = new OrbitDBInitializer(unauthorizedPrivateKey, {
            swarm: 4102,  // Changed from 4003 to 4102
            api: 5102,    // Changed from 5003 to 5102
            gateway: 9190  // Changed from 9091 to 9190
        });

        // Initialize unauthorized instance
        await unauthorizedInitializer.initialize(dbAddress);

        // Try write access
        logger.info('\n3. Testing write access...');
        try {
            await unauthorizedInitializer.eventlog.add({
                test: 'unauthorized write attempt',
                timestamp: Date.now()
            });
            logger.error('WARNING: Write succeeded when it should have failed!');
        } catch (error) {
            logger.info('Expected error occurred:', error.message);
            logger.info('Access control is working as expected - unauthorized write was blocked');
        }

    } catch (error) {
        logger.error('Test failed:', error);
        throw error;
    } finally {
        // Cleanup
        logger.info('\n4. Cleaning up...');
        if (unauthorizedInitializer) await unauthorizedInitializer.close();
        if (adminInitializer) await adminInitializer.close();
    }
}

const main = async () => {
    try {
        await cryptoWaitReady()
        await testUnauthorizedAccess();
        logger.info('\nTest completed successfully');
    } catch (error) {
        logger.error('Test failed:', error);
        process.exit(1);
    }
};

if (import.meta.url.startsWith('file:')) {
    const modulePath = fileURLToPath(import.meta.url);
    if (process.argv[1] === modulePath) {
        main().catch(console.error);
    }
}