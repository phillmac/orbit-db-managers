const pMap = require('p-map')
const PeerId = require('peer-id')
const OrbitDB = require('orbit-db')
const Logger = require('logplease')
const PeerInfo = require('peer-info')
const multiaddr = require('multiaddr')
const { default: PQueue } = require('p-queue')
const PeerStore = require('libp2p/src/peer-store')
const { EventEmitter } = require('events')
const PeerManager = require('./PeerManager.js')
const DBManager = require('./DBManager.js')
const SessionManager = require('./SessionManager.js')

const deps = {
  EventEmitter,
  Logger,
  multiaddr,
  PeerId,
  PeerInfo,
  PeerStore,
  pMap,
  PQueue
}

const getManagers = async (ipfs, options = {}) => {
  const orbitDB = await OrbitDB.createInstance(ipfs, options.orbitDB)
  const peerMan = new PeerManager({ ipfs, orbitDB, ...deps, options })
  return {
    orbitDB,
    peerMan,
    dbMan: new DBManager({ ipfs, orbitDB, peerMan, ...deps, options }),
    sessionMan: new SessionManager()
  }
}

module.exports = getManagers
