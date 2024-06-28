const logger = new (require('node-red-contrib-logger'))('setupHttpAdmin')
logger.sendInfo('Copyright 2023 Jaroslav Peter Prib')
function adminRequest (node, res, data, err) {
  if (err) {
    node.error(err)
    res.status(500).send(err)
    return
  }
  res.status(200).send(data||"OK")
}

function setupHttpAdmin (RED, nodeType, actions) {
  RED.httpAdmin.get('/' + nodeType.replace(/ /g, '_') + '/:id/:action/', RED.auth.needsPermission('KafkaAdmin.write'), function (req, res) {
    const node = RED.nodes.getNode(req.params.id)
    if (node && node.type === nodeType) {
      try {
        const action = req.params.action
        node.log('httpAdmin request ' + action)
        if (!(action in actions)) throw Error('unknown action: ' + action)
        const callFunction = actions[action].bind(node)
        callFunction(RED, node, (data, err) => {
          logger.active&&logger.info({ label: 'setupHttpAdmin', action:action, data: data, error: err})
          adminRequest(node, res, data, err)
        },
        req.params, req.body
        )
      } catch (ex) {
        logger.active&&logger.error({ label: 'setupHttpAdmin', error: ex.messsage, stack: ex.stack })
        adminRequest(node, res, null, 'Internal Server Error, ' + req.params.action + ' failed ' + ex.toString())
      }
    } else {
      res.status(404).send('request to ' + req.params.action + ' failed for id:' + req.params.id)
    }
  })
}
module.exports = setupHttpAdmin
