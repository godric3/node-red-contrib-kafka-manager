const logger = new (require('node-red-contrib-logger'))('Kafka Broker')
logger.sendInfo('Copyright 2023 Jaroslav Peter Prib')
const Metadata = require('./Metadata.js')
const getDataType = require('./getDataType.js')
// const State = require('./state.js')
const HostAvailable = require('./hostAvailable.js')
const zlib = require('node:zlib')
const CompressionTool = require('compressiontool')
const kafka = require('kafka-node')
const AdminConnection = require('./adminConnection.js')
const ClientConnnection = require('./clientConnection.js')
const nodeStatus = require('./nodeStatus.js')
require('events').EventEmitter.prototype._maxListeners = 30
/*
function processData (node, message, callFunction) {
  const dataType = getDataType(message.value)
  switch (dataType) {
    case 'Uint8Array':
    case 'Buffer':
      zlib.unzip(
        message.value, // buffer,
        { finishFlush: zlib.constants.Z_FULL_FLUSH },
        (err, buffer) => {
          if (err) {
            logger.active&&logger.send({ label: 'consumer.on.message buffer decompress', node: node.id, nodeName: node.name, error: err })
          } else {
            message.value = buffer
          }
          sendMessage2Nodered(node, message)
        })
      break
    default:
      sendMessage2Nodered(node, message)
  }
}
*/

function sendMsg (node, message) {
  if (message.value == null) return // seems to send an empty on connect if no messages waiting
  if (node.compressionType && node.compressionType !== 'none') {
    if (!node.compressor) {
      const compressorTool = new CompressionTool()
      node.compressor = compressorTool[node.compressionType]
    }
    node.compressor.decompress(message.value,
      (data) => {
        message.value = data
        sendMsgPostDecompose(node, message)
      },
      (err) => {
        if ((node.compressionError++) === 1) {
          logger.error({ label: 'compression failure', error: err })
          node.warn('decompression failure(s)')
        }
        sendMsgPostDecompose(node, message)
      }
    )
  } else { sendMsgPostDecompose(node, message) }
}

function sendMsgPostDecompose (node, message) {
  logger.active&&
    logger.send({
      label: 'sendMsg',
      node: node.id,
      message: {
        valueDataType: getDataType(message.value),
        topic: message.topic,
        offset: message.offset,
        partition: message.partition,
        highWaterOffset: message.highWaterOffset,
        key: message.key
      }
    })

  try {
//    if (!node.ready) {
    if(node.isNotAvailable()){
      node.available()
//      node.ready = true
      node.status({ fill: 'green', shape: 'ring', text: 'Ready' })
      if (message.value == null) return // seems to send an empty on connect in no messages waiting
    }
    if (node.timedout) {
      node.timedout = false
      node.status({ fill: 'green', shape: 'ring', text: 'Ready' })
    }
    const dataType = getDataType(message.value)
    switch (dataType) {
      case 'Uint8Array':
      case 'Buffer':
        zlib.unzip(
          message.value, // buffer,
          { finishFlush: zlib.constants.Z_FULL_FLUSH },
          (err, buffer) => {
            if (err) {
              logger.active&&logger.send({ label: 'consumer.on.message buffer decompress', node:{id:node.id,name: node.name}, error: err })
            } else {
              message.value = buffer
            }
            sendMessage2Nodered(node, message)
          })
        break
      default:
        sendMessage2Nodered(node, message)
    }
    if (node.closeOnEmptyQ &&
    message.offset === (message.highWaterOffset - 1)) {
      logger.active&&logger.send({ label: 'sendmsg', node: node.id, action: 'closing consumer as q empty' })
      node.log('consumer q empty so closing')
      node.consumer.close(true, function (err, message) {
        logger.active&&logger.send({ label: 'sendmsg', node:{id:node.id,name: node.name}, action: 'closed', error: err, message: message })
        if (err) node.error('close error:' + err)
      })
    }
  } catch (ex) {
    logger.sendErrorAndStackDump('sendmsg catch', ex)
  }
}

function sendMessage2Nodered (node, message) {
  if (node.convertToJson) {
    try {
      message.value = JSON.parse(message.value)
    } catch (ex) {
      message.error = 'JSON parse error: ' + ex.message
    }
  }
  const kafka = {
    topic: message.topic,
    offset: message.offset,
    partition: message.partition,
    highWaterOffset: message.highWaterOffset,
    key: message.key,
    commit: (node.autoCommitBoolean ? (callback) => callback()
      : (callback, callbackError) => {
        node.consumer.commit((err, data) => {
          if (err) {
            callbackError(err)
          } else {
            callback()
          }
        })
      }),
    rollback: (node.autoCommitBoolean ? (callback) => callback()
      : (callback, callbackError) => {
        logger.sendWarning('rollback close')
        node.close(callback, callbackError)
      })
  }
  node.send({
    topic: message.topic || node.topic,
    payload: message.value,
    _kafka: kafka
  })
}

