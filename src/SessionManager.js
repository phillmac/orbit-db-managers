class Subscription {
  constructor (h, emitter, type, listener) {
    Object.defineProperties(this, {
      h: {
        get: function () { return h }
      },
      type: {
        get: function () { return type }
      }
    })

    this.unsubscribe = () => {
      emitter.removeListener(listener)
      h.event('unregistered', { data: type })
    }

    emitter.on(type, listener)
  }
}

class Session {
  constructor (id) {
    const subscriptions = {}
    this.id = id

    this.createSubscription = (h, emitter, type, listener) => {
      const subscription = new Subscription(h, emitter, type, listener)
      if (!(h in subscriptions)) {
        subscriptions[h] = []
      }
      subscriptions[h].push(subscription)
      return subscription
    }

    this.unsubscribeAll = () => {
      for (const h of subscriptions) {
        for (const subscr of subscriptions[h]) {
          subscr.unsubscribe()
        }
        h.event(null)
      }
    }
  }
}

class SessionManager {
  constructor () {
    const sessions = {}
    this.register = (sessionId) => {
      const session = new Session(sessionId)
      sessions[sessionId] = session
      return session
    }

    this.unregister = (sessionId) => {
      if ((sessionId in sessions)) {
        sessions[sessionId].unsubscribeAll()
        delete sessions[sessionId]
      }
    }

    this.subscribe = (sessionId, h, emitter, type, listener) => {
      if (!(sessionId in sessions)) {
        this.register(sessionId)
      }
      const sess = sessions[sessionId]
      return sess.createSubscription(h, emitter, type, listener)
    }

    this.get = (sessionId) => {
      if (sessionId in sessions) {
        return sessions[sessionId]
      }
    }
  }
}

if (typeof module === 'object') {
  module.exports = SessionManager
}
