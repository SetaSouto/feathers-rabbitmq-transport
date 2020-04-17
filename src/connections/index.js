const amqp = require('amqplib')
const logger = require('../logger')('connections:broker')

const {
  BROKER_HOST, BROKER_USER, BROKER_PASSWORD, BROKER_RETRY_CONNECTION
} = process.env

if (!BROKER_HOST) throw new Error('There is no BROKER_HOST env variable.')

/**
 * A basic broker implementation that generates a new connection.
 */
class Broker {
  /**
   * Initialize the broker and set the exchange and it's type.
   * @param {String} exchange The name of the exchange to connect to.
   * @param {String} [type] The type of the exchange. Default to `topic`.
   */
  constructor (exchange, type = 'topic') {
    this.exchange = exchange
    this.type = type
    this.connection = null
    this.channel = null
    this.connected = false
  }

  /**
   * Connect to RabbitMQ.
   * Create the connection, the channel and assert the exchange.
   */
  async connect () {
    if (this.connected) return Promise.resolve()

    const connectionString = BROKER_USER && BROKER_PASSWORD
      ? `amqp://${BROKER_USER}:${BROKER_PASSWORD}@${BROKER_HOST}`
      : `amqp://${BROKER_HOST}`

    return amqp.connect(connectionString)
      .then((connection) => {
        this.connection = connection
        this.connection.on('close', () => {
          this.connected = false
          logger.info('Connection closed, reconnecting.')
          return this.connect()
        })
        return connection.createChannel()
      })
      .then((channel) => {
        this.channel = channel
        this.channel.on('close', () => {
          this.connected = false
          logger.warn('Channel closed, reconnecting.')
          this.connect()
        })
        this.channel.assertExchange(this.exchange, this.type, { durable: false })
        this.connected = true
      })
      .catch((error) => {
        logger.error(error)
        if (BROKER_RETRY_CONNECTION === 'true') {
          logger.info('Retrying to reconnect in 5 seconds.')
          return new Promise((resolve) => {
            setTimeout(async () => {
              await this.connect()
              resolve()
            }, 5000)
          })
        }
      })
  }
}

/**
 * A class to have instances to send messages to the broker.
 */
class Producer extends Broker {
  /**
   * Initialize the producer.
   * @param {String} exchange The name of the exchange to connect to.
   * @param {String} key The routing key where to send the messages.
   */
  constructor (exchange, key) {
    super(exchange)
    this.key = key
  }

  /**
   * Send an object as a message to this producer's exchange with its routing key.
   * @param {Object} msg The object to send as message.
   */
  send (msg) {
    return this.channel.publish(this.exchange, this.key, Buffer.from(JSON.stringify(msg)))
  }
}

/**
 * A class to have instances to consume messages from the broker.
 */
class Consumer extends Broker {
  /**
   * Initialize the consumer.
   * @param {String} exchange The name of the exchange to connect to.
   * @param {String} key The routing key where to listen for messages.
   * @param {String} queue The name of the queue to consume.
   */
  constructor (exchange, key, queue = '') {
    super(exchange)
    this.key = key
    this.queue = queue
  }

  /**
   * Connect to RabbitMQ and bind the queue with the exchange using the consumer's
   * routing key.
   */
  connect () {
    return super.connect()
      .then(() => {
        /* Queues cannot start with amq.*, get a random name instead */
        if (this.queue.startsWith('amq.')) this.queue = ''
        return this.channel.assertQueue(this.queue)
      })
      .then((q) => {
        this.queue = q.queue
        logger.info(`Asserted queue "${this.queue}", binding to exchange "${this.exchange}" with key "${this.key}"`)
        return this.channel.bindQueue(this.queue, this.exchange, this.key)
      })
  }

  /**
   * Start consuming from the queue. You must pass a callback function to do what you need
   * with the parse object coming in the content of the message.
   * @param {Function} callback A callback function that receives a parsed JSON object that is
   * the content of the message and the routing key of the message.
   */
  consume (callback) {
    this.channel.consume(this.queue, (msg) => {
      try {
        const body = JSON.parse(msg.content.toString())
        return callback(body, msg.fields.routingKey)
      } catch (err) {
        logger.error(err)
        logger.debug(msg.content.toString())
      }
    }, { noAck: true })
  }
}

module.exports = {
  Consumer,
  Producer
}
