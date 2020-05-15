const isDefined = (arg) => arg !== undefined && arg !== null

const MakeQuerablePromise = (promise) => {
  // Don't modify any promise that has been already modified.
  if (promise.isResolved) return promise

  // Set initial state
  let isPending = true
  let isRejected = false
  let isFulfilled = false

  // Observe the promise, saving the fulfillment in a closure scope.
  const result = promise.then(
    function (v) {
      isFulfilled = true
      isPending = false
      return v
    },
    function (e) {
      isRejected = true
      isPending = false
      throw e
    }
  )

  result.isFulfilled = function () {
    return isFulfilled
  }
  result.isPending = function () {
    return isPending
  }
  result.isRejected = function () {
    return isRejected
  }
  return result
}

const getPeerId = (peer) => peer.id.toB58String ? peer.id.toB58String() : peer.id

class PeerManager {
  constructor (ipfs, orbitDB, options = {}) {
    if (!isDefined(options.PeerId)) {
      throw new Error('options.PeerId is a required argument.')
    }
    if (!isDefined(options.PeerInfo)) {
      throw new Error('options.PeerInfo is a required argument.')
    }
    if (!isDefined(options.multiaddr)) {
      throw new Error('options.multiaddr is a required argument.')
    }
    if (!isDefined(options.PeerStore)) {
      throw new Error('options.PeerStore is a required argument.')
    }

    if (!isDefined(options.EventEmitter)) {
      throw new Error('options.EventEmitter is a required argument.')
    }

    if (typeof options.PeerId !== 'function') {
      throw new Error('options.PeerId must be callable')
    }
    if (typeof options.PeerInfo !== 'function') {
      throw new Error('options.PeerInfo must be callable')
    }
    if (typeof options.multiaddr !== 'function') {
      throw new Error('options.multiaddr must be callable')
    }
    if (typeof options.EventEmitter !== 'function') {
      throw new Error('options.EventEmitter must be callable')
    }

    const peerManOptions = Object.assign({}, isDefined(options.peerMan) ? options.peerMan : options)
    const PeerStore = options.PeerStore
    const dbPeers = {}
    const peerSearches = {}
    const peersList = typeof PeerStore === 'function' ? new PeerStore() : PeerStore
    const PeerId = options.PeerId
    const PeerInfo = options.PeerInfo
    const multiaddr = options.multiaddr

    const logger = Object.assign({
      debug: function () {},
      info: function () {},
      warn: function () {},
      error: function () {}
    },
    options.logger,
    peerManOptions.logger
    )

    const announceDBs = async () => {
      logger.info('Announcing DBs')
      for (const db of Object.values(orbitDB.stores)) {
        await announceDB(db)
      }
      logger.info('Finished announcing DBs')
    }

    this.announceDBs = announceDBs

    const announceDB = async (db) => {
      logger.info(`Announcing ${db.address.toString()}`)
      try {
        await ipfs.dht.provide(db.address.root)
        logger.info(`Finished announcing ${db.address.toString()}`)
      } catch (err) {
        logger.warn('Error while announcing DB', err)
      }
    }

    this.announceDB = announceDB

    if (peerManOptions.announceDBs) {
      setInterval(function () {
        announceDBs(orbitDB.stores)
      }, peerManOptions.announceInterval || 1800000)
    }

    const searchDetails = (searchID) => {
      return {
        searchID: searchID,
        started: (peerSearches[searchID] && peerSearches[searchID].started) || '',
        options: (peerSearches[searchID] && peerSearches[searchID].options) || {}
      }
    }

    this.searchDetails = searchDetails

    this.getSearches = () => Object.keys(peerSearches).map(k => searchDetails(k))

    const swarmFindPeer = async (peerIDStr) => {
      for (const peer of await ipfs.swarm.addrs()) {
        if (peerIDStr.includes(getPeerId(peer))) {
          return peer
        }
      }
    }

    const resolvePeerId = async (peerID) => {
      let result
      if (PeerId.isPeerId(peerID)) peerID = peerID.toB58String()
      if (peersList.has(peerID)) return result // Short circuit

      const resolved = [
        MakeQuerablePromise(swarmFindPeer(peerID).then(function (peer) {
          peersList.put(peer, false)
          return peer
        })),
        MakeQuerablePromise(dhtFindPeer(peerID).search)
      ]

      while ((!result) && resolved.some(p => p.isPending())) {
        try {
          result = await Promise.race(resolved.filter(p => p.isPending()))
        } catch (err) {
          logger.warn(err)
        }
      }

      if (result) {
        const peerInfo = createPeerInfo(result)
        return peerInfo
      }
      throw new Error(`Unable to resolve peer ${peerID}`)
    }

    this.resolvePeerId = resolvePeerId

    const createPeerInfo = (details) => {
      if (PeerInfo.isPeerInfo(details)) return details // Short circuit
      let peerInfo
      if (PeerId.isPeerId(details)) return new PeerInfo(details)
      if (typeof details.ID === 'string') {
        peerInfo = new PeerInfo(PeerId.createFromB58String(details.ID))
      } else if (typeof details.id === 'string') {
        peerInfo = new PeerInfo(PeerId.createFromB58String(details.id))
      } else {
        throw new Error('Unhandled createPeerInfo', details) // Peer id property is something other then 'ID'
      }

      if (isDefined(details.Addrs)) {
        for (const addr of details.Addrs) {
          peerInfo.multiaddrs.add(multiaddr(addr))
        }
      }
      return peerInfo
    }

    this.createPeerInfo = createPeerInfo

    const dhtFindPeer = (peerIDStr) => {
      if (peerIDStr in peerSearches) {
        return {
          isNew: false,
          details: searchDetails(peerIDStr),
          search: peerSearches[peerIDStr].search
        }
      }
      logger.info(`Resolving addrs for ${peerIDStr}`)
      const search = ipfs.dht
        .findPeer(peerIDStr)
        .then(result => {
          peersList.put(result, false)
          delete peerSearches[peerIDStr]
          return result
        })
        .catch(err => {
          logger.warn(`Error while resolving addrs for ${peerIDStr}`, err)
        }).finally(() => {
          delete peerSearches[peerIDStr]
        })
      peerSearches[peerIDStr] = {
        started: Date.now(),
        search
      }
      return {
        isNew: true,
        details: searchDetails(peerIDStr),
        search
      }
    }

    this.dhtFindProvs = (hash, opts = {}) => {
      if (hash in peerSearches) {
        return {
          isNew: false,
          details: searchDetails(hash),
          search: peerSearches[hash].search
        }
      }
      const searchEvents = new options.EventEmitter()
      const search = new Promise((resolve, reject) => {
        searchEvents.on('abort', () => reject(new Error('Search aborted')))
        const doSearch = async () => {
          try {
            const findProvs = ipfs.dht.findProvs(hash, opts || {})
            const peers = []
            const handlePeer = (p) => {
              const peer = createPeerInfo(p)
              peers.push(peer)
              searchEvents.emit('peer', peer)
            }
            if (typeof findProvs[Symbol.asyncIterator] === 'function') {
              for await (const p of findProvs) {
                handlePeer(p)
              }
              resolve(peers)
            } else {
              for (const p of await findProvs) {
                handlePeer(p)
              }
              resolve(peers)
            }
          } catch (err) {
            reject(err)
          }
        }
        doSearch()
      })
      search.finally(() => delete peerSearches[hash])
      peerSearches[hash] = {
        started: Date.now(),
        options: opts,
        search,
        events: searchEvents
      }
      return {
        isNew: true,
        details: searchDetails(hash),
        search,
        events: searchEvents
      }
    }

    this.findPeers = (db, opts = {}) => {
      let search
      if (db.id in peerSearches) {
        return {
          isNew: false,
          details: searchDetails(db.id),
          search: peerSearches[db.id].search
        }
      }
      logger.info(`Finding peers for ${db.id}`)
      const customFindProvs = opts.CustomFindProvs || peerManOptions.CustomFindProvs
      if (customFindProvs) {
        logger.debug('Using custom findProvs')
        search = customFindProvs(db)
      } else {
        search = new Promise((resolve, reject) => {
          const findProvs = this.dhtFindProvs(db.address.root)
          const foundPeers = []
          findProvs.events.on('peer', peer => {
            foundPeers.push(addPeer(db, peer))
          })
          db.events.once('closing', () => {
            findProvs.events.emit('abort')
            reject(new Error('DB is closing'))
          })
          findProvs.then(() => resolve(foundPeers), (err) => reject(err))
        })
      }
      search.then(peers => {
        db.events.emit('search.complete', db.address.toString(), mapPeers(peers))
        logger.info(`Finished finding peers for ${db.id}`)
        return peers
      }).catch(err => {
        logger.warn(`Error while finding peers for ${db.id}`, err)
      }).finally(() => delete peerSearches[db.id])
      peerSearches[db.id] = {
        started: Date.now(),
        options: opts,
        search
      }
      return {
        isNew: true,
        details: searchDetails(db.id),
        search
      }
    }

    const mapPeers = (peers) => peers.map(p => {
      const peer = peersList.get(p)
      return {
        id: getPeerId(p),
        multiaddrs: peer.multiaddrs.toArray().map(m => m.toString())
      }
    })

    this.getPeers = (db) => {
      if (!(db.id in dbPeers)) return []
      return mapPeers(dbPeers[db.id])
    }

    this.allPeers = () => {
      return Object.values(peersList.getAll()).map(p => {
        return {
          id: getPeerId(p),
          multiaddrs: p.multiaddrs.toArray().map(m => m.toString())
        }
      })
    }

    this.removeDB = (db) => {
      db.events.emit('closing', db.address.toString())
      delete dbPeers[db.id]
      db.events.removeAllListeners('search.complete')
      db.events.removeAllListeners('closing')
    }

    const addPeer = (db, peer) => {
      if (!PeerInfo.isPeerInfo(peer)) peer = createPeerInfo(peer)
      peersList.put(peer, false)
      if (db.id in dbPeers) {
        dbPeers[db.id].push(getPeerId(peer))
      } else {
        logger.warn(`${db.id} not in dbPeers list`)
      }
      return peer
    }

    this.addPeer = addPeer

    this.attachDB = (db) => {
      dbPeers[db.id] = []
      db.events.on('peer', async function (peerID) {
        const peer = await swarmFindPeer(peerID)
        logger.debug(`Resolved peer from event ${getPeerId(peer)}`)
        addPeer(db, peer)
      })
      logger.debug('Attached db')
    }
  }
}

if (typeof module === 'object') module.exports = PeerManager
