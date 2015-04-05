'use strict';

var fs = require('fs')
  , path = require('path')
  , url = require('url')
  , util = require('util')
  , events = require('events');

var async = require('async')
  , Nano = require('nano');

var re_acceptableErrorsForCrud = /\b(missing|deleted|exists|conflict)\b/;

function Guy(options) {
  var _this = this;
  events.EventEmitter.call(this);

  this.options = options || {};
  this.options.database = this.options.database || 'user_databases';
  this.options.prefix = this.options.prefix || '';
  this.options.databaseRole = this.options.databaseRole || 'dbuser';
  this.options.local = this.options.local || url.parse('http://127.0.0.1:5984');
  this.options.remote = this.options.remote;
  this.options.adjustUserRecord = this.options.adjustUserRecord || null;
  this.logger = this.options.log || null;
  this.localNano = null;
  this.remoteNano = null;
  this.queueTasks = null;
  this.queue = null;
  this.ready = false;
}

util.inherits(Guy, events.EventEmitter);

Guy.prototype.start = function() {
  var _this = this;
  this.localNano = Nano(this.options.local.href);
  this.remoteNano = Nano(this.options.remote.href);

  this.ready = false;
  this.queueTasks = {};
  this.queue = async.queue(this._queueWorker.bind(this), this.options.concurrency || 4);

  this.logger && this.logger.debug('checking if remote user database exists');
  this.remoteNano.db[this.options.createRemote ? 'create' : 'get'](this.options.database, function (err, body) {
    if (err && !re_acceptableErrorsForCrud.test(err.message)) {
      _this.emit('error', new Error('Error communicating with remote database "' + _this._buildUrl(_this.options.remote, { auth: '****', pathname: _this.options.database }) + '". Use option createRemote: true to create it'));
      return;
    }
    _this._initServer(function(err) {
      if (err) {
        return _this.emit('error', err);
      }
      _this._initDatabase(function(err) {
        if (err) {
          return _this.emit('error', err);
        }
        _this.emit('online');
        _this._syncLocal(function(err) {
          if (err) {
            return _this.emit('error', err);
          }
          _this.logger && _this.logger.debug('sync and watch has run; emitting ready as soon as queue drains');
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
  });
  return this;
};

Guy.prototype._initServer = function(callback) {
  this._replicate('_users', callback);
};

Guy.prototype._initDatabase = function(callback) {
  var _this = this;
  _this.logger && _this.logger.debug('init local database');
  this.localNano.db.create(this.options.database, function(err, body) {
    if (err && !re_acceptableErrorsForCrud.test(err.message)) {
      return callback(new Error(err.message));
    }
    _this.logger && _this.logger.debug('init local database: creating local, replicating');
    _this._replicate(_this.options.database, function(err) {
      if (err && !re_acceptableErrorsForCrud.test(err.message)) {
        return callback(new Error(err.message));
      }
      _this._watchLocal(callback);
    });
  });
};

Guy.prototype._watchLocal = function(callback) {
  var _this = this;
  var db = this.localNano.use(this.options.database);
  _this.logger && _this.logger.debug('init local database: watching for changes on ' + this.options.database);
  var feed = db.follow({ since: 'now' });
  feed.on('change', function (change) {
    _this.logger && _this.logger.debug(change, 'change');
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
  _this.logger && _this.logger.debug('starting to sync offline user database changes');
  this.localNano.db.list(function(err, allLocalDatabases) {
    if (err) {
      return callback(new Error(err.message));
    }
    _this.logger && _this.logger.debug('sync; all databases', allLocalDatabases);
    // FIXME: convert to paging otherwise a large number of databases could spike the memory usage
    _this.localNano.use(_this.options.database).list(function(err, userDatabases) {
      if (err) {
        return callback(new Error(err.message));
      }
      userDatabases.rows.forEach(function(row) {
        var userDatabase = row.id;
        if (!(userDatabase in _this.queueTasks)) {
          if (allLocalDatabases.indexOf(userDatabase) < 0) {
            _this.logger && _this.logger.debug('user database created while offline ' + userDatabase);
            _this._enqueue(userDatabase, true);
          }
        }
      });
      // TODO: handle user databases that are deleted while offline
      callback(null);
    });
  });
};

Guy.prototype._enqueue = function(user, create) {
  if (!(user in this.queueTasks)) {
    // only add it to the queue if it doesn't already exist
    this.queue.push({ user: user });
  }
  else {
    this.logger && this.logger.warn('Not adding to queue because a task already exists for: ' + user + ' (' + (create ? 'create' : 'remove') + ')');
  }
  this.queueTasks[user] = create;
};

Guy.prototype._queueWorker = function(task, callback) {
  var _this = this
    , create = this.queueTasks[task.user]
    , user = task.user;
  delete this.queueTasks[user];
  this.logger && this.logger.debug('Working on : ' + user + ' (' + (create ? 'create' : 'remove') + ')');
  this[create ? '_create' : '_remove'](user, function(err) {
    if (err) {
      _this.emit('error', err);
      return callback(new Error(err.message));
    }
    _this.emit((create ? 'create:' : 'remove:') + user);
    _this.emit('database:' + user, create);
    _this.emit(create ? 'create' : 'remove', _this.db(user), user);
    callback(null);
  });
};

// inserts two-way replication between database on local and remote
Guy.prototype._replicate = function(database, callback) {
  var _this = this;
  var rep = this.localNano.use('_replicator')
    , localUrl = this.databaseUrl('local', database)
    , remoteUrl = this.databaseUrl('remote', database);
  _this.logger && _this.logger.debug('replicating database: ', database);
  rep.insert({
    source: localUrl,
    target: remoteUrl,
    continuous: true
  }, null, function(err, body) {
    if (err) {
      return callback(new Error(err.message));
    }
    _this.logger && _this.logger.debug('replicating database: replicated partially complete');
    rep.insert({
      target: localUrl,
      source: remoteUrl,
      continuous: true
    }, null, callback);
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

Guy.prototype._buildUserData = function(user, password) {
  var data = {
    type: 'user',
    name: user,
    password: password,
    roles: [ this.options.databaseRole ],
  };
  this.options.adjustUserRecord && this.options.adjustUserRecord(data);
  return data;
};

Guy.prototype._create = function(user, callback) {
  var _this = this;
  var db = this.localNano.use(this.options.database);
  var userDatabase = this.db(user);

  _this.logger && _this.logger.debug('creating database: ' + userDatabase);

  // create database locally
  this.localNano.db.create(userDatabase, function(err) {
    if (err) {
      if (re_acceptableErrorsForCrud.test(err.message)) {
        return callback(null);
      }
      return callback(new Error(err.message));
    }
    _this.logger && _this.logger.debug('creating database: created locally; adding tracking row in user db');
    // insert it into the list of all user databases
    db.insert({ created: new Date() }, user, function(err, body) {
      if (err && !re_acceptableErrorsForCrud.test(err.message)) {
        return callback(new Error(err.message));
      }
      // replicate the newly created database
      // create database remote
      _this.logger && _this.logger.debug('creating database: created locally; creating remote');
      _this.remoteNano.db.create(userDatabase, function(err) {
        if (err && !re_acceptableErrorsForCrud.test(err.message)) {
          return callback(new Error(err.message));
        }
        _this.logger && _this.logger.debug('creating database: tracking row inserted and triggering replication for new db');
        _this._replicate(userDatabase, callback);
      });
    });
  });
};

Guy.prototype._remove = function(user, callback) {
  var _this = this;
  var userDatabase = this.db(user);
  _this.logger && _this.logger.debug('removing database: ' + userDatabase);
  this.localNano.db.destroy(userDatabase, function(err) {
    _this.logger && _this.logger.debug('removing database: ' + userDatabase + '; callback reached');
    if (err && !re_acceptableErrorsForCrud.test(err.message)) {
      return callback(new Error(err.message));
    }
    _this.logger && _this.logger.debug('removing database: removed locally; removing remote');
    _this.remoteNano.db.destroy(userDatabase, function(err) {
      if (err && !re_acceptableErrorsForCrud.test(err.message)) {
        return callback(new Error(err.message));
      }
      _this._removeTrackingDocument(user, callback);
    });
  });
};

Guy.prototype._removeTrackingDocument = function(user, callback) {
  var _this = this;
  _this.logger && _this.logger.debug('removing database tracking document: ' + user);
  this.localNano.use(this.options.database).get(user, function(err, result) {
    if (err && !re_acceptableErrorsForCrud.test(err.message)) {
      return callback(new Error(err.message));
    }
    _this.localNano.use(_this.options.database).destroy(user, result ? result._rev : null, function(err) {
      _this.logger && _this.logger.debug('removing database tracking document: ' + user + '; callback reached');
      if (err && !re_acceptableErrorsForCrud.test(err.message)) {
        return callback(new Error(err.message));
      }
      callback(null);
    });
  });
};

Guy.prototype.create = function(user, callback) {
  var _this = this;
  this._enqueue(user, true);
  this.once('database:' + user, function(created) {
    if (!created) {
      return callback(new Error('Database "' + user + '" was removed before it could be created'));
    }
    callback(null, _this.localNano.use(_this.db(user)));
  });
  return this;
};

Guy.prototype.remove = function(user, callback) {
  this._enqueue(user, false);
  this.once('database:' + user, function(created) {
    if (created) {
      return callback(new Error('Database "' + user + '" was created before it could be removed'));
    }
    callback(null);
  });
  return this;
};

Guy.prototype.get = function(user, create, callback) {
  var _this = this;
  if (typeof create === 'function') {
    callback = create;
    create = false;
  }
  if (true === create) {
    this.create(user, callback);
  }
  else {
    this.localNano.db.get(this.db(user), function(err, body) {
      if (err) {
        return callback(new Error(err.message));
      }
      callback(null, _this.localNano.use(_this.db(user)));
    });
  }
  return this;
};

// destroys the db on the remote first, if possible
Guy.prototype.destroy = function(user, callback) {
  var _this = this
    , db = this.localNano.use(this.options.database);
  this.remove(user, function(err) {
    if (err) return callback(new Error(err.message));
    var userId = 'org.couchdb.user:' + user;
    _this.localNano.use('_users').get(userId, function(err, result) {
      if (err && !re_acceptableErrorsForCrud.test(err.message)) {
        return callback(new Error(err.message));
      }
      _this.localNano.use('_users').destroy(userId, result._rev, function(err) {
        if (err && !re_acceptableErrorsForCrud.test(err.message)) {
          return callback(new Error(err.message));
        }
        callback(null);
      });
    });
  });
  return this;
};

// registers the db on the remote immediately
Guy.prototype.register = function(user, password, callback) {
  var _this = this
    , db = this.localNano.use('_users');
  db.insert(this._buildUserData(user, password), 'org.couchdb.user:' + user, function(err, result) {
    if (err && !re_acceptableErrorsForCrud.test(err.message)) {
      return callback(new Error(err.message));
    }
    _this.create(user, function(err, userDb) {
      if (err) {
        return callback(new Error(err.message));
      }
      var securityData = {
        // TODO: configurable?
        // only super admins have access
        admins: {
          names: [],
          roles: [],
        },
        members: {
          names: [user],
          roles: [_this.options.databaseRole],
        }
      };
      userDb.insert(securityData, '_security', callback);
    });
  });
  return this;
};

Guy.prototype.db = function(database) {
  return this.options.prefix + database;
};

module.exports = Guy;
