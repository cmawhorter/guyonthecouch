#!/usr/bin/env bash

apt-get install -y nodejs
ln -s /usr/bin/nodejs /usr/bin/node
apt-get install -y npm

apt-get install -y curl
npm install -g prettyjson forever

add-apt-repository ppa:couchdb/stable -y
apt-get update -y
apt-get upgrade -y
apt-get install -y couchdb

sed -ie "s/^;bind_address = 127\.0\.0\.1/bind_address = 0.0.0.0/" /etc/couchdb/local.ini
service couchdb restart
