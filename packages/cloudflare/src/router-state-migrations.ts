import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator"
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

export const routerStateMigrations = SqliteMigrator.fromRecord({
  "1_router_state": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE IF NOT EXISTS assignments (
        session_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `.withoutTransform
    yield* sql`
      CREATE TABLE IF NOT EXISTS reservations (
        lease_token TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        session_key TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `.withoutTransform
    yield* sql`
      CREATE INDEX IF NOT EXISTS reservations_account_expiry
      ON reservations(account_id, expires_at)
    `.withoutTransform
    yield* sql`
      CREATE TABLE IF NOT EXISTS blocks (
        account_id TEXT PRIMARY KEY,
        block_kind TEXT CHECK(block_kind IN ('quota', 'transient') OR block_kind IS NULL),
        retry_at INTEGER,
        requires_reauth INTEGER NOT NULL DEFAULT 0 CHECK(requires_reauth IN (0, 1))
      )
    `.withoutTransform
    yield* sql`
      CREATE TABLE IF NOT EXISTS subscription_accounts (
        account_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        credential_generation INTEGER NOT NULL CHECK(credential_generation > 0),
        expires_at INTEGER NOT NULL,
        requires_reauth INTEGER NOT NULL DEFAULT 0 CHECK(requires_reauth IN (0, 1)),
        key_version TEXT NOT NULL,
        nonce TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `.withoutTransform
    yield* sql`
      CREATE TABLE IF NOT EXISTS subscription_usage (
        account_id TEXT PRIMARY KEY,
        credential_generation INTEGER NOT NULL CHECK(credential_generation > 0),
        observed_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )
    `.withoutTransform
    yield* sql`
      CREATE TABLE IF NOT EXISTS refresh_claims (
        account_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('credential', 'usage')),
        credential_generation INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY(account_id, operation)
      )
    `.withoutTransform
  })
})
