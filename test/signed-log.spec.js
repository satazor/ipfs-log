'use strict'

const assert = require('assert')
const rmrf = require('rimraf')
const Keystore = require('orbit-db-keystore')
const Log = require('../src/log')
const { AccessController, IdentityProvider } = Log

// Test utils
const {
  config,
  testAPIs,
  startIpfs,
  stopIpfs
} = require('./utils')

let ipfs, testIdentity, testIdentity2

Object.keys(testAPIs).forEach((IPFS) => {
  describe('Signed Log (' + IPFS + ')', function () {
    this.timeout(config.timeout)

    const keystore = Keystore.create(config.testKeysPath)
    const identitySignerFn = async (id, data) => {
      const key = await keystore.getKey(id)
      return keystore.sign(key, data)
    }
    const testACL = new AccessController()
    const ipfsConfig = Object.assign({}, config.defaultIpfsConfig, {
      repo: config.defaultIpfsConfig.repo + '-log-signed' + new Date().getTime()
    })

    before(async () => {
      rmrf.sync(ipfsConfig.repo)
      testIdentity = await IdentityProvider.createIdentity(keystore, 'userA', identitySignerFn)
      testIdentity2 = await IdentityProvider.createIdentity(keystore, 'userB', identitySignerFn)
      ipfs = await startIpfs(IPFS, ipfsConfig)
    })

    after(async () => {
      await stopIpfs(ipfs)
      rmrf.sync(ipfsConfig.repo)
    })

    it('creates a signed log', () => {
      const logId = 'A'
      const log = new Log(ipfs, testACL, testIdentity, logId)
      assert.notStrictEqual(log.id, null)
      assert.strictEqual(log.id, logId)
    })

    it('has the correct identity', () => {
      const log = new Log(ipfs, testACL, testIdentity, 'A')
      assert.notStrictEqual(log.id, null)
      assert.strictEqual(log._identity.id, 'userA')
      assert.strictEqual(log._identity.publicKey, '042750228c5d81653e5142e6a56d5551231649160f77b25797dc427f8a5b2afd650acca10182f0dfc519dc6d6e5216b9a6612dbfc56e906bdbf34ea373c92b30d7')
      assert.strictEqual(log._identity.signatures.id, '30440220590c0b1a84d5edabf4238ea924ad06481a47ba7f866d88d5950e89ee53670d04022068896f4d850297051c6b1acd5edb8d9dacc0a8fa3d11f436b79e193d14236a05')
      assert.strictEqual(log._identity.signatures.publicKey, '304502210083bee84a2ecab7df452e0642b5d6f84ecc1c33927eac26049111bea64dfc0b8102202ef96123734077f171e211f21f632006a7cdce9d5757ea7c4edd4d54eadbe5d4')
    })

    it('has the correct public key', () => {
      const log = new Log(ipfs, testACL, testIdentity, 'A')
      assert.strictEqual(log._identity.publicKey, testIdentity.publicKey)
    })

    it('has the correct pkSignature', () => {
      const log = new Log(ipfs, testACL, testIdentity, 'A')
      assert.strictEqual(log._identity.signatures.id, testIdentity.signatures.id)
    })

    it('has the correct signature', () => {
      const log = new Log(ipfs, testACL, testIdentity, 'A')
      assert.strictEqual(log._identity.signatures.publicKey, testIdentity.signatures.publicKey)
    })

    it('entries contain an identity', async () => {
      const log = new Log(ipfs, testACL, testIdentity, 'A')
      await log.append('one')
      assert.notStrictEqual(log.values[0].sig, null)
      assert.deepStrictEqual(log.values[0].identity, testIdentity.toJSON())
    })

    it('doesn\'t sign entries when access controller is not defined', async () => {
      let err
      try {
        const log = new Log(ipfs) // eslint-disable-line no-unused-vars
      } catch (e) {
        err = e.toString()
      }
      assert.strictEqual(err, 'Error: Access controller is required')
    })

    it('doesn\'t join logs with different IDs ', async () => {
      const log1 = new Log(ipfs, testACL, testIdentity, 'A')
      const log2 = new Log(ipfs, testACL, testIdentity2, 'B')

      let err
      try {
        await log1.append('one')
        await log2.append('two')
        await log2.append('three')
        await log1.join(log2)
      } catch (e) {
        err = e.toString()
        throw e
      }

      assert.strictEqual(err, undefined)
      assert.strictEqual(log1.id, 'A')
      assert.strictEqual(log1.values.length, 1)
      assert.strictEqual(log1.values[0].payload, 'one')
    })

    it('throws an error if log is signed but trying to merge with an entry that doesn\'t have public signing key', async () => {
      const log1 = new Log(ipfs, testACL, testIdentity, 'A')
      const log2 = new Log(ipfs, testACL, testIdentity2, 'A')

      let err
      try {
        await log1.append('one')
        await log2.append('two')
        delete log2.values[0].key
        await log1.join(log2)
      } catch (e) {
        err = e.toString()
      }
      assert.strictEqual(err, 'Error: Entry doesn\'t have a key')
    })

    it('throws an error if log is signed but trying to merge an entry that doesn\'t have a signature', async () => {
      const log1 = new Log(ipfs, testACL, testIdentity, 'A')
      const log2 = new Log(ipfs, testACL, testIdentity2, 'A')

      let err
      try {
        await log1.append('one')
        await log2.append('two')
        delete log2.values[0].sig
        await log1.join(log2)
      } catch (e) {
        err = e.toString()
      }
      assert.strictEqual(err, 'Error: Entry doesn\'t have a signature')
    })

    it('throws an error if log is signed but the signature doesn\'t verify', async () => {
      const replaceAt = (str, index, replacement) => {
        return str.substr(0, index) + replacement + str.substr(index + replacement.length)
      }

      const log1 = new Log(ipfs, testACL, testIdentity, 'A')
      const log2 = new Log(ipfs, testACL, testIdentity2, 'A')
      let err

      try {
        await log1.append('one')
        await log2.append('two')
        log2.values[0].sig = replaceAt(log2.values[0].sig, 0, 'X')
        await log1.join(log2)
      } catch (e) {
        err = e.toString()
      }

      const entry = log2.values[0]
      assert.strictEqual(err, `Error: Could not validate signature "${entry.sig}" for entry "${entry.hash}" and key "${entry.key}"`)
      assert.strictEqual(log1.values.length, 1)
      assert.strictEqual(log1.values[0].payload, 'one')
    })

    it('throws an error if entry doesn\'t have append access', async () => {
      const testACL2 = { canAppend: () => false }
      const log1 = new Log(ipfs, testACL, testIdentity, 'A')
      const log2 = new Log(ipfs, testACL2, testIdentity2, 'A')

      let err
      try {
        await log1.append('one')
        await log2.append('two')
        await log1.join(log2)
      } catch (e) {
        err = e.toString()
      }

      assert.strictEqual(err, `Error: Could not append entry, key "${testIdentity2.id}" is not allowed to write to the log`)
    })
  })
})
