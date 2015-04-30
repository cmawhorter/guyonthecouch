'use strict';
var url = require('url');
var Guy = require('../../index.js');

module.exports = function(options) {
  var lib = {};

  lib.E = function E(done, err, message) {
    done(new Error(message + ' (Original Error: ' + err.message + ')'));
  };

  lib.client = function client(localUrl, name) {
    return new Guy({
      local: url.parse(localUrl),
      remote: url.parse(options.hubServer),
      database: options.userDatabase,
      prefix: options.dbPrefix,
      createRemote: true,
      log: options.logging ? lib.createLogger(name) : null
    });
  };

  lib.exists = function exists(client, database, callback) {
    client.get(database, function(err) {
      if (err) return callback(new Error(database + ': ' + err.message + ' (' + client.options.local.href + ')'));
      callback(null);
    });
  };

  lib.doesntExist = function doesntExist(client, database, callback) {
    client.get(database, function(err, result) {
      if (err) {
        return callback(null);
      }
      return callback(new Error(database + ': should not exist (' + client.options.local.href + ')'));
    });
  };

  lib.startClient = function startClient(client, callback) {
    if (client.ready) { // client already started
      setImmediate(callback);
    }
    else {
      client.once('ready', function() {
        callback(null);
      });
      client.start();
    }
  };

  lib.randomName = function randomName(prefix) {
    return prefix + Math.floor(Math.random() * 100000);
  };

  lib.prefixLog = function prefixLog(prefix, fn) {
    return function() {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(prefix);
      fn.apply(this, args);
    };
  };

  lib.createLogger = function createLogger(prefix) {
    var logger = {
      error: lib.prefixLog(prefix, console.error),
      warn: lib.prefixLog(prefix, console.warn),
      info: lib.prefixLog(prefix, console.info),
      debug: lib.prefixLog(prefix, console.log),
      trace: lib.prefixLog(prefix, console.trace),
    };
    return logger;
  };

  return lib;
};
