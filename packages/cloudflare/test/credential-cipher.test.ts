import { describe, expect, it } from "@effect/vitest"
import { AccountId } from "@akua-dev/codex-router-core"
import { Effect, Redacted } from "effect"
import { CredentialCipherError, importAesGcmKey, makeCredentialCipher } from "../src/index.ts"

const randomKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32))

describe("credential cipher", () => {
  it("round-trips with random nonces and an explicit key version", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* importAesGcmKey(randomKey())
        const cipher = makeCredentialCipher({
          currentVersion: "v1",
          keys: new Map([["v1", key]])
        })
        const accountId = AccountId.make("account-a")
        const plaintext = Redacted.make("refresh-and-access-token-bundle")

        const first = yield* cipher.encrypt(accountId, 3, plaintext)
        const second = yield* cipher.encrypt(accountId, 3, plaintext)
        const decrypted = yield* cipher.decrypt(accountId, 3, first)

        expect(first.keyVersion).toBe("v1")
        expect(first.nonce).not.toBe(second.nonce)
        expect(first.ciphertext).not.toBe(second.ciphertext)
        expect(Redacted.value(decrypted)).toBe("refresh-and-access-token-bundle")
        expect(JSON.stringify(first)).not.toContain("refresh-and-access-token-bundle")
      })
    )
  })

  it("binds ciphertext to the opaque account id through AAD", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* importAesGcmKey(randomKey())
        const cipher = makeCredentialCipher({
          currentVersion: "v1",
          keys: new Map([["v1", key]])
        })
        const envelope = yield* cipher.encrypt(
          AccountId.make("account-a"),
          4,
          Redacted.make("credential-secret-value")
        )
        const wrongAccount = yield* Effect.flip(
          cipher.decrypt(AccountId.make("account-b"), 4, envelope)
        )
        const wrongGeneration = yield* Effect.flip(
          cipher.decrypt(AccountId.make("account-a"), 5, envelope)
        )

        expect(wrongAccount).toBeInstanceOf(CredentialCipherError)
        expect(wrongGeneration).toBeInstanceOf(CredentialCipherError)
        expect(wrongAccount.message).not.toContain("credential-secret-value")
      })
    )
  })

  it("rejects unknown versions, wrong keys, and malformed envelopes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* importAesGcmKey(randomKey())
        const otherKey = yield* importAesGcmKey(randomKey())
        const encryptor = makeCredentialCipher({
          currentVersion: "v1",
          keys: new Map([["v1", key]])
        })
        const wrongDecryptor = makeCredentialCipher({
          currentVersion: "v1",
          keys: new Map([["v1", otherKey]])
        })
        const envelope = yield* encryptor.encrypt(
          AccountId.make("account-a"),
          1,
          Redacted.make("credential")
        )

        expect(
          yield* Effect.flip(wrongDecryptor.decrypt(AccountId.make("account-a"), 1, envelope))
        ).toBeInstanceOf(CredentialCipherError)
        expect(
          yield* Effect.flip(
            encryptor.decrypt(AccountId.make("account-a"), 1, {
              ciphertext: envelope.ciphertext,
              keyVersion: "missing",
              nonce: envelope.nonce
            })
          )
        ).toBeInstanceOf(CredentialCipherError)
        expect(
          yield* Effect.flip(
            encryptor.decrypt(AccountId.make("account-a"), 1, {
              ciphertext: "not-base64***",
              keyVersion: "v1",
              nonce: "short"
            })
          )
        ).toBeInstanceOf(CredentialCipherError)
      })
    )
  })

  it("decrypts retained keys and returns a fresh current-key migration envelope", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const oldKey = yield* importAesGcmKey(randomKey())
        const currentKey = yield* importAesGcmKey(randomKey())
        const oldCipher = makeCredentialCipher({
          currentVersion: "v1",
          keys: new Map([["v1", oldKey]])
        })
        const rotatingCipher = makeCredentialCipher({
          currentVersion: "v2",
          keys: new Map([
            ["v1", oldKey],
            ["v2", currentKey]
          ])
        })
        const accountId = AccountId.make("account-a")
        const envelope = yield* oldCipher.encrypt(accountId, 7, Redacted.make("credential-secret"))

        const result = yield* rotatingCipher.decryptForUse(accountId, 7, envelope)

        expect(Redacted.value(result.plaintext)).toBe("credential-secret")
        expect(result.migration?.keyVersion).toBe("v2")
        expect(result.migration?.nonce).not.toBe(envelope.nonce)
      })
    )
  })
})
