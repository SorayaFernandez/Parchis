ui = false

disable_mlock = true

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

storage "file" {
  path = "/vault/data"
}

api_addr = "http://vault:8200"
cluster_addr = "http://vault:8201"

default_lease_ttl = "168h"
max_lease_ttl     = "720h"
