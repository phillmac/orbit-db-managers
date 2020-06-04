const isDefined = (arg) => arg !== undefined && arg !== null

function removeItem (array, item) {
  const index = array.indexOf(item)
  if (index > -1) {
    return array.splice(index, 1)
  }
}

class DBManager {
  constructor ({ orbitDB, peerMan, Logger, Web3, PQueue, options }) {
    if (!isDefined(orbitDB)) { throw new Error('orbitDB is a required argument.') }

    const findOptionValue = (optName, def) => {
      if (isDefined(options.dbMan) && isDefined(options.dbMan[optName])) return options.dbMan[optName]
      if (isDefined(options[optName])) return options[optName]
      return def
    }

    const OrbitDB = orbitDB.constructor

    peerMan = Object.assign({
      getPeers: function () {},
      attachDB: function () {}
    }, peerMan)

    const loadQueue = new PQueue({ concurrency: 1 })
    const syncQueue = new PQueue({ concurrency: 1 })

    const logger = (
      typeof Logger.create === 'function' ? Logger.create('db-manager', { color: Logger.Colors.Green }) : Object.assign({
        debug: function () {},
        info: function () {},
        warn: function () {},
        error: function () {}
      },
      Logger
      )
    )

    this.events = orbitDB.events

    const pendingOpens = new Set()
    const pendingReady = new Set()
    const pendingLoad = new Set()

    this.pendingOpens = () => Array.from(pendingOpens.keys())
    this.pendingReady = () => Array.from(pendingReady.keys())
    this.pendingLoad = () => Array.from(pendingLoad.keys())

    const findDB = (dbn) => {
      if (dbn in orbitDB.stores) return orbitDB.stores[dbn]
      for (const db of Object.values(orbitDB.stores)) {
        if (dbn === db.dbname) {
          return db
        } else if (dbn === [db.address.root, db.address.path].join('/')) {
          return db
        } else if (dbn === db.address.toString()) {
          return db
        }
      }
    }

    const loadDB = (db) => {
      return loadQueue.add(async () => {
        logger.debug(`Loading db ${db.id}`)
        try {
          await db.load()
        } catch (err) {
          logger.error('Error loading db', err)
        }
        logger.debug(`Finished loading db ${db.id}`)
      })
    }

    this.loadDB = (db) => {
      if (pendingLoad.has(db.id)) throw new Error(`Db ${db.id} already pending`)
      return loadDB(db)
    }

    this.syncDB = (db, heads) => {
      return syncQueue.add(async () => {
        logger.debug(`syncing db ${db.id} with heads ${heads}`)
        try {
          await db.sync(heads)
        } catch (err) {
          logger.error('Error syncing db', err)
        }
        logger.debug(`Finished syncing db ${db.id}`)
      })
    }

    const handleWeb3 = (accessController) => {
      if (isDefined(accessController.web3)) {
        if (isDefined(Web3)) {
          accessController.web3 = new Web3(accessController.web3)
        } else {
          logger.warn('Web3 access controller params ignored')
          delete accessController.web3
        }
      }
      return accessController
    }

    this.openCreate = async (dbn, params) => {
      params = Object.assign({}, params)
      let awaitOpen = params.awaitOpen
      let awaitLoad = params.awaitLoad

      if ('awaitOpen' in params) {
        delete params.awaitOpen
      } else {
        awaitOpen = true
      }

      if ('awaitLoad' in params) {
        delete params.awaitLoad
      } else {
        awaitLoad = true
      }

      logger.debug({
        awaitOpen,
        awaitLoad
      })

      const dbAddr = OrbitDB.isValidAddress(dbn) ? OrbitDB.parseAddress(dbn) : (await orbitDB.determineAddress(dbn, params.type, params))
      const dbID = dbAddr.toString()
      if (
        (pendingOpens.has(dbID)) ||
        (pendingReady.has(dbID)) ||
        (pendingLoad.has(dbID))
      ) {
        throw new Error(`Db ${dbID} already pending`)
      }

      pendingOpens.add(dbID)
      pendingReady.add(dbID)
      pendingLoad.add(dbID)

      if (isDefined(params.accessController)) {
        params.accessController = handleWeb3(params.accessController)
      }

      const errorHandler = (err) => {
        logger.warn(`Failed to open ${JSON.stringify(params)}: ${err}`)
        pendingOpens.delete(dbID)
        pendingReady.delete(dbID)
        pendingLoad.delete(dbID)
      }

      const dbOpen = orbitDB.open(dbn, params)

      const ensureLoad = async () => {
        logger.debug('ensureLoad()')
        try {
          const db = await dbOpen
          db.events.once('ready', () => {
            if (typeof peerMan.attachDB === 'function') {
              peerMan.attachDB(db)
            }
            pendingReady.delete(dbID)
          })
          await loadDB(db)
          pendingLoad.delete(dbID)
        } catch (err) {
          errorHandler(err)
        }
      }

      if (awaitOpen) {
        try {
          const db = await dbOpen
          pendingOpens.delete(dbID)
          const doLoad = ensureLoad()
          if (awaitLoad) await doLoad
          return db
        } catch (err) {
          errorHandler(err)
        }
      } else {
        ensureLoad()
      }

      return {

        address: dbAddr,
        id: dbID,
        name: params.name,
        type: params.type
      }
    }

    this.get = (dbn) => {
      const db = findDB(dbn)
      if (db) {
        return db
      } else {
        return null
      }
    }

    this.dbs = () => Object.values(orbitDB.stores)

    this.dbList = () => Object.values(orbitDB.stores).map((db) => dbInfo(db))

    const dbWrite = (db) => {
      if (db.access) {
        return (
          (typeof db.access.write !== 'undefined' && db.access.write) ||
        (typeof db.access.get === 'function' && db.access.get('write')) ||
        (typeof db.access._options === 'object' && db.access._options.write)
        )
      }
      return 'undefined'
    }

    this.dbWrite = dbWrite

    const canAppend = (writeList) => {
      if (writeList === 'undefined' || typeof writeList === 'undefined') return 'undefined'
      if (orbitDB.identity.id in writeList) return true
      if (typeof writeList.has === 'function' && writeList.has(orbitDB.identity.id)) return true
      if (typeof writeList.includes === 'function' && writeList.includes(orbitDB.identity.id)) return true
      return false
    }

    const dbInfo = (db) => {
      if (!db) return {}
      const write = dbWrite(db)
      const dbPeers = (typeof peerMan.getPeers === 'function' && peerMan.getPeers(db)) || []
      const oplog = db.oplog || db._oplog
      const replicator = db.replicator || db._replicator
      const dbId = db.address.toString()
      return {
        address: db.address,
        dbname: db.dbname,
        id: db.id,
        ready: !(pendingReady.has(dbId)),
        loaded: !(pendingLoad.has(dbId)),
        oplog: {
          length: oplog ? oplog.length : 'undefined'
        },
        replicationQueue: replicator ? { buffer: replicator._buffer, queue: replicator._queue } : 'undefined',
        options: db.options ? {
          create: db.options.create,
          indexBy: db.options.indexBy,
          localOnly: db.options.localOnly,
          maxHistory: db.options.maxHistory,
          overwrite: db.options.overwrite,
          path: db.options.path,
          replicate: db.options.replicate
        } : 'undefined',
        canAppend: canAppend(write),
        type: db.type,
        uid: db.uid,
        indexLength: db.index ? (db.index.length || Object.keys(db.index).length) : 'undefined',
        accessController: db.access ? {
          type: db.access.type || 'custom',
          write: write,
          capabilities: db.access.capabilities,
          address: db.access.address
        } : 'undefined',
        replicationStatus: db.replicationStatus,
        peers: dbPeers,
        peerCount: dbPeers.length,
        capabilities: Object.keys( // TODO: cleanup this mess once tc39 Object.fromEntries aproved, Nodejs version 12
          Object.assign({}, ...Object.entries({
            add: typeof db.add === 'function',
            get: typeof db.get === 'function',
            inc: typeof db.inc === 'function',
            iterator: typeof db.iterator === 'function',
            put: typeof db.put === 'function',
            putAll: typeof db.putAll === 'function',
            query: typeof db.query === 'function',
            remove: typeof (db.del || db.remove) === 'function',
            value: typeof db.value === 'number'
          }).filter(([_k, v]) => v).map(([k, v]) => ({ [k]: v }))
          )
        )
      }
    }

    this.dbInfo = dbInfo

    this.identity = () => {
      return orbitDB.identity
    }
  }
}

if (typeof module === 'object') module.exports = DBManager
