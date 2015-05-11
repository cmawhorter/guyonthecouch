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
  this.options.replicationStrategy = this.options.replicationStrategy || {
    type: 'bi',
    continuous: true,
  };
  this.logger = this.options.log || null;
  this.localNano = null;
  this.remoteNano = null;
  this.queueTasks = null;
  this.queue = null;
  this.feed = null;
  this.ready = false;
}

util.inherits(Guy, events.EventEmitter);

Guy.prototype.start = function() {
  if (this.ready) {
    throw new Error('Call stop before calling start again');
  }
  var _this = this;
  this.localNano = Nano(this.options.local.href);
  this.remoteNano = Nano(this.options.remote.href);

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
            _this.ready = true;
            _this.emit('ready');
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

Guy.prototype.stop = function() {
  this.ready = false;
  this.feed && this.feed.stop();
  this.queue && this.queue.kill();
  return this;
};

Guy.prototype._initServer = function(callback) {
  // TODO: support users and make option
  // this._replicate('_users', callback);
  callback(null);
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
  this.feed = db.follow({ since: 'now' });
  this.feed.on('change', function (change) {
    _this.logger && _this.logger.debug(change, 'change');
    _this._enqueue(change.id, !change.deleted);
  });
  this.feed.on('error', function (err) {
    _this.emit('error', err);
  });
  this.feed.follow();
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
Guy.prototype._replicateBidirectional = function(database, continuous, callback) {
  var _this = this;
  _this._replicateUnidirectionalTo(database, continuous, function(err, body) {
    if (err) {
      return callback(err);
    }
    _this._replicateUnidirectionalFrom(database, continuous, callback);
  });
};

// mostly backwards compat
Guy.prototype._replicate = function(database, callback) {
  this._replicateBidirectional(database, true, callback);
};

Guy.prototype._replicateWithStrategy = function(database, callback) {
  switch (this.options.replicationStrategy.type) {
    case 'bi':
      this._replicateBidirectional(database, this.options.replicationStrategy.continuous, callback);
      return;

    case 'uni-to':
      this._replicateUnidirectionalTo(database, this.options.replicationStrategy.continuous, callback);
      return;

    case 'uni-from':
      this._replicateUnidirectionalFrom(database, this.options.replicationStrategy.continuous, callback);
      return;

    case 'bi-split':
      var _this = this;
      _this._replicateUnidirectionalTo(database, _this.options.replicationStrategy.continuousTo, function(err, body) {
        if (err) {
          return callback(err);
        }
        _this._replicateUnidirectionalFrom(database, _this.options.replicationStrategy.continuousFrom, callback);
      });
      return;

    default:
      return callback(new Error('Invalid replication strategy "' + this.options.replicationStrategy.type + '"'));
  }
};

Guy.prototype._replicateUnidirectionalTo = function(database, continuous, callback) {
  var _this = this;
  var rep = this.localNano.use('_replicator')
    , localUrl = this.databaseUrl('local', database)
    , remoteUrl = this.databaseUrl('remote', database);
  _this.logger && _this.logger.debug('replicating database to remote: ', database);
  rep.insert({
    source: localUrl,
    target: remoteUrl,
    continuous: continuous
  }, null, function(err, body) {
    if (err) {
      return callback(new Error(err.message));
    }
    _this.logger && _this.logger.debug('replicating database to remote: complete');
    callback(null);
  });
};

Guy.prototype._replicateUnidirectionalFrom = function(database, continuous, callback) {
  var _this = this;
  var rep = this.localNano.use('_replicator')
    , localUrl = this.databaseUrl('local', database)
    , remoteUrl = this.databaseUrl('remote', database);
  _this.logger && _this.logger.debug('replicating database from remote: ', database);
  rep.insert({
    source: remoteUrl,
    target: localUrl,
    continuous: continuous
  }, null, function(err, body) {
    if (err) {
      return callback(new Error(err.message));
    }
    _this.logger && _this.logger.debug('replicating database from remote: complete');
    callback(null);
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
  var userDatabase = this.db(user);

  _this.logger && _this.logger.debug('creating database: ' + userDatabase, _this.options.local.href);

  // create database locally
  this.localNano.db.create(userDatabase, function(err) {
    if (err && !re_acceptableErrorsForCrud.test(err.message)) {
      return callback(new Error(err.message));
    }
    _this.logger && _this.logger.debug('creating database: tracking row inserted and triggering replication for new db', _this.options.local.href);
    // TODO: turn back on when _users is fixed
    // var securityData = {
    //   // TODO: configurable?
    //   // only super admins have access
    //   admins: {
    //     names: [],
    //     roles: [],
    //   },
    //   members: {
    //     names: [user],
    //     roles: [_this.options.databaseRole],
    //   }
    // };
    // _this.localNano.use(userDatabase).insert(securityData, '_security', function(err) {
    //   if (err && !re_acceptableErrorsForCrud.test(err.message)) {
    //     return callback(new Error(err.message));
    //   }
      _this._replicateWithStrategy(userDatabase, callback);
    // });
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
    callback(null);
  });
};

Guy.prototype._addTrackingDocument = function(user, callback) {
  var _this = this;
  var userDatabase = _this.db(user);
  _this.remoteNano.use(userDatabase).insert({ created: new Date() }, user, function(err, body) {
    if (err && !re_acceptableErrorsForCrud.test(err.message)) {
      return callback(new Error(err.message));
    }
    callback(null);
  });
};

Guy.prototype._removeTrackingDocument = function(user, callback) {
  var _this = this;
  _this.logger && _this.logger.debug('removing database tracking document: ' + user);
  var userDatabase = _this.db(user);
  this.remoteNano.use(userDatabase).get(user, function(err, result) {
    if (err && !re_acceptableErrorsForCrud.test(err.message)) {
      return callback(new Error(err.message));
    }
    _this.remoteNano.use(_this.options.database).destroy(user, result ? result._rev : null, function(err) {
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

Guy.prototype.get = function(user, callback) {
  var _this = this
    , userDatabase = this.db(user);
  this.localNano.db.get(userDatabase, function(err, body) {
    if (err) {
      return callback(new Error(err.message));
    }
    callback(null, _this.localNano.use(userDatabase));
  });
  return this;
};

// destroys the db on the remote first, if possible
Guy.prototype.destroy = function(user, callback) {
  var _this = this
    , userDatabase = this.db(user)
    , db = this.localNano.use(this.options.database);
  this.remoteNano.db.destroy(userDatabase, function(err) {
    if (err && !re_acceptableErrorsForCrud.test(err.message)) {
      return callback(new Error(err.message));
    }
    // FIXME: support _users and make option
    // var userId = 'org.couchdb.user:' + user;
    // _this.remoteNano.use('_users').get(userId, function(err, result) {
    //   if (err && !re_acceptableErrorsForCrud.test(err.message)) {
    //     return callback(new Error(err.message));
    //   }
    //   if (result) {
    //     _this.remoteNano.use('_users').destroy(userId, result._rev, function(err) {
    //       if (err && !re_acceptableErrorsForCrud.test(err.message)) {
    //         return callback(new Error(err.message));
    //       }
          _this._removeTrackingDocument(user, callback);
    //     });
    //   }
    //   else {
    //     // user does not exist on the server, just try to remove tracking doc
    //     _this._removeTrackingDocument(user, callback);
    //   }
    // });
  });
  return this;
};

// registers the db on the remote immediately
Guy.prototype.register = function(user, password, callback) {
  var _this = this
    , userDatabase = this.db(user);
  // FIXME: support users and make option
  // this.remoteNano.use('_users').insert(this._buildUserData(user, password), 'org.couchdb.user:' + user, function(err, result) {
  //   if (err && !re_acceptableErrorsForCrud.test(err.message)) {
  //     return callback(new Error(err.message));
  //   }
    // replicate the newly created database
    // create database remote
    _this.logger && _this.logger.debug('creating database: created locally; creating remote');
    _this.remoteNano.db.create(userDatabase, function(err) {
      if (err && !re_acceptableErrorsForCrud.test(err.message)) {
        return callback(new Error(err.message));
      }
      _this.logger && _this.logger.debug('creating database: created locally; adding tracking row in user db');
      // insert it into the list of all user databases
      _this._addTrackingDocument(user, callback);
    });
  // });
  return this;
};

Guy.prototype.db = function(database) {
  return this.options.prefix + database;
};

module.exports = Guy;
