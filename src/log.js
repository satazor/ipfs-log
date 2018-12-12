'use strict'

const pMap = require('p-map')
const GSet = require('./g-set')
const Entry = require('./entry')
const LogIO = require('./log-io')
const LogError = require('./log-errors')
const Clock = require('./lamport-clock')
const { LastWriteWins } = require('./log-sorting')
const AccessController = require('./default-access-controller')
const IdentityProvider = require('orbit-db-identity-provider')
const { isDefined, findUniques } = require('./utils')

const randomId = () => new Date().getTime().toString()
const getHash = e => e.hash
const flatMap = (res, acc) => res.concat(acc)
const getNextPointers = entry => entry.next
const maxClockTimeReducer = (res, acc) => Math.max(res, acc.clock.time)
const uniqueEntriesReducer = (res, acc) => {
  res[acc.hash] = acc
  return res
}

class Log extends GSet {
  /**
   * @description
   * Log implements a G-Set CRDT and adds ordering
   * Create a new Log instance
   *
   * From:
   * "A comprehensive study of Convergent and Commutative Replicated Data Types"
   * https://hal.inria.fr/inria-00555588
   *
   * @constructor
   *
   * @example
   * const IPFS = require("ipfs")
   * const Log = require("../src/log")
   * const { AccessController, IdentityProvider } = require("../src/log")
   * const Keystore = require('orbit-db-keystore')
   * const Entry = require("../src/entry")
   * const Clock = require('../src/lamport-clock')
   *
   * const accessController = new AccessController()
   * const ipfs = new IPFS();
   * const keystore = Keystore.create("../test/fixtures/keys")
   * const identitySignerFn = async (id, data) => {
   *   const key = await keystore.getKey(id)
   *   return keystore.sign(key, data)
   * }
   *
   * (async () => {
   *   var identity = await IdentityProvider.createIdentity(keystore, 'username', identitySignerFn)
   *   var log = new Log(ipfs, accessController, identity)
   *
   *   // console.log(Object.keys(log))
   * })()
   *
   * @param  {IPFS}           [ipfs]          An IPFS instance
   * @param  {Object}         [access]        AccessController (./default-access-controller)
   * @param  {Object}         [identity]      Identity (https://github.com/orbitdb/orbit-db-identity-provider/blob/master/src/identity.js)
   * @param  {String}         [logId]         ID of the log
   * @param  {Array<Entry>}   [entries]       An Array of Entries from which to create the log
   * @param  {Array<Entry>}   [heads]         Set the heads of the log
   * @param  {Clock}          [clock]         Set the clock of the log
   * @return {Log}                            Log
   */
  constructor (ipfs, access, identity, logId, entries, heads, clock) {
    if (!isDefined(ipfs)) {
      throw LogError.IPFSNotDefinedError()
    }

    if (!isDefined(access)) {
      throw new Error('Access controller is required')
    }

    if (!isDefined(identity)) {
      throw new Error('Identity is required')
    }

    if (isDefined(entries) && !Array.isArray(entries)) {
      throw new Error(`'entries' argument must be an array of Entry instances`)
    }

    if (isDefined(heads) && !Array.isArray(heads)) {
      throw new Error(`'heads' argument must be an array`)
    }

    super()

    this._storage = ipfs
    this._id = logId || randomId()

    // Access Controller
    this._access = access
    // Identity
    this._identity = identity

    // Add entries to the internal cache
    entries = entries || []
    this._entryIndex = entries.reduce(uniqueEntriesReducer, {})

    // Set heads if not passed as an argument
    heads = heads || Log.findHeads(entries)
    this._headsIndex = heads.reduce(uniqueEntriesReducer, {})

    // Index of all next pointers in this log
    this._nextsIndex = {}
    const addToNextsIndex = e => e.next.forEach(a => (this._nextsIndex[a] = e.hash))
    entries.forEach(addToNextsIndex)

    // Set the length, we calculate the length manually internally
    this._length = entries ? entries.length : 0

    // Set the clock
    const maxTime = Math.max(clock ? clock.time : 0, this.heads.reduce(maxClockTimeReducer, 0))
    // Take the given key as the clock id is it's a Key instance,
    // otherwise if key was given, take whatever it is,
    // and if it was null, take the given id as the clock id
    this._clock = new Clock(this._identity.publicKey, maxTime)
  }

