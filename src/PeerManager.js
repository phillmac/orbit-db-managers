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

class PeerManager {
  constructor ({ ipfs, orbitDB, PeerId, PeerInfo, multiaddr, PeerStore, EventEmitter, options = {} }) {
    if (!isDefined(PeerId)) {
      throw new Error('PeerId is a required argument.')
    }
    if (!isDefined(PeerInfo)) {
      throw new Error('PeerInfo is a required argument.')
    }
    if (!isDefined(multiaddr)) {
      throw new Error('multiaddr is a required argument.')
    }
    if (!isDefined(PeerStore)) {
      throw new Error('PeerStore is a required argument.')
    }
    if (!isDefined(EventEmitter)) {
      throw new Error('EventEmitter is a required argument.')
    }

    if (typeof PeerId !== 'function') {
      throw new Error('PeerId must be callable')
    }
    if (typeof PeerInfo !== 'function') {
      throw new Error('PeerInfo must be callable')
    }
    if (typeof multiaddr !== 'function') {
      throw new Error('multiaddr must be callable')
    }
    if (typeof EventEmitter !== 'function') {
      throw new Error('EventEmitter must be callable')
    }

    const findOptionValue = (optName, def) => {
      if (isDefined(options.peerMan) && isDefined(options.peerMan[optName])) return options.peerMan[optName]
      if (isDefined(options[optName])) return options[optName]
      return def
    }

    const dbPeers = {}
    const peerSearches = {}
    const peersList = typeof PeerStore === 'function' ? new PeerStore() : PeerStore
    const Logger = findOptionValue('logger')
    const trackPeers = findOptionValue('trackPeers', false)
    const logger = (
      typeof Logger.create === 'function' ? Logger.create('peer-manager', { color: Logger.Colors.Green }) : Object.assign({
        debug: function () {},
        info: function () {},
        warn: function () {},
        error: function () {}
      },
      Logger
      )
    )

    const getPeerId = (peer) => {
      if (typeof peer === 'string') return peer
      const peerID = peer.id || peer.ID
      if (isDefined(peerID)) {
        if (typeof peerID === 'string') return peerID
        if (typeof peerID.toB58String === 'function') return peerID.toB58String()
      }
      logger.warn(`Unkown peer id ${peer}`)
      return ''
    }

    const getPeerAddrs = (peer) => {
      if (peer.multiaddrs) {
        return peer.multiaddrs.toArray()
      }
      if (peer.addrs) return peer.addrs
      logger.warn(`Unkown peer addrs ${peer}`)
      return []
    }

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

    if (findOptionValue('announceDBs', false)) {
      setInterval(function () {
        announceDBs(orbitDB.stores)
      }, findOptionValue('announceInterval', 1800000))
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
          peersList.put(peer)
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
      const peerAddrs = details.Addrs || details.addrs
      if (isDefined(peerAddrs)) {
        for (const addr of peerAddrs) {
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
          peersList.put(result)
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
          search: peerSearches[hash].search,
          events: peerSearches[hash].events
        }
      }
      logger.info(`Finding peers for ${hash}`)
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
      const customFindProvs = opts.CustomFindProvs || findOptionValue('CustomFindProvs')
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
          if (db.events) {
            db.events.once('closing', () => {
              findProvs.events.emit('abort')
              reject(new Error('DB is closing'))
            })
          }
          findProvs.search.then(() => resolve(foundPeers), (err) => reject(err))
        })
      }
      search.then(peers => {
        if (db.events) {
          db.events.emit('search.complete', db.address.toString(), mapPeers(peers))
        }
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
      const peer = peersList.get(getPeerId(p))
      if (peer) {
        return {
          id: getPeerId(peer),
          multiaddrs: getPeerAddrs(peer).map(m => m.toString())
        }
      }
    }).filter(p => isDefined(p))

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
      peersList.put(peer)
      if (!(db.id in dbPeers)) dbPeers[db.id] = []
      dbPeers[db.id].push(getPeerId(peer))
      return peer
    }

    this.addPeer = addPeer

    this.attachDB = (db) => {
      if (!(db.id in dbPeers)) dbPeers[db.id] = []
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
