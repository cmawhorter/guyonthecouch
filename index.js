'use strict';

var fs = require('fs')
  , path = require('path')
  , url = require('url')
  , util = require('util')
  , events = require('events');

var async = require('async')
  , Nano = require('nano');

function Guy(options) {
  var _this = this;
  events.EventEmitter.call(this);

  this.options = options || {};
  this.options.database = this.options.database || 'user_databases';
  this.options.local = this.options.local || url.parse('http://127.0.0.1:5984');
  this.options.remote = this.options.remote;
  this.localNano = null;
  this.remoteNano = null;
  this.queueTasks = {};
  this.queue = async.queue(this._queueWorker.bind(this), this.options.concurrency || 4);
  this.ready = false;
  this._init();
}

util.inherits(Guy, events.EventEmitter);

Guy.prototype._init = function() {
  var _this = this;
  this.localNano = Nano(this.options.local.href);
  this.remoteNano = Nano(this.options.remote.href);

  console.log('checking if remote user database exists');
  this.remoteNano.db[this.options.createRemote ? 'create' : 'get'](this.options.database, function (err, body) {
    if (err && !/\bexists\b/i.test(err.message)) {
      throw new Error('Error communicating with remote database "' + _this._buildUrl(_this.options.remote, { auth: '****', pathname: _this.options.database }) + '". Use option createRemote: true to create it');
    }
    _this._initDatabase(function(err) {
      if (err) {
        return _this.emit('error', err);
      }
      _this._syncLocal(function(err) {
        if (err) {
          return _this.emit('error', err);
        }
        console.log('sync and watch has run; emitting ready as soon as queue drains');
        _this.queue.drain = function() {
          if (!_this.ready) {
            _this.emit('ready');
            _this.ready = true;
          }
        };
        // if the queue is empty, manually trigger drain (bug in async?)
        if (!_this.queue.length()) {
          _this.queue.drain();
        }
      });
    });
  });
};

Guy.prototype._initDatabase = function(callback) {
  var _this = this;
  console.log('init local database');
  var _this = this;
  this.localNano.db.create(this.options.database, function(err, body) {
    // TODO: check error to make sure it's an "already exists" error?
    if (!err) {
      console.log('init local database: creating local, replicating');
      _this._replicate(_this.options.database, function(err) {
        if (err) {
          return callback(err);
        }
        _this._watchLocal(callback);
      });
    }
    else {
      _this._watchLocal(callback);
    }
  });
};

Guy.prototype._watchLocal = function(callback) {
  var _this = this;
  var db = this.localNano.use(this.options.database);
  console.log('init local database: watching for changes on %s', this.options.database);
  var feed = db.follow({ since: 'now' });
  feed.on('change', function (change) {
    console.log("change: ", change);
    _this._enqueue(change.id, !change.deleted);
  });
  feed.on('error', function (err) {
    _this.emit('error', err);
  });
  feed.follow();
  callback(null);
};

// syncs the current data of options.database i.e. adds/removes databases
Guy.prototype._syncLocal = function(callback) {
  var _this = this;
  console.log('starting to sync offline user database changes');
  this.localNano.db.list(function(err, allLocalDatabases) {
    if (err) {
      return callback(err);
    }
    // FIXME: convert to paging otherwise a large number of databases could spike the memory usage
    _this.localNano.use(_this.options.database).list(function(err, userDatabases) {
      if (err) {
        return callback(err);
      }
      userDatabases.rows.forEach(function(row) {
        var userDatabase = row.id;
        if (!(userDatabase in _this.queueTasks)) {
          if (allLocalDatabases.indexOf(userDatabase) < 0) {
            console.log('user database created while offline', userDatabase);
            _this._enqueue(userDatabase, true);
          }
        }
      });
      // TODO: handle user databases that are deleted while offline
      callback(null);
    });
  });
};

Guy.prototype._enqueue = function(database, create) {
  if (!(database in this.queueTasks)) {
    // only add it to the queue if it doesn't already exist
    this.queue.push({ database: database });
  }
  this.queueTasks[database] = create;
};

Guy.prototype._queueWorker = function(task, callback) {
  var _this = this
    , create = this.queueTasks[task.database]
    , database = task.database;
  delete this.queueTasks[database];
  this[create ? '_create' : '_remove'](database, function(err) {
    if (err) {
      _this.emit('error', err);
      return callback(err);
    }
    _this.emit((create ? 'create:' : 'remove:') + database);
    _this.emit('database:' + database, create);
    _this.emit(create ? 'create' : 'remove', database);
    callback(null);
  });
};

// inserts two-way replication between database on local and remote
Guy.prototype._replicate = function(database, callback) {
  var rep = this.localNano.use('_replicator')
    , localUrl = this.databaseUrl('local', database)
    , remoteUrl = this.databaseUrl('remote', database);
  console.log('replicating database: ', database);

  this.remoteNano.db.create(database, function(err, body) {
    if (err && !/\bexists\b/i.test(err.message)) {
      return callback(err);
    }
    console.log('replicating database: inserting replication task');
    rep.insert({
      source: localUrl,
      target: remoteUrl,
      continuous: true
    }, null, function(err, body) {
      if (err) {
        return callback(err);
      }
      console.log('replicating database: replicated partially complete');
      rep.insert({
        target: localUrl,
        source: remoteUrl,
        continuous: true
      }, null, callback);
    });
  });
};

Guy.prototype._buildUrl = function(urlObj, updates, returnObject) {
  var clonedUrlObj = Object.create(urlObj);
  for (var k in updates) {
    clonedUrlObj[k] = updates[k];
  }
  return returnObject ? clonedUrlObj : url.format(clonedUrlObj);
};

Guy.prototype.databaseUrl = function(localOrRemote, database) {
  return this._buildUrl(this.options[localOrRemote], { pathname: database });
}

Guy.prototype._create = function(database, callback) {
  var _this = this;
  var db = this.localNano.use(this.options.database);

  console.log('creating database: ', database);

  // create database locally
  this.localNano.db.create(database, function(err) {
    if (err) {
      if (/\bexists\b/i.test(err.message)) {
        return callback(null);
      }
      else {
        return callback(err);
      }
    }
    console.log('creating database: created locally; adding tracking row in user db');
    // insert it into the list of all user databases
    db.insert({ created: new Date() }, database, function(err, body) {
      if (err && !/\bconflict\b/i.test(err.message)) {
        return callback(err);
      }
      // replicate the newly created database
      console.log('creating database: tracking row inserted and triggering replication for new db');
      _this._replicate(database, callback);
    });
  });
};

Guy.prototype._remove = function(database, callback) {
  var _this = this;
  this.localNano.db.destroy(database, function(err) {
    if (err && !/\bmissing\b/i.test(err.message)) {
      return  callback(err);
    }
    callback(null);
  });
};

Guy.prototype.create = function(database, callback) {
  this._enqueue(database, true);
  this.once('database:' + database, function(created) {
    if (!created) {
      return callback(new Error('Database "' + database + '" was removed before it could be created'));
    }
    callback(null);
  });
};

Guy.prototype.remove = function(database, callback) {
  this._enqueue(database, false);
  this.once('database:' + database, function(created) {
    if (created) {
      return callback(new Error('Database "' + database + '" was created before it could be removed'));
    }
    callback(null);
  });
};

module.exports = Guy;

