# Feathers RabbitMQ Transport

Configure a `broker` transport that uses a one-way message broker pattern to use to expose the services
of the app.

## Quick start

```bash
npm i feathers-rabbitmq-transport
```

```javascript
// In your app.js
const brokerTransport = require('feathers-rabbitmq-transport')

// Expose all the services through RabbitMQ
app.configure(brokerTransport())

// Expose only some services
app.configure(brokerTransport({
  sevices: {
    serviceName: [], // All the methods
    otherService: ['create', 'patch'], // Only create and patch methods
  }
}))

// Perform a side effect after connection
app.on('brokerTransportReady', () => {
  // perform a side effect
})

// Or check if the consumers are ready
if (app.get('brokerTransportReady')) {
  // do something
}
```

## Configuration

All the configurations can be provided as `env` variables:

- `BROKER_HOST`: To connect to. Example: `localhost`
- `BROKER_USER`: Optional. For authenticated connections. Example `user`.
- `BROKER_PASSWORD`: Optional. For authenticated connections. Example: `mypassword`.
- `BROKER_RETRY_CONNECTION`: Set it as `true` to retry connecting if the first attempt fails.
- `BROKER_TRANSPORT_EXCHANGE`: The topic exchange to use. See
[RabbitMQ docs](https://www.rabbitmq.com/tutorials/tutorial-five-javascript.html).

## How it works

The transport is very simple. As it's only one-way it does not implement the `get` and `find` methods.
It only works with the `create`, `update`, `patch` and `remove` methods.

Each service has a queue for each one of these methods binded with a routing key to a
[topic exchange](https://www.rabbitmq.com/tutorials/tutorial-five-javascript.html).
The exchange to use must be declared in the `BROKER_TRANSPORT_EXCHANGE` env variable and any producer
can send messages to that exchange with the routing keys:

- `<serviceName>.create`: and the data in the message.
- `<serviceName>.update.<id>`: and the data in the message.
- `<serviceName>.patch.<id>`: and the data in the message.
- `<serviceName>.remove.<id>`: and no data is needed, you can send an empty object.

As we don't want to repeat the creations or updates of the items if the app scale horizontally
we provide a single queue for each (service, method) pair with name `service-method`. So, please
ensure that there is no other consumer/service using the same queue name in the
`BROKER_TRANSPORT_EXCHANGE` exchange.

For the `params` object of the methods we only provide the `provider` property as `broker`. So in
a hook, for example, you can do:

```javascript
function myHook(context) {
  if (context.params.provider === 'broker') {
    // Do something
  }

  return context
}
```

You can explicitly attach the transport to only a subset of the services or only for some methods.
Using the `services` options you explicitly declare which services with which methods must be
exposed through this transport. If no `services` object is given it will expose all the services.
By default it habilitates all the methods, but if you want to expose only some of them you can
provide them like:

```javascript
{
  serviceName: ['create', 'patch'], // Only 'create' and 'patch' methods
  serviceName: [],  // All the methods
}
```

## `brokerTransportReady` event

Is a simple event emitted using the `app` after all the consumers are ready and it does not contains any data.
The package will set the `brokerTransportReady` setting in the app as `true` when its ready too.

## Author

- Fabián Souto <[fab.souto@gmail.com](mailto:fab.souto@gmail.com)>
