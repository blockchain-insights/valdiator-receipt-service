import {cryptoWaitReady, signatureVerify} from "@polkadot/util-crypto";
import {Keyring} from "@polkadot/keyring";
import Keystore from "orbit-db-keystore";
import Identities from "orbit-db-identity-provider";
import {u8aToHex} from "@polkadot/util";
import {logger} from "./init_ipfs.js";

export async function createIdentity(keyPair, keystoreDir) {  // Add keystoreDir parameter
    await cryptoWaitReady();
    const keyring = new Keyring({ type: 'sr25519' });
    const polkaKeys = keyring.addPair(keyPair);
    const id = polkaKeys.address;
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


export class PolkadotIdentityProvider {
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