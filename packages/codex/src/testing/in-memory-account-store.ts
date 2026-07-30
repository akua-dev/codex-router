import {
  Candidate,
  RoutingState,
  type AccountId,
  type UsageSnapshot
} from "@akua-dev/codex-router-core"
import { Effect, Layer, Option, SynchronizedRef } from "effect"
import {
  RefreshClaim,
  RefreshClaimToken,
  SubscriptionAccountState,
  SubscriptionAccountStore,
  SubscriptionAccountStoreError,
  SubscriptionRouteGrant,
  type SubscriptionAccountStoreShape
} from "../account-store.ts"
import type { SubscriptionCredential } from "../credentials.ts"

interface StoreState {
  readonly accounts: ReadonlyMap<AccountId, SubscriptionAccountState>
  readonly claims: ReadonlyMap<RefreshClaimToken, RefreshClaim>
  readonly sequence: number
}

const transition = <A>(value: A, state: StoreState): readonly [A, StoreState] => [value, state]

const storeFailure = () =>
  new SubscriptionAccountStoreError({
    message: "The in-memory routing state operation failed"
  })

const cleanClaims = (
  claims: ReadonlyMap<RefreshClaimToken, RefreshClaim>,
  now: number
): ReadonlyMap<RefreshClaimToken, RefreshClaim> =>
  new Map([...claims].filter(([, claim]) => claim.expiresAt > now))

const replaceAccount = (
  source: SubscriptionAccountState,
  options: {
    readonly credential?: SubscriptionCredential
    readonly requiresReauthentication?: boolean
    readonly usage?: UsageSnapshot
  }
): SubscriptionAccountState =>
  SubscriptionAccountState.make({
    accountId: source.accountId,
    enabled: source.enabled,
    requiresReauthentication: options.requiresReauthentication ?? source.requiresReauthentication,
    ...(options.credential === undefined
      ? source.credential === undefined
        ? {}
        : { credential: source.credential }
      : { credential: options.credential }),
    ...(options.usage === undefined
      ? source.usage === undefined
        ? {}
        : { usage: source.usage }
      : { usage: options.usage })
  })

const candidateFromAccount = (account: SubscriptionAccountState): Candidate =>
  Candidate.make({
    accountId: account.accountId,
    activeReservations: 0,
    requiresReauthentication: account.requiresReauthentication,
    ...(account.usage === undefined ? {} : { usage: account.usage })
  })