  /**
   * Returns the ID of the log
   *
   * @returns {string} the ID of the log
   *
   * @example
   * (async () => {
   *   var identity = await IdentityProvider.createIdentity(keystore, 'username', identitySignerFn)
   *   var log = new Log(ipfs, accessController, identity)
   *   console.log(log.id) // default uses JS microtime
   *
   *   var log2 = new Log(ipfs, accessController, identity, "MyLogID")
   *   console.log(log2.id) // or you can specify your own
   * })()
   */
  get id () {
    return this._id
  }

  /**
   * Returns the clock of the log
   *
   * @returns {string} The log's LamportClock
   *
   * @example
   * (async () => {
   *   var identity = await IdentityProvider.createIdentity(keystore, 'username', identitySignerFn)
   *   var log = new Log(ipfs, accessController, identity)
   *   console.log(log.clock)
   * })()
   */
  get clock () {
    return this._clock
  }

  /**
   * Returns the length of the log
   * @return {Number} length of the log
   *
   * @example
   * (async () => {
   *   var identity = await IdentityProvider.createIdentity(keystore, 'username', identitySignerFn)
   *   var log = new Log(ipfs, accessController, identity)
   *   console.log(log.length)
   *
   *   var entry = await Entry.create(ipfs, identity, '1', 'entry1', [], new Clock('1', 0))
   *   await log.append(entry)
   *   console.log(log.length)
   * })()
   *
   */
  get length () {
    return this._length
  }

  /**
   * Returns the values in the log
   * @returns {Array<Entry>} all values of the log sorted by LastWriteWins
   *
   * @example
   * (async () => {
   *   var identity = await IdentityProvider.createIdentity(keystore, 'username', identitySignerFn)
   *   var log = new Log(ipfs, accessController, identity)
   *
   *   var entry = await Entry.create(ipfs, identity, '1', 'entry1', [], new Clock('1', 0))
   *   await log.append(entry)
   *   console.log(log.values)
   * })()
   */
  get values () {
    return Object.values(this.traverse(this.heads)).reverse()
  }

  /**
   * Returns an array of heads as multihashes
   * @returns {Array<string>} values of the log head(s)
   */
  get heads () {
    return Object.values(this._headsIndex).sort(LastWriteWins).reverse() || []
  }

  /**
   * Returns an array of Entry objects that reference entries which
   * are not in the log currently
   * @returns {Array<Entry>} values of the log tail(s)s
   */
  get tails () {
    return Log.findTails(this.values)
  }

  /**
   * Returns an array of multihashes that are referenced by entries which
   * are not in the log currently
   * @returns {Array<string>} Array of multihashes
   */
  get tailHashes () {
    return Log.findTailHashes(this.values)
  }

  /**
   * Find an entry
   * @param {string} [hash] The Multihash of the entry as Base58 encoded string
   * @returns {Entry|undefined} hash of the entry index
   */
  get (hash) {
    return this._entryIndex[hash]
  }

  /**
   * Verify that the log contains the entry you're seeking
   * @param {Entry} entry the entry you're looking to verify
   * @returns {Boolean} `true` or `false` if the log contains the entry
   */
  has (entry) {
    return this._entryIndex[entry.hash || entry] !== undefined
  }

