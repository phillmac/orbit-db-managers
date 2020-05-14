const isDefined = (arg) => arg !== undefined && arg !== null

function removeItem (array, item) {
  const index = array.indexOf(item)
  if (index > -1) {
    return array.splice(index, 1)
  }
}

class DBManager {
  constructor (orbitDB, peerMan, options) {
    if (!isDefined(orbitDB)) { throw new Error('orbitDB is a required argument.') }
    const dbManOptions = Object.assign({}, isDefined(options.dbMan) ? options.dbMan : options)
    const OrbitDB = orbitDB.constructor

    peerMan = Object.assign({
      getPeers: function () {},
      attachDB: function () {}
    }, peerMan)

    const logger = Object.assign({
      debug: function () {},
      info: function () {},
      warn: function () {},
      error: function () {}
    },
    options.logger,
    dbManOptions.logger
    )

    this.events = orbitDB.events

    const pendingOpens = []
    const pendingReady = []
    const pendingLoad = []

    this.pendingOpens = () => [...pendingOpens]
    this.pendingReady = () => [...pendingReady]
    this.pendingLoad = () => [...pendingLoad]

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

    const handleWeb3 = (accessController) => {
      if (isDefined(accessController.web3)) {
        if (isDefined(dbManOptions.web3)) {
          accessController.web3 = new (dbManOptions.Web3 || options.Web3)(accessController.web3)
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

      const dbAddr = OrbitDB.isValidAddress(dbn) ? OrbitDB.parseAddress(dbn).toString() : (await orbitDB.determineAddress(dbn, params.type, params)).toString()

      if (
        (pendingOpens.includes(dbAddr)) ||
        (pendingReady.includes(dbAddr)) ||
        (pendingLoad.includes(dbAddr))
      ) {
        throw new Error(`Db ${dbAddr} already pending`)
      }

      pendingOpens.push(dbAddr)
      pendingReady.push(dbAddr)
      pendingLoad.push(dbAddr)

      if (isDefined(params.accessController)) {
        params.accessController = handleWeb3(params.accessController)
      }

      const errorHandler = (err) => {
        console.warn(`Failed to open ${JSON.stringify(params)}: ${err}`)
        removeItem(pendingOpens, dbAddr)
        removeItem(pendingReady, dbAddr)
        removeItem(pendingLoad, dbAddr)
      }

      const dbOpen = orbitDB.open(dbn, params)

      const ensureLoad = async () => {
        try {
          const db = await dbOpen
          db.events.once('load', () => removeItem(pendingLoad, dbAddr))
          db.events.once('ready', () => {
            if (typeof peerMan.attachDB === 'function') {
              peerMan.attachDB(db)
            }
            removeItem(pendingReady, dbAddr)
          })
          await db.load()
        } catch (err) {
          errorHandler(err)
        }
      }

      if (awaitOpen) {
        try {
          const db = await dbOpen
          removeItem(pendingOpens, dbAddr)
          const doLoad = ensureLoad()
          if (awaitLoad) await doLoad
          return db
        } catch (err) {
          errorHandler(err)
        }
      } else {
        ensureLoad()
      }

      return { address: dbAddr }
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
      return (
        (typeof db.access.write !== 'undefined' && db.access.write) ||
        (typeof db.access.get === 'function' && db.access.get('write')) ||
        (typeof db.access._options === 'object' && db.access._options.write) ||
        'undefined'
      )
    }

    this.dbWrite = dbWrite

    const canAppend = (writeList) => {
      if (orbitDB.identity.id in writeList) return true
      if (typeof writeList.has === 'function' && writeList.has(orbitDB.identity.id)) return true
      if (typeof writeList.includes === 'function' && writeList.includes(orbitDB.identity.id)) return true
      return false
    }

    const dbInfo = (db) => {
      if (!db) return {}
      const write = dbWrite(db)
      const dbPeers = (typeof peerMan.getPeers === 'function' && peerMan.getPeers(db)) || []
      return {
        address: db.address,
        dbname: db.dbname,
        id: db.id,
        ready: !(pendingReady.includes(db.address.toString())),
        loaded: !(pendingLoad.includes(db.address.toString())),
        oplog: {
          length: db.oplog ? db.oplog.length : 'undefined'
        },
        options: {
          create: db.options.create,
          indexBy: db.options.indexBy,
          localOnly: db.options.localOnly,
          maxHistory: db.options.maxHistory,
          overwrite: db.options.overwrite,
          path: db.options.path,
          replicate: db.options.replicate
        },
        canAppend: canAppend(write),
        type: db.type,
        uid: db.uid,
        indexLength: db.index ? (db.index.length || Object.keys(db.index).length) : 0,
        accessController: {
          type: db.access.type || 'custom',
          write: write,
          capabilities: db.access.capabilities,
          address: db.access.address
        },
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
