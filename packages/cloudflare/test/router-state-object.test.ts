import { Database } from "bun:sqlite"
import { describe, expect, it } from "@effect/vitest"
import { SubscriptionCredential } from "@akua-dev/codex-router-codex"
import { AccountId, UsageSnapshot, UsageWindow } from "@akua-dev/codex-router-core"
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import { Effect, Redacted, Schema } from "effect"
import {
  RouterStateObject,
  encodeCredentialBundle,
  importAesGcmKey,
  makeCredentialCipher
} from "../src/index.ts"

type TestSqlValue = ArrayBuffer | string | number | null

const normalizeRows = (input: ReadonlyArray<unknown>): Array<Record<string, TestSqlValue>> =>
  input.map((row) => {
    if (typeof row !== "object" || row === null) {
      throw new Error("SQLite returned a non-object row")
    }
    const output: Record<string, TestSqlValue> = {}
    for (const [key, value] of Object.entries(row)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        value === null ||
        value instanceof ArrayBuffer
      ) {
        output[key] = value
      } else if (value instanceof Uint8Array) {
        const bytes = new ArrayBuffer(value.byteLength)
        new Uint8Array(bytes).set(value)
        output[key] = bytes
      } else {
        throw new Error("SQLite returned an unsupported value")
      }
    }
    return output
  })

const base64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