export const makeInMemorySubscriptionAccountStore = Effect.fn(
  "makeInMemorySubscriptionAccountStore"
)(function* (initial: ReadonlyArray<SubscriptionAccountState>) {
  const routing = yield* RoutingState
  const ref = yield* SynchronizedRef.make<StoreState>({
    accounts: new Map(initial.map((account) => [account.accountId, account])),
    claims: new Map(),
    sequence: 0
  })

  const seedIfAbsent: SubscriptionAccountStoreShape["seedIfAbsent"] = Effect.fn(
    "InMemorySubscriptionAccountStore.seedIfAbsent"
  )((accounts) =>
    SynchronizedRef.modify(ref, (state) => {
      const next = new Map(state.accounts)
      let inserted = 0
      for (const account of accounts) {
        if (!next.has(account.accountId)) {
          next.set(account.accountId, account)
          inserted += 1
        }
      }
      return transition(inserted, { ...state, accounts: next })
    })
  )

  const list: SubscriptionAccountStoreShape["list"] = SynchronizedRef.get(ref).pipe(
    Effect.map((state) => [...state.accounts.values()])
  )

  const get: SubscriptionAccountStoreShape["get"] = Effect.fn(
    "InMemorySubscriptionAccountStore.get"
  )((accountId) =>
    SynchronizedRef.get(ref).pipe(
      Effect.map((state) => Option.fromNullishOr(state.accounts.get(accountId)))
    )
  )

  const claim: SubscriptionAccountStoreShape["claim"] = Effect.fn(
    "InMemorySubscriptionAccountStore.claim"
  )((accountId, operation, generation, now) =>
    SynchronizedRef.modify(ref, (state) => {
      const claims = cleanClaims(state.claims, now)
      const account = state.accounts.get(accountId)
      const alreadyClaimed = [...claims.values()].some(
        (value) => value.accountId === accountId && value.operation === operation
      )
      if (
        account?.credential?.generation !== generation ||
        account.requiresReauthentication ||
        alreadyClaimed
      ) {
        return transition(Option.none<RefreshClaim>(), { ...state, claims })
      }
      const sequence = state.sequence + 1
      const token = RefreshClaimToken.make(`in-memory-claim-${sequence}`)
      const refreshClaim = RefreshClaim.make({
        accountId,
        expiresAt: now + 30_000,
        generation,
        operation,
        token
      })
      const next = new Map(claims)
      next.set(token, refreshClaim)
      return transition(Option.some(refreshClaim), {
        ...state,
        claims: next,
        sequence
      })
    })
  )

  const releaseClaim: SubscriptionAccountStoreShape["releaseClaim"] = Effect.fn(
    "InMemorySubscriptionAccountStore.releaseClaim"
  )((claimToken) =>
    SynchronizedRef.update(ref, (state) => {
      const claims = new Map(state.claims)
      claims.delete(claimToken)
      return { ...state, claims }
    })
  )

  const commitCredential: SubscriptionAccountStoreShape["commitCredential"] = Effect.fn(
    "InMemorySubscriptionAccountStore.commitCredential"
  )((commit) =>
    SynchronizedRef.modify(ref, (state) => {
      const account = state.accounts.get(commit.accountId)
      const claim = state.claims.get(commit.claimToken)
      if (
        account?.credential?.generation !== commit.expectedGeneration ||
        claim?.accountId !== commit.accountId ||
        claim.operation !== "credential" ||
        claim.generation !== commit.expectedGeneration ||
        commit.credential.generation !== commit.expectedGeneration + 1
      ) {
        return transition(false, state)
      }
      const accounts = new Map(state.accounts)
      accounts.set(
        commit.accountId,
        replaceAccount(account, {
          credential: commit.credential,
          requiresReauthentication: false
        })
      )
      const claims = new Map(state.claims)
      claims.delete(commit.claimToken)
      return transition(true, { ...state, accounts, claims })
    })
  )

  const commitUsage: SubscriptionAccountStoreShape["commitUsage"] = Effect.fn(
    "InMemorySubscriptionAccountStore.commitUsage"
  )((commit) =>
    SynchronizedRef.modify(ref, (state) => {
      const account = state.accounts.get(commit.accountId)
      const claim = state.claims.get(commit.claimToken)
      if (
        account?.credential?.generation !== commit.expectedGeneration ||
        claim?.accountId !== commit.accountId ||
        claim.operation !== "usage" ||
        claim.generation !== commit.expectedGeneration ||
        commit.usage.accountId !== commit.accountId
      ) {
        return transition(false, state)
      }
      const accounts = new Map(state.accounts)
      accounts.set(commit.accountId, replaceAccount(account, { usage: commit.usage }))
      const claims = new Map(state.claims)
      claims.delete(commit.claimToken)
      return transition(true, { ...state, accounts, claims })
    })
  )

  const markRequiresReauthentication: SubscriptionAccountStoreShape["markRequiresReauthentication"] =
    Effect.fn("InMemorySubscriptionAccountStore.markRequiresReauthentication")(
      (accountId, generation) =>
        SynchronizedRef.modify(ref, (state) => {
          const account = state.accounts.get(accountId)
          if (account?.credential?.generation !== generation) {
            return transition(false, state)
          }
          const accounts = new Map(state.accounts)
          accounts.set(accountId, replaceAccount(account, { requiresReauthentication: true }))
          return transition(true, { ...state, accounts })
        })
    )

  const acquire: SubscriptionAccountStoreShape["acquire"] = Effect.fn(
    "InMemorySubscriptionAccountStore.acquire"
  )(function* (input) {
    const state = yield* SynchronizedRef.get(ref)
    const allowed = new Set(input.accountIds)
    const candidates = [...state.accounts.values()]
      .filter(
        (account) =>
          allowed.has(account.accountId) &&
          account.enabled &&
          account.credential !== undefined &&
          account.credential.expiresAt > input.now
      )
      .map(candidateFromAccount)
    const lease = yield* routing
      .acquire({
        candidates,
        now: input.now,
        ...(input.sessionKey === undefined ? {} : { sessionKey: input.sessionKey })
      })
      .pipe(Effect.mapError(storeFailure))
    if (Option.isNone(lease)) {
      return Option.none<SubscriptionRouteGrant>()
    }
    const selected = yield* SynchronizedRef.get(ref)
    const selectedCredential = selected.accounts.get(lease.value.accountId)?.credential
    if (selectedCredential === undefined) {
      yield* routing.release(lease.value.leaseToken).pipe(Effect.mapError(storeFailure))
      return Option.none<SubscriptionRouteGrant>()
    }
    return Option.some(
      SubscriptionRouteGrant.make({
        credential: selectedCredential,
        lease: lease.value
      })
    )
  })

  const renew: SubscriptionAccountStoreShape["renew"] = Effect.fn(
    "InMemorySubscriptionAccountStore.renew"
  )((leaseToken, now) => routing.renew(leaseToken, now).pipe(Effect.mapError(storeFailure)))

  const release: SubscriptionAccountStoreShape["release"] = Effect.fn(
    "InMemorySubscriptionAccountStore.release"
  )((leaseToken) => routing.release(leaseToken).pipe(Effect.mapError(storeFailure)))

  const recordResponse: SubscriptionAccountStoreShape["recordResponse"] = Effect.fn(
    "InMemorySubscriptionAccountStore.recordResponse"
  )(function* (input) {
    const current = yield* get(input.accountId)
    if (Option.isNone(current) || current.value.credential?.generation !== input.generation) {
      return
    }
    if (input.classification.kind === "reauth") {
      yield* markRequiresReauthentication(input.accountId, input.generation)
    }
    yield* routing
      .recordResponse(input.accountId, input.classification, input.now)
      .pipe(Effect.mapError(storeFailure))
  })

  const summary: SubscriptionAccountStoreShape["summary"] = Effect.fn(
    "InMemorySubscriptionAccountStore.summary"
  )((now) => routing.summary(now).pipe(Effect.mapError(storeFailure)))

  return SubscriptionAccountStore.of({
    acquire,
    claim,
    commitCredential,
    commitUsage,
    get,
    list,
    markRequiresReauthentication,
    recordResponse,
    release,
    releaseClaim,
    renew,
    seedIfAbsent,
    summary
  })
})

export const inMemorySubscriptionAccountStoreLayer = (
  initial: ReadonlyArray<SubscriptionAccountState>
) => Layer.effect(SubscriptionAccountStore, makeInMemorySubscriptionAccountStore(initial))
