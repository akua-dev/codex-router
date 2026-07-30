import { AccountId } from "@akua-dev/codex-router-core"
import {
  DeviceAuthorization,
  DeviceAuthorizationPending,
  DeviceAuthorizationReady,
  SubscriptionCredential,
  type OAuthClientShape
} from "@akua-dev/codex-router-codex"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import {
  RemoteAdminConfigurationError,
  makeRemoteAccountAdminClient,
  runRemoteDeviceLogin
} from "../src/index.ts"

describe("remote account administration", () => {
  it.effect("rejects plaintext non-loopback administration before transport", () =>
    Effect.gen(function* () {
      let transported = false
      const error = yield* Effect.flip(
        makeRemoteAccountAdminClient({
          adminToken: Redacted.make("admin-secret"),
          baseUrl: "http://router.example.com",
          transport: () => {
            transported = true
            return Promise.resolve(new Response())
          }
        })
      )

      expect(error).toBeInstanceOf(RemoteAdminConfigurationError)
      expect(transported).toBe(false)
    })
  )

  it.effect(
    "polls device authorization with a schedule and uploads only to the admin boundary",
    () =>
      Effect.gen(function* () {
        const accountId = AccountId.make("account-a")
        const credential = SubscriptionCredential.make({
          accessToken: Redacted.make("access-secret"),
          accountId,
          expiresAt: Date.UTC(2026, 6, 30, 13),
          generation: 1,
          providerAccountId: Redacted.make("provider-a"),
          refreshToken: Redacted.make("refresh-secret")
        })
        let polls = 0
        const oauth: OAuthClientShape = {
          refresh: () => Effect.succeed(credential),
          startDeviceAuthorization: () =>
            Effect.succeed(
              DeviceAuthorization.make({
                deviceAuthId: Redacted.make("device-secret"),
                expiresAt: Date.UTC(2026, 6, 30, 14),
                intervalSeconds: 0,
                userCode: "ABCD-EFGH",
                verificationUri: "https://auth.openai.com/codex/device"
              })
            ),
          pollDeviceAuthorization: () => {
            polls += 1
            return Effect.succeed(
              polls === 1
                ? DeviceAuthorizationPending.make({ retryAfterSeconds: 0 })
                : DeviceAuthorizationReady.make({ credential })
            )
          }
        }
        let instruction = ""
        let request: Request | undefined
        const admin = yield* makeRemoteAccountAdminClient({
          adminToken: Redacted.make("admin-secret"),
          baseUrl: "https://router.example.com",
          transport: (input) => {
            request = input
            return Promise.resolve(
              Response.json({
                accountId: "account-a",
                enabled: true,
                expiresAt: credential.expiresAt,
                generation: 1,
                requiresReauthentication: false
              })
            )
          }
        })

        const result = yield* runRemoteDeviceLogin({
          accountId,
          admin,
          oauth,
          onInstruction: (message) =>
            Effect.sync(() => {
              instruction = message
            })
        })

        expect(result.accountId).toBe(accountId)
        expect(polls).toBe(2)
        expect(instruction).toContain("ABCD-EFGH")
        expect(request?.headers.get("x-ai-router-admin-token")).toBe("admin-secret")
        expect(request?.headers.get("x-ai-router-token")).toBeNull()
        expect(yield* Effect.promise(() => request?.text() ?? Promise.resolve(""))).not.toContain(
          "provider-a"
        )
      })
  )
})