const request = (path: string, body: unknown, internalToken?: string): Request =>
  new Request(`https://router-state.internal${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(internalToken === undefined ? {} : { "x-ai-router-internal-token": internalToken })
    },
    method: "POST"
  })

describe("RouterStateObject subscription coordination", () => {
  it("bootstraps configured accounts inside Durable Object initialization", async () => {
    const database = new Database(":memory:")
    const sql = {
      exec(query: string, ...bindings: Array<string | number | null | ArrayBuffer>) {
        if (bindings.length === 0 && query.includes(";")) {
          database.exec(query)
          return { toArray: () => [] }
        }
        const normalizedBindings = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value
        )
        const rows = normalizeRows(database.query(query).all(...normalizedBindings))
        return {
          toArray: () => rows
        }
      }
    }
    const state = {
      blockConcurrencyWhile: <A>(body: () => Promise<A>) => body(),
      storage: {
        sql,
        transactionSync: <A>(body: () => A) => body()
      }
    }
    const namespace = {
      get: () => ({ fetch: () => Promise.resolve(new Response()) }),
      idFromName: () => "global"
    }
    const now = Date.now()
    const object = new RouterStateObject(state, {
      CF_AIG_ACCOUNT_ID: "cf-account",
      CF_AIG_CUSTOM_PROVIDER_SLUG: "codex-subscription",
      CF_AIG_GATEWAY_ID: "router",
      CF_AIG_TOKEN: "aig-token",
      CODEX_ROUTER_ACCOUNTS_JSON: JSON.stringify([
        {
          accessToken: "access-secret",
          accountId: "account-a",
          expiresAt: now + 60 * 60_000,
          observedAt: now,
          providerAccountId: "provider-a",
          refreshToken: "refresh-secret",
          shortResetAt: now + 60 * 60_000,
          shortUsedPercent: 5,
          weeklyResetAt: now + 7 * 24 * 60 * 60_000,
          weeklyUsedPercent: 10
        }
      ]),
      CODEX_ROUTER_ADMIN_TOKEN: "internal-secret",
      CODEX_ROUTER_CLIENT_TOKEN: "client-secret",
      CODEX_ROUTER_CREDENTIAL_KEYS_JSON: JSON.stringify({
        currentVersion: "v1",
        keys: { v1: base64Url(crypto.getRandomValues(new Uint8Array(32))) }
      }),
      CODEX_ROUTER_RELAY_TOKEN: "relay-secret",
      ROUTER_STATE: namespace
    })

    const accounts = await object.fetch(request("/admin/accounts/list", {}, "internal-secret"))
    const acquired = await object.fetch(request("/route/acquire", { now }))

    const grant = await acquired.json()
    expect(await accounts.json()).toMatchObject({
      accounts: [{ accountId: "account-a" }]
    })
    expect(acquired.status).toBe(200)
    expect(grant).toMatchObject({ accountId: "account-a" })
    expect(JSON.stringify(grant)).not.toContain("access-secret")
    database.close()
  })

  it("seeds once, fuses credential delivery, and applies generation-safe responses", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = new Database(":memory:")
        const sql = {
          exec(query: string, ...bindings: Array<string | number | null | ArrayBuffer>) {
            if (bindings.length === 0 && query.includes(";")) {
              database.exec(query)
              return { toArray: () => [] }
            }
            const normalizedBindings = bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value
            )
            const rows = database.query(query).all(...normalizedBindings)
            const decoded = normalizeRows(rows)
            return { toArray: () => decoded }
          }
        }
        const state = {
          blockConcurrencyWhile: <A>(body: () => Promise<A>) => body(),
          storage: {
            sql,
            transactionSync: <A>(body: () => A) => body()
          }
        }
        const namespace = {
          get: () => ({ fetch: () => Promise.resolve(new Response()) }),
          idFromName: () => "global"
        }
        const rawKey = crypto.getRandomValues(new Uint8Array(32))
        const environment = {
          CF_AIG_ACCOUNT_ID: "cf-account",
          CF_AIG_CUSTOM_PROVIDER_SLUG: "codex-subscription",
          CF_AIG_GATEWAY_ID: "router",
          CF_AIG_TOKEN: "aig-token",
          CODEX_ROUTER_ACCOUNTS_JSON: "[]",
          CODEX_ROUTER_ADMIN_TOKEN: "internal-secret",
          CODEX_ROUTER_CLIENT_TOKEN: "client-secret",
          CODEX_ROUTER_CREDENTIAL_KEYS_JSON: JSON.stringify({
            currentVersion: "v1",
            keys: { v1: base64Url(rawKey) }
          }),
          CODEX_ROUTER_RELAY_TOKEN: "relay-secret",
          ROUTER_STATE: namespace
        }
        const object = new RouterStateObject(state, environment)
        const key = yield* importAesGcmKey(rawKey)
        const cipher = yield* makeCredentialCipher({
          currentVersion: "v1",
          keys: new Map([["v1", key]])
        }).pipe(Effect.provide(BrowserCrypto.layer))
        const now = Date.now()
        const accountId = AccountId.make("account-a")
        const credential = SubscriptionCredential.make({
          accessToken: Redacted.make("access-secret"),
          accountId,
          expiresAt: now + 60 * 60_000,
          generation: 1,
          providerAccountId: Redacted.make("provider-a"),
          refreshToken: Redacted.make("refresh-secret")
        })
        const envelope = yield* cipher.encrypt(
          accountId,
          credential.generation,
          encodeCredentialBundle(credential)
        )
        const usage = UsageSnapshot.make({
          accountId,
          observedAt: now,
          short: UsageWindow.make({
            resetAt: now + 60 * 60_000,
            usedPercent: 5
          }),
          weekly: UsageWindow.make({
            resetAt: now + 7 * 24 * 60 * 60_000,
            usedPercent: 10
          })
        })
        const seed = {
          accounts: [
            {
              accountId,
              credential: envelope,
              expiresAt: credential.expiresAt,
              generation: credential.generation,
              usage
            }
          ]
        }

        const unauthorized = yield* Effect.promise(() => object.fetch(request("/seed", seed)))
        const firstSeed = yield* Effect.promise(() =>
          object.fetch(request("/seed", seed, "internal-secret"))
        )
        const secondSeed = yield* Effect.promise(() =>
          object.fetch(request("/seed", seed, "internal-secret"))
        )
        const acquired = yield* Effect.promise(() =>
          object.fetch(request("/route/acquire", { now }))
        )
        const grant = yield* Effect.promise(() => acquired.json())
        const Grant = Schema.Struct({
          accountId: Schema.String,
          credential: Schema.Struct({
            ciphertext: Schema.String,
            generation: Schema.Number,
            keyVersion: Schema.String,
            nonce: Schema.String
          }),
          leaseToken: Schema.String
        })
        const decodedGrant = yield* Schema.decodeUnknownEffect(Grant)(grant)

        yield* Effect.promise(() =>
          object.fetch(
            request("/route/record-response", {
              accountId,
              generation: 999,
              kind: "reauth",
              now,
              retryAt: null
            })
          )
        )
        const staleSummary = yield* Effect.promise(() => object.fetch(request("/summary", { now })))
        const staleText = yield* Effect.promise(() => staleSummary.text())
        yield* Effect.promise(() =>
          object.fetch(
            request("/route/record-response", {
              accountId,
              generation: 1,
              kind: "reauth",
              now,
              retryAt: null
            })
          )
        )
        const currentSummary = yield* Effect.promise(() =>
          object.fetch(request("/summary", { now }))
        )
        const currentText = yield* Effect.promise(() => currentSummary.text())

        expect(unauthorized.status).toBe(401)
        expect(yield* Effect.promise(() => firstSeed.json())).toEqual({ inserted: 1 })
        expect(yield* Effect.promise(() => secondSeed.json())).toEqual({ inserted: 0 })
        expect(acquired.status).toBe(200)
        expect(decodedGrant.accountId).toBe(accountId)
        expect(decodedGrant.credential.generation).toBe(1)
        expect(decodedGrant.credential.ciphertext).toBe(envelope.ciphertext)
        expect(staleText).toContain('"requiresReauthentication":false')
        expect(currentText).toContain('"requiresReauthentication":true')
        expect(staleText).not.toContain("access-secret")
        expect(currentText).not.toContain("provider-a")
        database.close()
      })
    )
  })
})
