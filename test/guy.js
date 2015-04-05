'use strict';

var assert = require('assert');
var Guy = require('../index.js');

describe('Guy', function() {
  describe('#ctor', function() {
    it('should take options or not', function() {
      assert.doesNotThrow(function() {
        new Guy();
        new Guy({});
      });
    });
  });

  // TODO: nock couchdb, remove vagrant and move all tests into here
});
