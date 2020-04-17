const createLogger = require('winston-namespace')

/**
 * Wrap the winston-namespace function to add the project's name
 * before the namespace.
 */
module.exports = namespace => createLogger(`feathers-rabbitmq-transport:${namespace}`)
