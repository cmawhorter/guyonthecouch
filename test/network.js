'use strict';

var assert = require('assert')
  , url = require('url');
var Nano = require('nano')
  , async = require('async');
var Guy = require('../index.js');

var localServer = 'http://127.0.0.1:5984/';
var remoteServer = 'http://192.168.50.50:5984/';
var userDatabase = 'user_test_databases';
var dbPrefix = 'user_test_database_';
var createUser = {
  name: 'someone',
  password: '12345',
  database: dbPrefix+'someone'
};

var logger = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  debug: console.log.bind(console),
  trace: console.trace.bind(console),
};

// how much time to wait before checking if replication worked
var PROPAGATION_DELAY = 100;

function E(done, err, message) {
  done(new Error(message + ' (Original Error: ' + err.message + ')'));
}

function nanoClient(url) {
  return Nano({
    url: url,
    // log: function (id, args) {
    //   console.log(id, args);
    // }
  });
}

describe('Client', function() {
  var client = new Guy({
    local: url.parse(localServer),
    remote: url.parse(remoteServer),
    database: userDatabase,
    prefix: dbPrefix,
    createRemote: true,
    log: logger
  });
  var nanoRemote = nanoClient(remoteServer)
  var nanoLocal = nanoClient(localServer);

  function destroyDatabase(database, callback) {
    nanoRemote.db.destroy(userDatabase, function(err) {
      if (err && !/\bmissing\b/.test(err.message)) {
        return callback(err);
      }
      nanoLocal.db.destroy(userDatabase, function(err) {
        if (err && !/\bmissing\b/.test(err.message)) {
          return callback(err);
        }
        callback(null);
      });
    });
  }

  function doesntExist(fn, database, callback) {
    fn(database, function(err, result) {
      if (err) {
        return callback(null);
      }
      console.log('doesntExist', result);
      return callback(new Error('database should not exist'));
    });
  }

  function removeDocument(database, id, callback) {
    var tasks = [];
    [nanoLocal,nanoRemote].forEach(function(target, index) {
      tasks.push(function(taskCallback) {
        var db = target.use(database);
        // console.log('get %s %s', database, id, db.config.url);
        db.get(id, function(err, result) {
          if (err) {
            return /\b(missing|deleted|connection)\b/.test(err.message) ? taskCallback(null) : taskCallback(err);
          }
          // console.log('destroy %s %s', database, id, index, result, db.config.url);
          db.destroy(id, result._rev, function(err) {
            if (err) {
              return /\b(missing|deleted|connection)\b/.test(err.message) ? taskCallback(null) : taskCallback(err);
            }
            taskCallback(null);
          });
        });
      });
    });
    async.parallel(tasks, callback);
  }

  function removeUser(user, callback) {
    var userId = 'org.couchdb.user:' + user;
    removeDocument('_users', userId, callback);
  }

  // FIXME: this should run beforeEach
  before(function resetDatabase(done) {
    destroyDatabase(userDatabase, function(err) {
      if (err) return E(done, err, 'destroy database');
      destroyDatabase(createUser.name, function(err) {
        if (err) return E(done, err, 'destroy database');
        removeUser(createUser.name, function(err) {
          if (err) return E(done, err, 'remove user');
          client.on('ready', done);
          client.start();
        });
      });
    });
  });

        // async.parallel([
        //   async.apply(nanoRemote.db.destroy, userDatabase),
        //   async.apply(nanoLocal.db.destroy, userDatabase),
        // ], function(err) {
        // });

  describe('#register()', function() {
    it('should register new users', function(done) {
      client.register(createUser.name, createUser.password, function(err) {
        if (err) return E(done, err, 'register user');
        setTimeout(function() {
          async.parallel([
            async.apply(nanoRemote.db.get, createUser.database),
            async.apply(nanoLocal.db.get, createUser.database),
          ], function(err) {
            if (err) return E(done, err, 'confirm register');
            done();
          });
        }, PROPAGATION_DELAY);
      });
    });
  });

  describe('#destroy()', function() {
    it('should destroy users', function(done) {
      client.destroy(createUser.name, function(err) {
        if (err) return E(done, err, 'destroy user');
        setTimeout(function() {
          async.parallel([
            async.apply(doesntExist, nanoRemote.db.get, createUser.database),
            async.apply(doesntExist, nanoLocal.db.get, createUser.database),
          ], function(err) {
            if (err) return E(done, err, 'confirm register');
            done();
          });
        }, PROPAGATION_DELAY);
      });
    });
  });

  describe('#create()', function() {
    var createDb = 'blah' + Math.floor(Math.random() * 10000)
      , createDbRemote = 'blahremote' + Math.floor(Math.random() * 10000);

    it('should create database ' + createDb + ' locally and to remote', function(done) {
      client.create(createDb, function(err) {
        if (err) return E(done, err, 'create local');
        setTimeout(function() {
          nanoRemote.db.get(dbPrefix+createDb, done);
        }, PROPAGATION_DELAY);
      });
    });
    it('should propagate remote databases ' + createDbRemote + ' to local', function(done) {
      nanoRemote.use(userDatabase).insert({ created: new Date() }, createDbRemote, function(err, body) {
        if (err) return E(done, err, 'create remote');
        setTimeout(function() {
          nanoLocal.db.get(dbPrefix+createDbRemote, done);
        }, PROPAGATION_DELAY);
      });
    });
  });
});
