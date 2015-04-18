# -*- mode: ruby -*-
# vi: set ft=ruby :

Vagrant.configure(2) do |config|
  config.vm.box = "ubuntu/trusty64"
  config.vm.provision :shell, path: "bootstrap.sh"

  config.vm.define "spoke1" do |spoke1|
    spoke1.vm.network "private_network", ip: "192.168.50.40"
    spoke1.vm.network "forwarded_port", guest: 5984, host: 9000
  end

  config.vm.define "spoke2" do |spoke2|
    spoke2.vm.network "private_network", ip: "192.168.50.41"
    spoke2.vm.network "forwarded_port", guest: 5984, host: 9010
  end

  config.vm.define "spoke3" do |spoke3|
    spoke3.vm.network "private_network", ip: "192.168.50.42"
    spoke3.vm.network "forwarded_port", guest: 5984, host: 9020
  end

  config.vm.define "hub" do |hub|
    hub.vm.network "private_network", ip: "192.168.50.50"
    hub.vm.network "forwarded_port", guest: 5984, host: 9100
  end
end