  /**
   * Follow the pointers and load the log into memory for processing
   *
   * @param {Array} rootEntries entry or entries to start from
   * @param {Number} amount number of entries to traverse
   *
   * @returns {Object} object containing traversed entries
   */
  traverse (rootEntries, amount = -1) {
    // Sort the given given root entries and use as the starting stack
    let stack = rootEntries.sort(LastWriteWins).reverse()
    // Cache for checking if we've processed an entry already
    let traversed = {}
    // End result
    let result = {}
    // We keep a counter to check if we have traversed requested amount of entries
    let count = 0

    // Named function for getting an entry from the log
    const getEntry = e => this.get(e)

    // Add an entry to the stack and traversed nodes index
    const addToStack = entry => {
      // If we've already processed the entry, don't add it to the stack
      if (traversed[entry.hash]) {
        return
      }

      // Add the entry in front of the stack and sort
      stack = [entry, ...stack]
        .sort(LastWriteWins)
        .reverse()

      // Add to the cache of processed entries
      traversed[entry.hash] = true
    }

    // Start traversal
    // Process stack until it's empty (traversed the full log)
    // or when we have the requested amount of entries
    // If requested entry amount is -1, traverse all
    while (stack.length > 0 && (amount === -1 || count < amount)) { // eslint-disable-line no-unmodified-loop-condition
      // Get the next element from the stack
      const entry = stack.shift()

      // Is the stack empty?
      if (!entry) {
        return
      }

      // Add to the result
      count++
      result[entry.hash] = entry

      // Add entry's next references to the stack
      entry.next.map(getEntry)
        .filter(isDefined)
        .forEach(addToStack)
    }

    return result
  }

  /**
   * Append an entry to the log
   * @param  {Entry} data Entry to add
   * @param {Number} pointerCount "Depth" of log to traverse
   * @return {Log}   New Log containing the appended value
   */
  async append (data, pointerCount = 1) {
    // Update the clock (find the latest clock)
    const newTime = Math.max(this.clock.time, this.heads.reduce(maxClockTimeReducer, 0)) + 1
    this._clock = new Clock(this.clock.id, newTime)

    // Get the required amount of hashes to next entries (as per current state of the log)
    const references = this.traverse(this.heads, Math.max(pointerCount, this.heads.length))
    const nexts = Object.keys(Object.assign({}, this._headsIndex, references))

    // @TODO: Split Entry.create into creating object, checking permission, signing and then posting to IPFS
    // Create the entry and add it to the internal cache
    const entry = await Entry.create(
      this._storage,
      this._identity,
      this.id,
      data,
      nexts,
      this.clock
    )

    const canAppend = await this._access.canAppend(entry, this._identity.provider)
    if (!canAppend) {
      throw new Error(`Could not append entry, key "${this._identity.id}" is not allowed to write to the log`)
    }

    this._entryIndex[entry.hash] = entry
    nexts.forEach(e => (this._nextsIndex[e] = entry.hash))
    this._headsIndex = {}
    this._headsIndex[entry.hash] = entry
    // Update the length
    this._length++
    return entry
  }

