# -*- mode: ruby -*-
# vi: set ft=ruby :

Vagrant.configure(2) do |config|
  config.vm.box = "ubuntu/trusty64"
  config.vm.provision :shell, path: "bootstrap.sh"

  config.vm.define "local" do |local|
    local.vm.network "private_network", ip: "192.168.50.40"
    local.vm.network "forwarded_port", guest: 5984, host: 9000
  end

  config.vm.define "remote" do |remote|
    remote.vm.network "private_network", ip: "192.168.50.50"
    remote.vm.network "forwarded_port", guest: 5984, host: 9100
  end
end
