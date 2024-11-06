import {cryptoWaitReady, signatureVerify} from "@polkadot/util-crypto";
import {Keyring} from "@polkadot/keyring";
import Keystore from "orbit-db-keystore";
import Identities from "orbit-db-identity-provider";


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
        try{
            const { isValid } = signatureVerify(signatures.id, signatures.publicKey, id)
            return isValid
        }
        catch (error) {
            return false
        }
    }
}

export class PolkadotAccessController {
    constructor (orbitdb, idProvider, options) {
        this._orbitdb = orbitdb
        this._options = options || {}
        this.idProvider = idProvider
    }
    static get type () { return 'Polkadot' }
    get type () {
        return this.constructor.type
    }

    static async verifyIdentity (identity) {
        const { id, signatures } = identity
        const { isValid } = signatureVerify(signatures.id, signatures.publicKey, id)
        return isValid
    }

    async canAppend (entry, identityProvider) {
        const orbitIdentity = this._orbitdb.identity
        const entryIdentity = entry.identity
        const verified = await PolkadotAccessController.verifyIdentity(entryIdentity)
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