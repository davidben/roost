var express = require('express');
var http = require('http');
var path = require('path');
var util = require('util');

var conf = require('../lib/config.js');
var connections = require('../lib/connections.js');
var db = require('../lib/db.js');
var error = require('../lib/error.js');
var msgid = require('../lib/msgid.js');
var Subscriber = require('../lib/subscriber.js').Subscriber;

function stringOrNull(arg) {
  if (arg == null)
    return null;
  return String(arg);
}

function sendError(res, err) {
  if (err instanceof error.UserError) {
    res.send(err.code, err.msg);
  } else {
    res.send(500);
  }
}

var subscriber = new Subscriber();

var app = express();

app.use(express.bodyParser());
// CORS ALL THE THINGS. We won't use cookies and this is different
// from Access-Control-Allow-Credentials. So we're fine.
app.use(function(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});

/*
When this is implemented it goes above the authentication
middleware. Everything under /api should be protected except for the
authentication hook, however it works.

app.post('/api/v1/authenticate', function(req, res) {
});
*/

app.use('/api', function(req, res, next) {
  // TODO(davidben): Actually implement authentication!!
  req.user = {
    id: 1,
    principal: 'davidben@ATHENA.MIT.EDU'
  };
  next();
});

app.get('/api/v1/subscriptions', function(req, res) {
  db.getUserSubscriptions(req.user.id).then(function(subs) {
    res.json(200, subs);
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

function isValidSub(sub) {
  if (!util.isArray(sub))
    return false;
  if (sub.length !== 3)
    return false;
  if (typeof sub[0] !== 'string')
    return false;
  if (sub[1] !== null && typeof sub[1] !== 'string')
    return false;
  if (typeof sub[2] !== 'string')
    return false;
  return true;
}

app.post('/api/v1/subscribe', function(req, res) {
  if (!isValidSub(req.body.subscription)) {
    // TODO(davidben): Nicer error message.
    res.send(400, 'Subscription triple expected');
    return;
  }
  subscriber.addUserSubscription(
    req.user, req.body.subscription, req.body.credentials
  ).then(function() {
    res.send(200);
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

app.post('/api/v1/unsubscribe', function(req, res) {
  if (!isValidSub(req.body.subscription)) {
    // TODO(davidben): Nicer error message.
    res.send(400, 'Subscription triple expected');
    return;
  }
  subscriber.removeUserSubscription(
    req.user,
    req.body.subscription
  ).then(function() {
    res.send(200);
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

app.get('/api/v1/messages', function(req, res) {
  var offset = stringOrNull(req.query.offset);
  if (offset) {
    offset = msgid.unseal(offset);
  } else {
    // Punt the empty string too.
    offset = null;
  }
  db.getMessages(
    req.user.id, stringOrNull(offset), {
      inclusive: Boolean(req.query.inclusive|0),
      reverse: Boolean(req.query.reverse|0),
      limit: req.query.count|0
    }
  ).then(function(result) {
    result.messages.forEach(function(msg) {
      msg.id = msgid.seal(msg.id);
    });
    res.json(200, result);
  }, function(err) {
    sendError(res, err);
    console.error(err);
  }).done();
});

app.use(express.static(path.join(__dirname, '../static')));

var server = http.createServer(app);
var connectionManager = connections.listen(server, subscriber);

// Load active subscriptions from the database.
console.log('Starting subscriber...');
subscriber.start().then(function() {
  // And now we're ready to start doing things.
  console.log('...started');
  server.listen(conf.get('port'), conf.get('ip'), function() {
    var addy = server.address();
    console.log('running on http://' + addy.address + ":" + addy.port);
  });
}).done();

// Cancel subscriptions on exit.
['SIGINT', 'SIGQUIT', 'SIGTERM'].forEach(function(sig) {
  process.on(sig, function() {
    console.log('Canceling subscriptions...');
    subscriber.shutdown().then(function() {
      console.log('Bye');
      process.exit();
    }).done();
  });
});