  /**
   * Join two logs
   *
   * @description Joins two logs returning a new log. Doesn't mutate the original logs.
   *
   * @param {Log}    log    Log to join with this Log
   * @param {Number} size Max size of the joined log
   *
   * @example
   * await log1.join(log2)
   *
   * @returns {Promise<Log>} The promise of a new Log
   */
  async join (log, size = -1) {
    if (!isDefined(log)) throw LogError.LogNotDefinedError()
    if (!Log.isLog(log)) throw LogError.NotALogError()
    if (this.id !== log.id) return

    // Get the difference of the logs
    const newItems = Log.difference(log, this)

    const identityProvider = this._identity.provider
    // Verify if entries are allowed to be added to the log and throws if
    // there's an invalid entry
    const permitted = async (entry) => {
      const canAppend = await this._access.canAppend(entry, identityProvider)
      if (!canAppend) throw new Error('Append not permitted')
    }

    // Verify signature for each entry and throws if there's an invalid signature
    const verify = async (entry) => {
      const isValid = await Entry.verify(identityProvider, entry)
      const publicKey = entry.identity ? entry.identity.publicKey : entry.key
      if (!isValid) throw new Error(`Could not validate signature "${entry.sig}" for entry "${entry.hash}" and key "${publicKey}"`)
    }

    const entriesToJoin = Object.values(newItems)
    await pMap(entriesToJoin, permitted, { concurrency: 1 })
    await pMap(entriesToJoin, verify, { concurrency: 1 })

    // Update the internal next pointers index
    const addToNextsIndex = e => {
      const entry = this.get(e.hash)
      if (!entry) this._length++
      e.next.forEach(a => (this._nextsIndex[a] = e.hash))
    }
    Object.values(newItems).forEach(addToNextsIndex)

    // Update the internal entry index
    this._entryIndex = Object.assign(this._entryIndex, newItems)

    // Merge the heads
    const notReferencedByNewItems = e => !nextsFromNewItems.find(a => a === e.hash)
    const notInCurrentNexts = e => !this._nextsIndex[e.hash]
    const nextsFromNewItems = Object.values(newItems).map(getNextPointers).reduce(flatMap, [])
    const mergedHeads = Log.findHeads(Object.values(Object.assign({}, this._headsIndex, log._headsIndex)))
      .filter(notReferencedByNewItems)
      .filter(notInCurrentNexts)
      .reduce(uniqueEntriesReducer, {})

    this._headsIndex = mergedHeads

    // Slice to the requested size
    if (size > -1) {
      let tmp = this.values
      tmp = tmp.slice(-size)
      this._entryIndex = tmp.reduce(uniqueEntriesReducer, {})
      this._headsIndex = Log.findHeads(tmp)
      this._length = Object.values(this._entryIndex).length
    }

    // Find the latest clock from the heads
    const maxClock = Object.values(this._headsIndex).reduce(maxClockTimeReducer, 0)
    this._clock = new Clock(this.clock.id, Math.max(this.clock.time, maxClock))
    return this
  }

  /**
   * Get the log in JSON format
   * @returns {Object<{id, heads}>} object with the id of the log and the heads
   */
  toJSON () {
    return {
      id: this.id,
      heads: this.heads
        .sort(LastWriteWins) // default sorting
        .reverse() // we want the latest as the first element
        .map(getHash) // return only the head hashes
    }
  }

  /**
   * Get a snapshot of the log
   * @returns {Object<{id, heads, values}>} object with id, heads, and values array
   */
  toSnapshot () {
    return {
      id: this.id,
      heads: this.heads,
      values: this.values
    }
  }

  /**
   * Get the log as a Buffer
   * @returns {Buffer} Buffer version of stringified log JSON
   */
  toBuffer () {
    return Buffer.from(JSON.stringify(this.toJSON()))
  }

  /**
   * Returns the log entries as a formatted string
   * @example
   * two
   * └─one
   *   └─three
   *
   * @param {Function} payloadMapper transformation function
   *
   * @returns {string} plain text representation of the log
   */
  toString (payloadMapper) {
    return this.values
      .slice()
      .reverse()
      .map((e, idx) => {
        const parents = Entry.findChildren(e, this.values)
        const len = parents.length
        let padding = new Array(Math.max(len - 1, 0))
        padding = len > 1 ? padding.fill('  ') : padding
        padding = len > 0 ? padding.concat(['└─']) : padding
        return padding.join('') + (payloadMapper ? payloadMapper(e.payload) : e.payload)
      })
      .join('\n')
  }

  /**
   * Check whether an object is a Log instance
   * @param {Object} log An object to check
   * @returns {true|false} true or false if the object is a log instance
   */
  static isLog (log) {
    return log.id !== undefined &&
      log.heads !== undefined &&
      log._entryIndex !== undefined
  }

  /**
   * Get the log's multihash
   * @returns {Promise<string>} Multihash of the Log as Base58 encoded string
   */
  toMultihash () {
    return LogIO.toMultihash(this._storage, this)
  }

  /**
   * On Progress Callback
   *
   * @callback onProgressCallback
   * @param {String} hash
   * @param {Entry} entry
   * @param {Number} depth
   */