function testCanConnect () {
  if (this.hostState.isNotAvailable()) throw Error('host not available')
  this.testConnected()
}
module.exports = function (RED) {
  function KafkaBrokerNode (n) {
    RED.nodes.createNode(this, n)
    try {
      const node = Object.assign(this, { hosts: [], Kafka: kafka}, n, {
        adminRequest: (request) => {
          logger.active&&logger.send({ label: 'adminRequest', action: request.action, properties: Object.keys(request) })
          if (!request.action) throw Error('action not provided')
          if (!request.callback) throw Error('callback not provided')
          if (!request.error) throw Error('error function not provided')
          const adminNode = node.adminConnection
          adminNode.whenUp(adminNode.request.bind(adminNode), request)
        },
        debugNode:()=>logger.setOn(),
        getConnection: (type, okCallback=()=>{throw Error("no ok callback")}, errorCallback=()=>{throw Error("no error callback")}) => {
          logger.active&&logger.send({ label: 'getConnection', type: type, node: node.id})
          try{
            const KafkaType = kafka[type]
            const connection = new KafkaType(node.client.connection)
            connection.on('error', function (ex) {
              logger.active&&logger.send({ label: 'getConnection on.error', type: type, node:{id:node.id,name: node.name}, error: ex.message })
              errorCallback(node.getRevisedMessage(ex.message))
            })
            connection.on('connect', function () {
              logger.active&&logger.send({ label: 'getConnection connectKafka.on.connect', type: type, node:{id:node.id,name: node.name} })
 //             okCallback(connection)
            })
            okCallback(connection)
          } catch(ex) {
            logger.active&&logger.send({ label: 'getConnection catch', type: type, node:{id:node.id,name: node.name}, error: ex.message })
            errorCallback(ex.message)
          }
        },
        getClient: () => new ClientConnnection(this,
            (message) => {
              logger.active&&logger.send({ label: 'getclient called',node:{id:node.id,name:node.name},data:message})
            }
          ),
        hostsCombined: [],
        sendMsg: sendMsg.bind(this),
        testCanConnect: testCanConnect.bind(this),
        nodeStatus:nodeStatus
      })
      if (node.hostsEnvVar) {
        if (node.hostsEnvVar in process.env) {
          try {
            const hosts = JSON.parse(process.env[node.hostsEnvVar])
            if (hosts) {
              logger.send({ label: 'test', hosts: hosts })
              if (hosts instanceof Array) {
                node.hostsCombined = node.hostsCombined.concat(hosts)
              } else {
                throw Error('not array value: ' + process.env[node.hostsEnvVar])
              }
            }
          } catch (ex) {
            const error = 'process.env variable ' + node.hostsEnvVar + ex.toString()
            throw Error(error)
          }
        } else { throw Error('process.env.' + node.hostsEnvVar + ' not found') }
      }
      if (node.hosts.length === 0 && node.host) {
        node.hosts.push({ host: node.host, port: node.port })
      }
      node.hostsCombined = node.hostsCombined.concat(node.hosts)
      if (node.hostsCombined.length === 0) throw Error('No hosts')
      logger.send({ hosts: node.hostsCombined })
      node.kafkaHost = node.hostsCombined.map((r) => r.host + ':' + r.port).join(',')
      node.getKafkaDriver = () => kafka
      node.getKafkaClient = (optionsOrridden) => {
        const options = Object.assign({
          kafkaHost: node.kafkaHost,
          connectTimeout: node.connectTimeout || 10000,
          requestTimeout: node.requestTimeout || 30000,
          autoConnect: (node.autoConnect || 'true') === 'true',
          idleConnection: node.idleConnection || 5,
          reconnectOnIdle: (node.reconnectOnIdle || 'true') === 'true',
          maxAsyncRequests: node.maxAsyncRequests || 10
        }, optionsOrridden)
        logger.active&&logger.send({ label: 'getKafkaClient', usetls: node.usetls, options: options })
        if (node.usetls) {
          options.sslOptions = { rejectUnauthorized: node.selfSign }
          logger.active&&logger.send({ label: 'getKafkaClient use tls', selfSign: node.selfSign })
          try {
            if (!(node.selfServe || node.tls)) throw Error('not self serve or no tls configuration selected')
            if (node.tls) {
              node.tlsNode = RED.nodes.getNode(node.tls)
              if (!node.tlsNode) throw Error('tls configuration not found')
              //        Object.assign(options.sslOptions,node.tlsNode.credentials);
              node.tlsNode.addTLSOptions(options.sslOptions)
              logger.active&&logger.send({ label: 'getKafkaClient ssl Options', properties: Object.keys(options.sslOptions) })
            }
          } catch (e) {
            node.error('get node tls ' + node.tls + ' failed, error:' + e)
          }
        }
        if (options.useCredentials) {
          logger.active&&logger.send({ label: 'getKafkaClient node has configured credentials, note sasl mechanism is plain' })
          options.sasl = {
            mechanism: 'plain',
            username: this.credentials.user,
            password: node.credentials.password
          }
        }
        logger.active&&logger.send({ label: 'getKafkaClient return client', options: Object.assign({}, options, options.sslOptions ? { sslOptions: '***masked***' } : null) })
        return ((node.connectViaZookeeper || false) === true)
          ? new kafka.Client(options)
          : new kafka.KafkaClient(options)
      }
      node.getRevisedMessage = (err) => {
        if (typeof err === 'string' && err.startsWith('connect ECONNREFUSED')) return 'Connection refused, check if Kafka up'
        return err
      }
      node.hostState = new HostAvailable(node.hosts, node.checkInterval * 1000,(message)=>{logger.active&&logger.send(message)})
      node.beforeDown = node.hostState.beforeDown
      node.onDown = node.hostState.onDown
      node.setDown = node.hostState.setDown
      node.onUp = node.hostState.onUp
      this.client = node.getClient()
      node.hostState
        .onDown(next=>{
          node.log('host state change down '+JSON.stringify({node:{id:node.id,name:node.name}}))
          if (node.client.isAvailable()){
            node.log('host state change down client.isAvailable forcing down'+JSON.stringify({node:{id:node.id,name:node.name}}))
            node.client.forceDown(()=>{
              node.log('host state change down client.isAvailable forced down'+JSON.stringify({node:{id:node.id,name:node.name}}))
              next()
            })
          }
          next()
        }).onUp(next=> {
          node.log('host state change up'+JSON.stringify({node:{id:node.id,name:node.name}}))
          node.client.setUp(next=>{
            logger.active&&logger.send({ label: 'client onUp',node:{id:node.id,name:node.name}})
            next()
          })
          next()
        })
      node.metadata = new Metadata(node, logger)
      node.onChangeMetadata = node.metadata.onChange.bind(node.metadata)
      node.metadataRefresh = node.metadata.refresh.bind(node.metadata)
      node.getTopicsPartitions = node.metadata.getTopicsPartitions.bind(node.metadata)
      node.adminConnection = new AdminConnection(node)
      node.client.onUp(next=>{
        logger.active&&logger.send({ label: 'client.onUp',node:{id:node.id,name:node.name}})
        node.adminConnection.setUp(next=>{
          logger.active&&logger.send({ label: 'client.onUp.adminConnection.setup done',node:{id:node.id,name:node.name}})
          next&&next()
        })
        next()
      }).onDown(next=>{
        logger.active&&logger.send({ label: 'client.onDown',node:{id:node.id,name:node.name}})
        node.adminConnection.setDown(next=>{
          logger.active&&logger.send({ label: 'client.adminConnection.onDown setDown',node:{id:node.id,name:node.name}})
          next&&next()
        })
        next()
      }).onUp(node.metadata.startRefresh.bind(node.metadata))
      .onDown(node.metadata.stopRefresh.bind(node.metadata))
      node.close = function (removed, done) {
        logger.active&&logger.send({ label: 'close',node:{id:node.id,name:node.name}})
        try {
          node.setDown(done)
        } catch (ex) {
          logger.sendErrorAndStackDump(ex.message, ex)
          node.forceDown(done)
        }
      }
    } catch (ex) {
      this.status({ fill: 'red', shape: 'ring', text: ex.toString() })
      logger.sendErrorAndStackDump(ex.message, ex)
      this.error(ex.toString())
    }
  }
  RED.nodes.registerType(logger.label, KafkaBrokerNode, {
    credentials: {
      user: {
        type: 'text'
      },
      password: {
        type: 'password'
      }
    }
  })
}
