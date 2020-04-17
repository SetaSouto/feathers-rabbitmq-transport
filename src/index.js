const createLogger = require('./logger')
const { Consumer } = require('../../connections/broker')

const { BROKER_TRANSPORT_EXCHANGE } = process.env

if (!BROKER_TRANSPORT_EXCHANGE) {
  throw new Error('Please provide the BROKER_TRANSPORT_EXCHANGE env variable to use the Broker transport')
}

/**
 * Create a function to configure the `Broker` transport that uses a one-way message broker
 * pattern to access to the services of the app.
 *
 * The transport is very simple. As it's only one-way it does not implement the `get` and
 * `find` methods. It only works with the `create`, `update`, `patch` and `remove` methods.
 *
 * Each service has a queue for each one of these methods. The exchange to use must be
 * declared in the `BROKER_TRANSPORT_EXCHANGE` env variable and any producer can send
 * messages to that exchange with the routing keys:
 *
 * - `<serviceName>.create`: and the data in the message.
 * - `<serviceName>.update.<id>`: and the data in the message.
 * - `<serviceName>.patch.<id>`: and the data in the message.
 * - `<serviceName>.remove.<id>`: and no data is needed, you can send an empty object.
 *
 * As we don't want to repeat the creations or updates of the items if the app scale horizontally
 * we provide a single queue for each (service, method) pair with name `service-method`. So, please
 * ensure that there is no other consumer/service using the same queue name in the
 * `BROKER_TRANSPORT_EXCHANGE` exchange.
 *
 * For the `params` object of the methods we only provide the `provider` property as `broker`.
 *
 * @param {Object} [options.services] explicitly declare which services with which methods must be
 *  exposed through this transport. If no `services` object is given it will expose all the services.
 *  By default it habilitates all the methods, but if you want to expose only some of them you can
 *  provide them like:
 *  ```
 *  {
 *    <serviceName>: ['create', 'patch'], // Only 'create' and 'patch' methods
 *    <serviceName>: [],  // All the methods
 *  }
 *  ```
 */
module.exports = ({ services }) => {
  return app => {
    const appServices = Object.keys(app.services)
    const habilitatedServices = []
    const logger = createLogger('configure')

    if (services) {
      habilitatedServices.push(...Object.keys(services))
    } else {
      habilitatedServices.push(...appServices)
      // Habilitate all the app's services
      services = {}
      appServices.forEach(service => {
        services[service] = [] // All the methods
      })
    }

    logger.info(`Configuring "Broker" transport for services: ${habilitatedServices}`)

    Promise.all(habilitatedServices.map(service => {
      const habilitatedMethods = services[service]

      // No method provided, habilitate all
      if (!habilitatedMethods.length) {
        habilitatedMethods.push('create', 'update', 'patch', 'remove')
      }

      // Map between the service's method and its routing key
      const allKeys = {
        create: `${service}.create`,
        // * to match exact one word (id).
        // See: https://www.rabbitmq.com/tutorials/tutorial-five-javascript.html
        update: `${service}.update.*`,
        patch: `${service}.patch.*`,
        remove: `${service}.remove.*`
      }

      // Get the routing keys for this service
      const habilitatedKeys = []
      habilitatedMethods.forEach(method => {
        if (habilitatedMethods.includes(method)) {
          habilitatedKeys.push([method, allKeys[method]])
        }
      })

      return Promise.all(habilitatedKeys.map(async ([method, key]) => {
        const logger = createLogger(`${service}:${method}`)
        logger.info(`Habilitating method "${method}" for service "${service}" in the Broker transport`)

        const queue = `${service}-${method}`
        const consumer = new Consumer(BROKER_TRANSPORT_EXCHANGE, key, queue)
        try {
          await consumer.connect()
          consumer.consume((data, routingKey) => {
            try {
              const params = { provider: 'broker' }

              if (method === 'create') {
                app.service(service).create(data, params)
              } else {
                const id = routingKey.split('.').slice(-1)[0]
                app.service(service)[method](id, data, params)
              }
            } catch (err) {
              logger.error(err)
            }
          })
        } catch (err) {
          logger.error(err)
        }
      }))
    }))
  }
}
