const amqp = require('amqplib')
const logger = require('../logger')('broker')

const {
  BROKER_HOST, BROKER_USER, BROKER_PASSWORD, BROKER_RETRY_CONNECTION
} = process.env


/**
 * A basic broker implementation that can generate a new connection
 * to the RabbitMQ server.
 */
class Broker {
  /**
   * Initialize the broker and set the exchange.
   * 
   * You can provide the connection values (host, user, password and retry)
   * or they will be extracted from the environment variables `BROKER_HOST`,
   * `BROKER_USER`, `BROKER_PASSWORD` and `BROKER_RETRY_CONNECTION`.
   * 
   * The only required value is the `host` and if the RabbitMQ instance
   * needs the `user` and `password` it will trigger the corresponding error
   * if they are not provided.
   * 
   * The `retry` option allow to wait 5 seconds and retry connecting to the
   * RabbitMQ instance. Can be useful when orchestrating development environments
   * as with docker compose for example.
   * 
   * @param {String} exchange the name of the exchange to connect to.
   * @param {Object} [options]
   * @param {Object} [options.connection] an optional connection object with the
   * `host`, `user`, `password` and `retry` to connect to the RabbitMQ instance.
   * @param {Object} [options.exchange] an optional object with the options
   * for the exchange. 
   */
  constructor(exchange, options = {}) {
    this.options = options
    this.options.connection = {
      host: BROKER_HOST,
      user: BROKER_USER,
      password: BROKER_PASSWORD,
      retry: BROKER_RETRY_CONNECTION === 'true',
      ...(options.connection || {})
    }

    if (!exchange) {
      throw new Error('Please provide an "exchange".')
    }

    if (!this.options.connection.host) {
      throw new Error('No "host" provided in the connection object and there is no BROKER_HOST env variable.')
    }

    this.exchange = exchange
    this.connection = null
    this.channel = null
    this.connected = false
  }

  /**
   * Connect to RabbitMQ.
   *
   * It creates the connection, the channel and assert the exchange.
   */
  async connect() {
    if (this.connected) return Promise.resolve()

    const { host, user, password } = this.options.connection
    const connectionString = `amqp://${user && password ? `${user}:${password}` : ''}@${host}`

    return amqp.connect(connectionString).then(async connection => {
      this.connection = connection

      this.connection.on('close', () => {
        this.connected = false
        logger.info('Connection closed, reconnecting.')
        return this.connect()
      })

      this.channel = await connection.createChannel()

      this.channel.on('close', () => {
        this.connected = false
        logger.warn('Channel closed, reconnecting.')
        this.connect()
      })

      this.channel.assertExchange(this.exchange, 'topic', this.options.exchange)
      this.connected = true
    }).catch((error) => {
      if (!this.options.connection.retry) throw error;

      logger.error(error)
      logger.info('Retrying to reconnect in 5 seconds.')

      return new Promise(resolve => setTimeout(() => this.connect().then(resolve), 5000))
    })
  }
}

/**
 * A class to have producers to send JSON messages to the broker using a routing key.
 */
class Producer extends Broker {
  /**
   * Initialize the producer and set the exchange and the optional default
   * routing key.
   *
   * @param {String} exchange name of the exchange to connect to.
   * @param {Object} [options] see `Broker` class docs. 
   * @param {String} [options.key] default routing key to send the messages.
   */
  constructor(exchange, options = {}) {
    super(exchange, options)
  }

  /**
   * Send an object as a message to this producer's exchange with its routing key.
   * @param {Object} msg The object to send as message.
   */
  send(msg, key) {
    if (!key && !this.options.key) {
      throw new Error('Please provide a routing key. There is no default one.')
    }

    return this.channel.publish(this.exchange, key || this.options.key, Buffer.from(JSON.stringify(msg)))
  }
}

/**
 * A class to have consumers to consume messages from the broker.
 */
class Consumer extends Broker {
  /**
   * Initialize the consumer and set the exchange, routing key and
   * queue name to connect to.
   * 
   * If you want that multiples consumers use the same queue you must provide
   * its name. Useful for horizontal scaling.
   *
   * @param {String} exchange name of the exchange to connect to.
   * @param {String} key routing key where to listen for messages.
   * @param {Number} [options.prefetch] set the maximum number of messages
   * sent over the channel of this consumer that can be awaiting acknowledgement.
   * @param {String} [options.queue] name of the queue to consume. Default to empty string
   * to generate a random one.
   * @param {Boolean} [options.requeue] set to `true` to requeue the nacked messages.
   * See: https://www.squaremobius.net/amqp.node/channel_api.html#channel_nack
   */
  constructor(exchange, key, options = {}) {
    super(exchange, options)

    if (!key) {
      throw new Error('Please provide a routing key.')
    }

    this.key = key

    if (options.queue && options.queue.startsWith('amq.')) {
      throw new Error('Queues cannot start with amq.*')
    }
  }

  /**
   * Connect to RabbitMQ and bind the queue with the exchange using the consumer's
   * routing key.
   */
  connect() {
    return super.connect().then(async () => {
      this.channel.prefetch(this.options.prefetch)

      const { queue } = await this.channel.assertQueue(this.options.queue || '')
      this.options.queue = queue

      logger.info(`Asserted queue "${this.options.queue}", binding to exchange "${this.exchange}" with key "${this.key}"`)

      return this.channel.bindQueue(this.options.queue, this.exchange, this.key)
    })
  }

  /**
   * Start consuming from the queue. You must pass a callback function to do what you need
   * with the parse object coming in the content of the message.
   * 
   * @param {Function} callback A callback function that receives a parsed JSON object that is
   * the content of the message and the routing key of the message. It must return a promise
   * to acknowledge the message after it.
   */
  consume(callback) {
    this.channel.consume(this.queue, async msg => {
      try {
        await callback(JSON.parse(msg.content.toString()), msg.fields.routingKey)
        this.channel.ack(msg)
      } catch (err) {
        this.channel.nack(msg, false, !!this.options.requeue);
        logger.error(err)
        logger.debug(msg.content.toString())
      }
    })
  }
}

module.exports = {
  Consumer,
  Producer
}
