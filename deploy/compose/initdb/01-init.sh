#!/bin/sh
# Creates the keycloak database and the unprivileged application role used by the API.
# The API role is NOT a superuser and does NOT bypass row-level security.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
CREATE DATABASE keycloak;
CREATE ROLE davra_app LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE davra TO davra_app;
EOSQL
