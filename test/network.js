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
  logging: true,
});

// how much time to wait before checking if replication worked
var PROPAGATION_DELAY = 5000;

describe('Client', function() {
  this.timeout(30000);

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

  var registerDatabaseForLaterDestroy = clients.randomName('register');
  describe('#register()', function() {
    it('should register new users', function(done) {
      client1.register(registerDatabaseForLaterDestroy, password, function(err) {
        if (err) return E(done, err, 'register user');
        setTimeout(function() {
          databaseExists(registerDatabaseForLaterDestroy, done);
        }, PROPAGATION_DELAY);
      });
    });

    it('should sync with added and removed databases while offline', function(done) {
      var registerDatabase = clients.randomName('destroy');
      var registerDatabase2 = clients.randomName('keep');
      client1.register(registerDatabase, password, function(err) { // create a db that gets created in all clients
        if (err) return E(done, err, 'register user');
        setTimeout(function() {
          client3.stop(); // stop our target client before offline actions we're testing
          client1.register(registerDatabase2, password, function(err) {
            if (err) return E(done, err, 'register user');
            client1.destroy(registerDatabase, function(err) {
              if (err) return E(done, err, 'destroy user');
              clients.startClient(client3, function() {
                setTimeout(function() {
                  async.parallel([
                    async.apply(databaseNotExists, registerDatabase),
                    async.apply(databaseExists, registerDatabase2),
                  ], done);
                }, PROPAGATION_DELAY);
              });
            });
          });
        }, PROPAGATION_DELAY);
      });
    });
  });

  describe('#destroy()', function() {
    it('should destroy users', function(done) {
      client1.destroy(registerDatabaseForLaterDestroy, function(err) {
        if (err) return E(done, err, 'destroy user');
        setTimeout(function() {
          databaseNotExists(registerDatabaseForLaterDestroy, done);
        }, PROPAGATION_DELAY);
      });
    });
  });
});
