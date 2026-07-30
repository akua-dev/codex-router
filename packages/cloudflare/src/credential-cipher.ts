import type { AccountId } from "@akua-dev/codex-router-core"
import { Context, Effect, Redacted, Schema } from "effect"

export class EncryptedCredentialEnvelope extends Schema.Class<EncryptedCredentialEnvelope>(
  "EncryptedCredentialEnvelope"
)({
  keyVersion: Schema.String,
  nonce: Schema.String,
  ciphertext: Schema.String
}) {}

export class CredentialCipherError extends Schema.TaggedErrorClass<CredentialCipherError>()(
  "CredentialCipherError",
  {
    message: Schema.String
  }
) {}

export interface CredentialCipherShape {
  readonly encrypt: (
    accountId: AccountId,
    generation: number,
    plaintext: Redacted.Redacted<string>
  ) => Effect.Effect<EncryptedCredentialEnvelope, CredentialCipherError>
  readonly decrypt: (
    accountId: AccountId,
    generation: number,
    envelope: unknown
  ) => Effect.Effect<Redacted.Redacted<string>, CredentialCipherError>
  readonly decryptForUse: (
    accountId: AccountId,
    generation: number,
    envelope: unknown
  ) => Effect.Effect<DecryptedCredential, CredentialCipherError>
}

export class CredentialCipher extends Context.Service<CredentialCipher, CredentialCipherShape>()(
  "@akua-dev/codex-router/CredentialCipher"
) {}

export interface CredentialCipherOptions {
  readonly currentVersion: string
  readonly keys: ReadonlyMap<string, CryptoKey>
}

export interface DecryptedCredential {
  readonly plaintext: Redacted.Redacted<string>
  readonly migration?: EncryptedCredentialEnvelope
}

const cipherFailure = () =>
  new CredentialCipherError({
    message: "Credential encryption or decryption failed; sensitive data was redacted"
  })

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

const decodeBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw cipherFailure()
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(base64 + padding)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

const decodeEnvelope = Schema.decodeUnknownEffect(EncryptedCredentialEnvelope)
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const copyToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

const additionalData = (accountId: AccountId, generation: number): ArrayBuffer =>
  copyToArrayBuffer(encoder.encode(JSON.stringify([accountId, generation])))

export const importAesGcmKey = Effect.fn("importAesGcmKey")(function* (bytes: Uint8Array) {
  if (bytes.byteLength !== 32) {
    return yield* cipherFailure()
  }
  return yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "raw",
        copyToArrayBuffer(bytes),
        {
          name: "AES-GCM"
        },
        false,
        ["encrypt", "decrypt"]
      ),
    catch: cipherFailure
  })
})

export const importAesGcmKeyFromBase64Url = Effect.fn("importAesGcmKeyFromBase64Url")(function* (
  encoded: Redacted.Redacted<string>
) {
  const bytes = yield* Effect.try({
    try: () => decodeBase64Url(Redacted.value(encoded)),
    catch: cipherFailure
  })
  return yield* importAesGcmKey(bytes)
})

export const importCredentialKeyring = Effect.fn("importCredentialKeyring")(function* (input: {
  readonly currentVersion: string
  readonly keys: ReadonlyMap<string, Redacted.Redacted<string>>
}) {
  const entries = yield* Effect.forEach(
    input.keys,
    ([version, encoded]) =>
      importAesGcmKeyFromBase64Url(encoded).pipe(Effect.map((key) => [version, key] as const)),
    { concurrency: "unbounded" }
  )
  return makeCredentialCipher({
    currentVersion: input.currentVersion,
    keys: new Map(entries)
  })
})

export const makeCredentialCipher = (options: CredentialCipherOptions): CredentialCipherShape =>
  CredentialCipher.of({
    encrypt: Effect.fn("CredentialCipher.encrypt")(function* (accountId, generation, plaintext) {
      const key = options.keys.get(options.currentVersion)
      if (key === undefined || !Number.isSafeInteger(generation) || generation < 1) {
        return yield* cipherFailure()
      }
      const nonce = crypto.getRandomValues(new Uint8Array(12))
      const algorithm: AesGcmParams = {
        additionalData: additionalData(accountId, generation),
        iv: copyToArrayBuffer(nonce),
        name: "AES-GCM",
        tagLength: 128
      }
      const ciphertext = yield* Effect.tryPromise({
        try: () => crypto.subtle.encrypt(algorithm, key, encoder.encode(Redacted.value(plaintext))),
        catch: cipherFailure
      })
      return EncryptedCredentialEnvelope.make({
        ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
        keyVersion: options.currentVersion,
        nonce: encodeBase64Url(nonce)
      })
    }),
    decrypt: Effect.fn("CredentialCipher.decrypt")(function* (accountId, generation, input) {
      const envelope = yield* decodeEnvelope(input).pipe(Effect.mapError(cipherFailure))
      const key = options.keys.get(envelope.keyVersion)
      if (key === undefined || !Number.isSafeInteger(generation) || generation < 1) {
        return yield* cipherFailure()
      }
      const nonce = yield* Effect.try({
        try: () => decodeBase64Url(envelope.nonce),
        catch: cipherFailure
      })
      if (nonce.byteLength !== 12) {
        return yield* cipherFailure()
      }
      const ciphertext = yield* Effect.try({
        try: () => decodeBase64Url(envelope.ciphertext),
        catch: cipherFailure
      })
      const algorithm: AesGcmParams = {
        additionalData: additionalData(accountId, generation),
        iv: copyToArrayBuffer(nonce),
        name: "AES-GCM",
        tagLength: 128
      }
      const plaintext = yield* Effect.tryPromise({
        try: () => crypto.subtle.decrypt(algorithm, key, copyToArrayBuffer(ciphertext)),
        catch: cipherFailure
      })
      return Redacted.make(decoder.decode(plaintext))
    }),
    decryptForUse: Effect.fn("CredentialCipher.decryptForUse")(
      function* (accountId, generation, input) {
        const envelope = yield* decodeEnvelope(input).pipe(Effect.mapError(cipherFailure))
        const plaintext = yield* makeCredentialCipher(options).decrypt(
          accountId,
          generation,
          envelope
        )
        if (envelope.keyVersion === options.currentVersion) {
          return { plaintext }
        }
        const migration = yield* makeCredentialCipher(options).encrypt(
          accountId,
          generation,
          plaintext
        )
        return { migration, plaintext }
      }
    )
  })
