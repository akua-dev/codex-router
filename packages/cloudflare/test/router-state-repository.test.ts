import { Database, type SQLQueryBindings } from "bun:sqlite"
import {
  AccountId,
  Candidate,
  UsageSnapshot,
  UsageWindow,
  defaultRoutingConfig
} from "@akua-dev/codex-router-core"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient"
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator"
import { expect, layer } from "@effect/vitest"
import { Effect, Layer, Option, Result } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import {
  RouterStateRepository,
  routerStateMigrations,
  routerStateRepositoryLayer
} from "../src/index.ts"

type SqlValue = ArrayBuffer | string | number | null

const normalizedValue = (value: unknown): SqlValue => {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    value === null ||
    value instanceof ArrayBuffer
  ) {
    return value
  }
  if (value instanceof Uint8Array) {
    const buffer = new ArrayBuffer(value.byteLength)
    new Uint8Array(buffer).set(value)
    return buffer
  }
  throw new Error("SQLite returned an unsupported test value")
}

class TestDurableObjectStorage {
  readonly database = new Database(":memory:")
  readonly sql = {
    exec: (query: string, ...bindings: ReadonlyArray<unknown>) => {
      const statement = this.database.query(query)
      const normalizedBindings = bindings.map((value): SQLQueryBindings =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : (value as SQLQueryBindings)
      )
      const values = (statement.values(...normalizedBindings) ?? []).map((row) =>
        row.map(normalizedValue)
      )
      return {
        columnNames: statement.columnNames,
        *raw(): IterableIterator<Array<SqlValue>> {
          for (const row of values) {
            yield [...row]
          }
        }
      }
    }
  }

  async transaction<A>(
    body: (transaction: { readonly rollback: () => void }) => Promise<A>
  ): Promise<A> {
    this.database.exec("BEGIN IMMEDIATE")
    let rolledBack = false
    try {
      const value = await Promise.resolve().then(() =>
        body({
          rollback: () => {
            rolledBack = true
          }
        })
      )
      this.database.exec(rolledBack ? "ROLLBACK" : "COMMIT")
      return value
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  close(): void {
    this.database.close()
  }
}

const makeLayer = (storage: TestDurableObjectStorage) => {
  const sql = SqliteClient.layer({
    storage: storage as unknown as DurableObjectStorage
  })
  const migrations = SqliteMigrator.layer({
    loader: routerStateMigrations
  }).pipe(Layer.provide(sql))
  const infrastructure = Layer.mergeAll(sql, migrations, BrowserCrypto.layer)
  const repository = routerStateRepositoryLayer.pipe(Layer.provide(infrastructure))
  return Layer.merge(repository, infrastructure).pipe(Layer.orDie)
}

const now = Date.UTC(2026, 6, 30, 12)
const accountId = AccountId.make("account-a")
const candidate = Candidate.make({
  accountId,
  activeReservations: 0,
  requiresReauthentication: false,
  usage: UsageSnapshot.make({
    accountId,
    observedAt: now,
    short: UsageWindow.make({
      resetAt: now + 18_000_000,
      usedPercent: 10
    }),
    weekly: UsageWindow.make({
      resetAt: now + 604_800_000,
      usedPercent: 20
    })
  })
})

const storage = new TestDurableObjectStorage()

layer(makeLayer(storage))("Effect Durable Object SQLite repository", (it) => {
  it.effect("records official migrations and rolls back failed transactions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrations = yield* sql<{
        readonly migration_id: number
        readonly name: string
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        ORDER BY migration_id
      `
      const failed = yield* Effect.result(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO blocks(account_id, block_kind, retry_at, requires_reauth)
              VALUES ('rollback-account', 'quota', NULL, 0)
            `
            return yield* Effect.fail("rollback")
          })
        )
      )
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM blocks
        WHERE account_id = 'rollback-account'
      `

      expect(migrations).toEqual([{ migration_id: 1, name: "router_state" }])
      expect(Result.isFailure(failed)).toBe(true)
      expect(rows[0]?.count).toBe(0)
    })
  )

  it.effect("serializes repeated acquisitions and preserves reservation counts", () =>
    Effect.gen(function* () {
      const repository = yield* RouterStateRepository
      yield* repository.insertSeedAccounts(
        [
          {
            accountId,
            credential: {
              ciphertext: "ciphertext",
              keyVersion: "v1",
              nonce: "nonce"
            },
            expiresAt: now + 3_600_000,
            generation: 1,
            usage: { observedAt: now },
            usageJson: JSON.stringify(candidate.usage)
          }
        ],
        now
      )

      const acquisitions = yield* Effect.all(
        Array.from({ length: 20 }, (_, index) =>
          repository.acquire(
            [candidate],
            new Set([accountId]),
            now + index,
            `session-${index}`,
            defaultRoutingConfig
          )
        ),
        { concurrency: 1 }
      )
      const summary = yield* repository.summary(now + 20, defaultRoutingConfig)

      expect(acquisitions.filter(Option.isSome)).toHaveLength(20)
      expect(summary.reservations).toBe(20)
      expect(summary.activeCounts.get(accountId)).toBe(20)
    })
  )
})
