const isDefined = (arg) => arg !== undefined && arg !== null

class DBManager {
  constructor (orbitDB, peerMan, options) {
    if (!isDefined(orbitDB)) { throw new Error('orbitDB is a required argument.') }
    const dbManOptions = Object.assign({}, isDefined(options.dbMan) ? options.dbMan : options)

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

    const openCreate = async (dbn, params) => {
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

      if (
        (pendingOpens.includes(dbn)) ||
        (pendingReady.includes(dbn)) ||
        (pendingLoad.includes(dbn))
      ) {
        throw new Error(`Db ${dbn} already pending`)
      }
      pendingOpens.push(dbn)
      pendingReady.push(dbn)
      pendingLoad.push(dbn)

      if (isDefined(params.accessController)) {
        params.accessController = handleWeb3(params.accessController)
      }

      const dbOpen = orbitDB.open(dbn, params)
      dbOpen.then(async (db) => {
        pendingOpens.pop(dbn)
        db.events.once('ready', () => {
          if (typeof peerMan.attachDB === 'function') {
            peerMan.attachDB(db)
          }
          pendingReady.pop(dbn)
        })
        if ((!awaitOpen) || (!awaitLoad)) {
          await db.load()
          pendingLoad.pop(dbn)
        }
        return db
      }).catch((err) => { console.warn(`Failed to open ${params}: ${err}`) })

      if (awaitOpen) {
        const db = await dbOpen
        if (awaitLoad) {
          await db.load()
          pendingLoad.pop(dbn)
        }
        return db
      }
    }

    this.get = async (dbn, params) => {
      const db = findDB(dbn)
      if (db) {
        return db
      } else {
        return openCreate(dbn, params)
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
        ready: !(pendingReady.contains(db.id)),
        loaded: !(pendingLoad.contains(db.id)),
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
