# Abandoned soon

This will soon be abandoned because there are better alternatives coming.  It looks like couchdb 2.0 will ship with cluster support backed in along with [couchperuser](https://github.com/etrepum/couchperuser)

If you need per-user couchdb databases now and can't wait, you might want to look into couchperuser instead of this.

Further reading:
  - couchperuser - https://issues.apache.org/jira/browse/COUCHDB-2191
  - couchperuser - http://wilderness.apache.org/archives/couchdb-meeting-22_04_2015-2479.html
  - coming cluster support - http://docs.couchdb.org/en/latest/cluster/index.html?highlight=cluster
  - cluster branch - https://github.com/apache/couchdb/tree/developer-preview-2.0

# Guy on the Couch

Allows you to create an unlimited (?) number of couchdb databases and keep them replicated with a remote.  e.g. create a new database for each user instead of lumping it all together.

## About

As of right now, pretty much just a test.  Seems to be working but minimal testing done.  Feedback welcome.

## Usage

```javascript
// pass in options
var guy = new Guy({
  remote: url.parse('https://some:account@some.example.com'),
  local: url.parse('http://127.0.0.1:5984'),
  database: 'user_databases',
  createRemote: true
});

guy.on('ready', function() {
  console.log('User databases are loaded ready');
  
  guy.create('user12345', function(err) {
    // user12345 database created and replication set up with remote
    guy.remove('user12345', function(err) {
      // user12345 database removed
    });
  });
});

// other events:
//   - create
//   - remove
//   - create:[database name]
//   - remove:[database name]
//   - database:[database name] ... created or removed

```

## How it works

It creates an index of users databases in `options.database` and sets up replication via the special [_replicator database](https://gist.github.com/fdmanana/832610).

The user database is then monitored for changes and user databases are created/removed automatically.  

## Related libs

https://github.com/pegli/couchdb-dbperuser-provisioning
