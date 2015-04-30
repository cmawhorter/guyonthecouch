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
  // replicationStrategy: ... // See note below
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

## Options: replicationStrategy

By default two-way continuous replication is used.  In theory, this isn't a terrible idea.  But in practice, it can be problematic with spawning TONS of GET requests if either server doesn't support [long poll](http://guide.couchdb.org/draft/notifications.html#long).

Cloudant does not support long poll (or it's not documented and I'm not doing it right), and in my testing very limited testing, a two-way continuously replicated databases works out to about $0.30/day while completely idling.  If you're LAN and have long poll things would work great.

The `replicationStrategy` option was created to work around this issue and give you more granular control over replication.

### Default Strategy

This matches the existing behavior.

```javascript
var options = {
  replicationStrategy: {
    type: 'bi',
    continuous: true
  }
}
```

### Other Strategies

`replicationStrategy.type` can be:

  - `bi` - Bidirectional replication
  - `uni-to` - One-way from local to remote
  - `uni-from` - One-way from remote to local
  - `bi-split` - Continuous can be set for for each direction independently

`replicationStrategy.continuous` is true/false and ignored if type is `bi-split`.  If using `bi-split`, use `replicationStrategy.continuousTo` and `replicationStrategy.continuousFrom`.

### Examples

Use local as a write queue to remote.

```javascript
var options = {
  replicationStrategy: {
    type: 'uni-to',
    continuous: true
  }
}
```

Keep local in sync with remote and ignore (i.e. don't write) local writes.

Local read-only and remote failover -- 1) remote fails 2) write local instead 3) remote back up 4) manually replicate local to remote and go back to local being read only.

```javascript
var options = {
  replicationStrategy: {
    type: 'uni-to',
    continuous: true
  }
}
```

Use as write queue to remote (similar to above), but also triggers a one-time replication job from remote on start.


```javascript
var options = {
  replicationStrategy: {
    type: 'bi-split',
    continuousTo: true,
    continuousFrom: false
  }
}
```


## Related libs

https://github.com/pegli/couchdb-dbperuser-provisioning
https://github.com/etrepum/couchperuser
