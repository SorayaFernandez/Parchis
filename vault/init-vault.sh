#!/usr/bin/env sh
set -eu
VAULT_ADDR=${VAULT_ADDR:-http://vault:8200}
export VAULT_ADDR
DB_USER=${DB_USER:-user}
export DB_USER
CREDS_DIR=/vault/creds
KEYS_FILE=/vault/data/keys.json   # persists in vault_data volume across restarts

apk add --no-cache jq openssl wget >/dev/null 2>&1 || true

status_code=999
until [ "$status_code" -eq 0 ] || [ "$status_code" -eq 2 ]; do
  if vault status -address="$VAULT_ADDR" -format=json >/dev/null 2>&1; then
    status_code=0
  else
    status_code=$?
  fi
  sleep 1
done

STATUS_JSON=$(vault status -address="$VAULT_ADDR" -format=json 2>/dev/null || true)
if [ "$(echo "$STATUS_JSON" | jq -r '.initialized // false')" != "true" ]; then
  vault operator init -address="$VAULT_ADDR" -key-shares=1 -key-threshold=1 -format=json > "$KEYS_FILE"
fi

ROOT_TOKEN=$(jq -r '.root_token' "$KEYS_FILE")
UNSEAL_KEY=$(jq -r '.unseal_keys_b64[0]' "$KEYS_FILE")

if [ "$(echo "$STATUS_JSON" | jq -r '.sealed // true')" = "true" ]; then
  vault operator unseal -address="$VAULT_ADDR" "$UNSEAL_KEY"
fi

export VAULT_TOKEN="$ROOT_TOKEN"

vault secrets enable -path=transcendence -version=2 kv 2>/dev/null || true

if vault kv get transcendence/db >/dev/null 2>&1; then
  echo "Secrets already exist in Vault. Skipping initialization."
  DB_PASS=$(vault kv get -field=password transcendence/db)
else
	DB_PASS=$(openssl rand -hex 16)
	JWT_SECRET=$(openssl rand -hex 32)

	vault kv put transcendence/db username="$DB_USER" password="$DB_PASS"
	vault kv put transcendence/jwt secret="$JWT_SECRET"
fi

cat > /tmp/policy.hcl <<POLICY
path "transcendence/data/*" { capabilities = ["read"] }
POLICY
vault policy write transcendence-app-role /tmp/policy.hcl

vault auth enable approle 2>/dev/null || true
vault write -force auth/approle/role/transcendence-role \
  token_policies="transcendence-app-role" \
  secret_id_ttl=0 token_ttl=1h token_max_ttl=4h

mkdir -p "$CREDS_DIR"
vault read -field=role_id auth/approle/role/transcendence-role/role-id > "$CREDS_DIR/role-id"
vault write -force -field=secret_id auth/approle/role/transcendence-role/secret-id > "$CREDS_DIR/secret-id"
echo "$DB_PASS" > "$CREDS_DIR/db-password"   # for the db container to consume too, see step 3

echo "Vault init complete."