  /**
   * Create a log from multihash
   *
   * @param {IPFS}   ipfs        An IPFS instance
   * @param {AccessController} access AccessController object for the Log
   * @param {Identity} identity The identity of the owner of the log
   * @param {string} hash        Multihash (as a Base58 encoded string) to create the log from
   * @param {Number} length [length=-1] How many items to include in the log
   * @param {Entry} exclude Entries to ex;lude from the log
   * @param {onProgressCallback} onProgressCallback On Progress Callback
   * @return {Promise<Log>} New Log
   */
  static async fromMultihash (ipfs, access, identity, hash, length = -1, exclude, onProgressCallback) {
    if (!isDefined(ipfs)) throw LogError.IPFSNotDefinedError()
    if (!isDefined(hash)) throw new Error(`Invalid hash: ${hash}`)

    // TODO: need to verify the entries with 'key'
    const data = await LogIO.fromMultihash(ipfs, hash, length, exclude, onProgressCallback)
    return new Log(ipfs, access, identity, data.id, data.values, data.heads, data.clock)
  }

  /**
   * On Progress Callback
   *
   * @callback onProgressCallbackWithParent
   * @param {String} hash
   * @param {Entry} entry
   * @param {Entry} parent
   * @param {Number} depth
   */

  /**
   * Create a log from a single entry's multihash
   * @param {IPFS}   ipfs        An IPFS instance
   * @param {AccessController} access AccessController instance for the log
   * @param {Identity} identity Identity object for the hash
   * @param {string} hash        Multihash (as a Base58 encoded string) of the Entry from which to create the log from
   * @param {Number} id   the ID of the new log
   * @param {Number} [length=-1] How many entries to include in the log
   * @param {Array<Entry>} exclude entries to exclude from the new log
   * @param {onProgressCallback} onProgressCallback On Progress Callback
   * @return {Promise<Log>}      New Log
   */
  static async fromEntryHash (ipfs, access, identity, hash, id, length = -1, exclude, onProgressCallback) {
    if (!isDefined(ipfs)) throw LogError.IPFSNotDefinedError()
    if (!isDefined(hash)) throw new Error("'hash' must be defined")

    // TODO: need to verify the entries with 'key'
    const data = await LogIO.fromEntryHash(ipfs, hash, id, length, exclude, onProgressCallback)
    return new Log(ipfs, access, identity, id, data.values)
  }

  /**
   * Create a log from a Log Snapshot JSON
   * @param {IPFS} ipfs          An IPFS instance
   * @param {AccessController} access AccessController instance for the log
   * @param {Identity} identity Identity object for the hash
   * @param {Object} json        Log snapshot as JSON object
   * @param {Number} [length=-1] How many entries to include in the log
   * @param {Number} timeout number of milliseconds to time out in
   * @param {onProgressCallback} onProgressCallback On progress callback
   * @return {Promise<Log>}      New Log
   */
  static async fromJSON (ipfs, access, identity, json, length = -1, timeout, onProgressCallback) {
    if (!isDefined(ipfs)) throw LogError.IPFSNotDefinedError()

    // TODO: need to verify the entries with 'key'
    const data = await LogIO.fromJSON(ipfs, json, length, timeout, onProgressCallback)
    return new Log(ipfs, access, identity, data.id, data.values)
  }

  /**
   * Create a new log from an Entry instance
   * @param {IPFS}                ipfs          An IPFS instance
   * @param {AccessController} access AccessController instance for the log
   * @param {Identity} identity Identity object for the hash
   * @param {Entry|Array<Entry>} sourceEntries An Entry or an array of entries to fetch a log from
   * @param {Number}              [length=-1]   How many entries to include. Default: infinite.
   * @param {Array<Entry|string>} [exclude]     Array of entries or hashes or entries to not fetch (foe eg. cached entries)
   * @param {onProgressCallback} onProgressCallback On progress callback
   * @return {Promise<Log>}       New Log
   */
  static async fromEntry (ipfs, access, identity, sourceEntries, length = -1, exclude, onProgressCallback) {
    if (!isDefined(ipfs)) throw LogError.IPFSNotDefinedError()
    if (!isDefined(sourceEntries)) throw new Error("'sourceEntries' must be defined")

    // TODO: need to verify the entries with 'key'
    const data = await LogIO.fromEntry(ipfs, sourceEntries, length, exclude, onProgressCallback)
    return new Log(ipfs, access, identity, data.id, data.values)
  }

