function customFindProvs (ipfs, logger, createPeerInfo, addPeer) {
  if (typeof ipfs.send !== 'function') throw new Error('ipfs.send is required')
  this.search = (db) => {
    logger.debug('Using custom findProvs')
    return new Promise((resolve, reject) => {
      db.events.once('closing', () => {
        req.abort()
        reject(new Error('DB is closing'))
      })
      const req = ipfs.send(
        {
          path: 'dht/findprovs',
          args: db.address.root
        },
        (err, result) => {
          if (err) {
            reject(err)
          }
          if (result) {
            let peers = []
            result.on('end', () => resolve(peers))
            result.on('data', chunk => {
              if (chunk.Type === 4) {
                const newPeers = chunk.Responses.map(r => createPeerInfo(r))
                logger.debug(`Found peers from DHT: ${JSON.stringify(chunk.Responses)}`)
                for (const peer of newPeers) {
                  addPeer(db, peer)
                }
                peers = peers.concat(newPeers)
              }
            })
          } else {
            reject(new Error('Empty result from dht/findprovs'))
          }
        }
      )
    })
  }
}

if (typeof module === 'object') module.exports = customFindProvs
