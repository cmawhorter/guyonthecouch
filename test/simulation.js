'use strict';

var http = require('http');
http.globalAgent.maxSockets = 100;

var assert = require('assert');
var async = require('async');

var spoke1Server = 'http://192.168.50.40:5984/';
var spoke2Server = 'http://192.168.50.41:5984/';
var spoke3Server = 'http://192.168.50.42:5984/';
var hubServer = 'http://192.168.50.50:5984/';
var userDatabase = 'user_test_databases';
var dbPrefix = 'user_test_database_';
var password = 'password';

var clients = require('./shared/clients.js')({
  userDatabase: userDatabase,
  hubServer: hubServer,
  dbPrefix: dbPrefix,
  logging: true
});

// how much time to wait before checking if replication worked
var PROPAGATION_DELAY = 500;

function randomInt(min,max) {
    return Math.floor(Math.random()*(max-min+1)+min);
}

function randomChar() {
  return String.fromCharCode(randomInt(48, 74));
}

function randomData(bytes) {
  var data = '';
  for (var i=0; i < bytes; i++) {
    data += randomChar();
  }
  return data;
}

describe('Simulation', function() {
  var client1 = clients.client(spoke1Server, '[client1]\t');
  var client2 = clients.client(spoke2Server, '[client2]\t');
  var client3 = clients.client(spoke3Server, '[client3]\t');

  function startAllClients(callback) {
    async.parallel([
      async.apply(clients.startClient, client1),
      async.apply(clients.startClient, client2),
      async.apply(clients.startClient, client3),
    ], callback);
  }

  function stopAllClients() {
    client1.stop();
    client2.stop();
    client3.stop();
  }

  before(function clientsReady(done) {
    this.timeout(0);
    startAllClients(done);
  });
  after(function shutdownClients() {
    stopAllClients();
  });

  function databaseExists(database, callback) {
    async.parallel([
      async.apply(clients.exists, client1, database),
      async.apply(clients.exists, client2, database),
      async.apply(clients.exists, client3, database),
    ], callback);
  }

  function databaseNotExists(database, callback) {
    async.parallel([
      async.apply(clients.doesntExist, client1, database),
      async.apply(clients.doesntExist, client2, database),
      async.apply(clients.doesntExist, client3, database),
    ], callback);
  }

  var createdDatabases = [];
  var offlineClients = [];
  var eventHandlers = {
    register: function(task, callback) {
      if (!task.client.ready) return callback(null); // client offline
      var database = clients.randomName('sim');
      task.database = database;
      console.log('==> (%s) Creating database %s', task.id, database);
      task.client.register(database, password, function(err) {
        if (err) {
          return callback(err);
        }
        createdDatabases.push(database);
        callback(null);
      });
    },

    destroy: function(task, callback) {
      if (!task.client.ready) return callback(null); // client offline
      if (!createdDatabases.length) return callback(null); // none created yet
      var database = createdDatabases[randomInt(0, createdDatabases.length - 1)];
      console.log('==> (%s) Removing database %s', task.id, database);
      task.database = database;
      task.client.destroy(database, function(err) {
        if (err) {
          return callback(err);
        }
        var index = createdDatabases.indexOf(database);
        createdDatabases.splice(index, 1);
        callback(null);
      });
    },

    offline: function(task, callback) {
      if (!task.client.ready || task.client.changingState) return callback(null); // client already offline
      if (offlineClients.legth >= 2) callback(null); // all clients will be offline
      var offlineDelay = randomInt(1000, 15000);
      console.log('==> (%s) Going offline for %sms', task.id, offlineDelay);
      task.client.changingState = true;
      task.client.stop();
      offlineClients.push(task.client);
      setTimeout(function() {
        callback(null);
        task.client.changingState = false;
      }, offlineDelay);
    },

    online: function(task, callback) {
      if (task.client.ready || task.client.changingState) return callback(null); // client already online
      console.log('==> (%s) Going online', task.id);
      task.client.changingState = true;
      clients.startClient(task.client, function(err) {
        if (err) {
          return callback(err);
        }
        var index = offlineClients.indexOf(task.client);
        offlineClients.splice(index, 1);
        callback(null);
        task.client.changingState = false;
      });
    },
  };

  // curl http://127.0.0.1:5984/_all_dbs | prettyjson
  var taskVerifiers = {
    registerVerify: function(task, callback) {
      databaseExists(task.database, callback);
    },

    destroyVerify: function(task, callback) {
      databaseNotExists(task.database, callback);
    },

    offlineVerify: function(task, callback) {
      callback(task.client.ready ? new Error('Client still online') : null);
    },

    onlineVerify: function(task, callback) {
      callback(!task.client.ready ? new Error('Client still offline') : null);
    },
  };

  it('should support keeping it real', function(done) {
    this.timeout(0); // disable timeouts
    var worker = function worker(task, callback) {
      console.log('[Worker]\t%s\t%s -> %s', task.id, task.type, task.client.options.local.host);
      eventHandlers[task.type](task, function(err) {
        if (err) {
          return callback(err);
        }
        // verification occurs independently of queue work
        setTimeout(function() {
          taskVerifiers[task.type+'Verify'](task, function(err) {
            console.log('\t[Verify]\t%s\t%s -> %s', task.id, task.type, task.client.options.local.host);
            if (err) {
              return callback(err);
            }
            callback(null);
          });
        }, PROPAGATION_DELAY);
      });
    };
    var events = 10000;
    var eventTypes = Object.keys(eventHandlers);
    var targets = [ client1, client2, client3 ];
    var concurrency = 10;
    var queue = async.queue(worker, concurrency);
    for (var i=0; i < events; i++) {
      var client = targets[randomInt(0, targets.length - 1)];
      var evt = eventTypes[randomInt(0, eventTypes.length - 1)];
      queue.push({
        type: evt,
        client: client,
        id: i,
      });
    }
    queue.drain = function() {
      // make sure all clients started and verify createdDatabases all exist as a final check
      console.log('Starting all clients and doing a final check...');
      setTimeout(function() {
        startAllClients(function(err) {
          if (err) {
            return done(err);
          }
          var tasks = [];
          createdDatabases.forEach(function(database) {
            tasks.push(async.apply(databaseExists, database));
          });
          async.parallelLimit(tasks, 4, done);
        });
      }, 1000);
    };
  });
});