  /**
   * Find heads from a collection of entries
   *
   * @description
   * Finds entries that are the heads of this collection,
   * ie. entries that are not referenced by other entries
   *
   * @param {Array<Entry>} entries Entries to search heads from
   * @returns {Array<Entry>} entryHash
   */
  static findHeads (entries) {
    var indexReducer = (res, entry, idx, arr) => {
      var addToResult = e => (res[e] = entry.hash)
      entry.next.forEach(addToResult)
      return res
    }

    var items = entries.reduce(indexReducer, {})

    var exists = e => items[e.hash] === undefined
    var compareIds = (a, b) => a.clock.id > b.clock.id

    return entries.filter(exists).sort(compareIds)
  }

  /**
   * Find entries that point to another entry that is not in the input array
   *
   * @param {Array<Entry>} entries entried to find tails from
   *
   * @returns {Array<Entry>} unique tail entries
   */
  static findTails (entries) {
    // Reverse index { next -> entry }
    var reverseIndex = {}
    // Null index containing entries that have no parents (nexts)
    var nullIndex = []
    // Hashes for all entries for quick lookups
    var hashes = {}
    // Hashes of all next entries
    var nexts = []

    var addToIndex = (e) => {
      if (e.next.length === 0) {
        nullIndex.push(e)
      }
      var addToReverseIndex = (a) => {
        /* istanbul ignore else */
        if (!reverseIndex[a]) reverseIndex[a] = []
        reverseIndex[a].push(e)
      }

      // Add all entries and their parents to the reverse index
      e.next.forEach(addToReverseIndex)
      // Get all next references
      nexts = nexts.concat(e.next)
      // Get the hashes of input entries
      hashes[e.hash] = true
    }

    // Create our indices
    entries.forEach(addToIndex)

    var addUniques = (res, entries, idx, arr) => res.concat(findUniques(entries, 'hash'))
    var exists = e => hashes[e] === undefined
    var findFromReverseIndex = e => reverseIndex[e]

    // Drop hashes that are not in the input entries
    const tails = nexts // For every multihash in nexts:
      .filter(exists) // Remove undefineds and nulls
      .map(findFromReverseIndex) // Get the Entry from the reverse index
      .reduce(addUniques, []) // Flatten the result and take only uniques
      .concat(nullIndex) // Combine with tails the have no next refs (ie. first-in-their-chain)

    return findUniques(tails, 'hash').sort(Entry.compare)
  }

  /**
   * Find the hashes to entries that are not in a collection
   * but referenced by other entries
   *
   * @param {Array<Entry>} entries array of entries to find tails in
   *
   * @returns {Array<String>} hashes of tail entries
   */
  static findTailHashes (entries) {
    var hashes = {}
    var addToIndex = e => (hashes[e.hash] = true)
    var reduceTailHashes = (res, entry, idx, arr) => {
      var addToResult = (e) => {
        /* istanbul ignore else */
        if (hashes[e] === undefined) {
          res.splice(0, 0, e)
        }
      }
      entry.next.reverse().forEach(addToResult)
      return res
    }

    entries.forEach(addToIndex)
    return entries.reduce(reduceTailHashes, [])
  }

  /**
   * Shows the difference between two logs
   *
   * @param {Log} a the first log
   * @param {Log} b the second log
   *
   * @returns {Log} The resultant log
   */
  static difference (a, b) {
    let stack = Object.keys(a._headsIndex)
    let traversed = {}
    let res = {}

    const pushToStack = hash => {
      if (!traversed[hash] && !b.get(hash)) {
        stack.push(hash)
        traversed[hash] = true
      }
    }

    while (stack.length > 0) {
      const hash = stack.shift()
      const entry = a.get(hash)
      if (entry && !b.get(hash) && entry.id === b.id) {
        res[entry.hash] = entry
        traversed[entry.hash] = true
        entry.next.forEach(pushToStack)
      }
    }
    return res
  }
}

module.exports = Log
module.exports.AccessController = AccessController
module.exports.IdentityProvider = IdentityProvider
