import {cryptoWaitReady, mnemonicGenerate, mnemonicToMiniSecret} from '@polkadot/util-crypto';
import {logger, OwnerDatabaseInitializer} from "./init_ipfs.js";
import {fileURLToPath} from "url";
import {u8aToHex} from "@polkadot/util";


async function initialize_database(privateKey, ports){
    try{
        logger.info('\nInitializing database instance...');
        const instance = new OrbitDBInitializer(privateKey, ports);
        const address = await instance.initialize();
        logger.info('Subnet initialized at:', address);

        return { instance, address }
    }
    catch(err){
        logger.error(err);
    }
}


async function testUnauthorizedAccess() {
    let subnetOwnedInstance = null;
    let validatorOwnedInstance = null;

    try {

        const { subnetInstance, address } = await initialize_database(process.env.ADMIN_PRIVATE_KEY,{
            swarm: 4002,
            api: 5002,
            gateway: 9090
        });
        await new Promise(resolve => setTimeout(resolve, 5000));

        const {validatorInstance, _ } = await initialize_database(u8aToHex(mnemonicToMiniSecret(mnemonicGenerate())).slice(2),{
            swarm: 4102,
            api: 5102,
            gateway: 9190
        });
        await new Promise(resolve => setTimeout(resolve, 5000));



        logger.info('\n1. Initializing subnet owned instance...');

        subnetOwnedInstance = new OrbitDBInitializer(process.env.ADMIN_PRIVATE_KEY, {
            swarm: 4002,
            api: 5002,
            gateway: 9090
        });

        const dbAddress = await subnetOwnedInstance.initialize();
        logger.info('Subnet database initialized at:', dbAddress);
        await new Promise(resolve => setTimeout(resolve, 1000));



        logger.info('\n2. Creating validator owned instance...');
        const mnemonic = mnemonicGenerate();
        const unauthorizedSeed = mnemonicToMiniSecret(mnemonic);
        const unauthorizedPrivateKey = u8aToHex(unauthorizedSeed).slice(2);
        validatorOwnedInstance = new OrbitDBInitializer(unauthorizedPrivateKey, {
            swarm: 4102,
            api: 5102,
            gateway: 9190
        });
        await validatorOwnedInstance.initialize(dbAddress);

        logger.info('\n3. Testing validator owned instance write access (should fail)...');
        try {
            await validatorOwnedInstance.eventlog.add({
                test: 'unauthorized write attempt',
                timestamp: Date.now()
            });
            logger.error('WARNING: Write succeeded when it should have failed!');
        } catch (error) {
            logger.info('Expected error occurred:', error.message);
            logger.info('Access control is working as expected - unauthorized write was blocked');
        }

        subnetOwnedInstance.eventlog.close();
        logger.info('\n4. Granting write permissions to validator owned instance...');

        const dbOptions = {
            accessController: {
                type: 'ipfs',
                write: [
                    subnetOwnedInstance.orbitdb.identity.id,
                    validatorOwnedInstance.orbitdb.identity.id
                ]
            }
        };

        subnetOwnedInstance.eventlog = await subnetOwnedInstance.orbitdb.eventlog('eventlog', dbOptions);
        //const newDbAddress = subnetOwnedInstance.eventlog.address.toString();   address should be the same !!
        await subnetOwnedInstance.eventlog.load();
        await new Promise(resolve => setTimeout(resolve, 10000));

        //logger.info('New database created with address:', newDbAddress);
        // Wait for changes to propagate


        validatorOwnedInstance.eventlog.close();
        validatorOwnedInstance.eventlog = await validatorOwnedInstance.orbitdb.eventlog(dbAddress);
        await validatorOwnedInstance.eventlog.load();
        await new Promise(resolve => setTimeout(resolve, 10000));

        logger.info('\n5. Testing write access again (should succeed)...');
        try {
            const hash = await validatorOwnedInstance.eventlog.add({
                test: 'authorized write attempt',
                timestamp: Date.now()
            });
            logger.info('Write succeeded as expected! Entry hash:', hash);

            // Verify the entry exists
            const entries = await validatorOwnedInstance.eventlog.iterator({ limit: 1 }).collect();
            logger.info('Latest entry:', entries[0].payload.value);
        } catch (error) {
            logger.error('Write failed unexpectedly:', error);
            logger.error('Error details:', error);
        }

    } catch (error) {
        logger.error('Test failed:', error);
        throw error;
    } finally {
        // Cleanup
        logger.info('\n6. Cleaning up...');
        if (validatorOwnedInstance) await validatorOwnedInstance.close();
        if (subnetOwnedInstance) await subnetOwnedInstance.close();
    }
}

const main = async () => {
    try {
        await cryptoWaitReady()

        const instance = new OwnerDatabaseInitializer(process.env.ADMIN_PRIVATE_KEY);
        const address = await instance.initialize();
        logger.info("Address:" , address);



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