import { describe, expect, test } from "bun:test"

interface Resource {
  readonly apiVersion: string
  readonly kind: string
  readonly metadata: {
    readonly labels?: Readonly<Record<string, string>>
    readonly name: string
    readonly namespace?: string
  }
  readonly spec?: Record<string, unknown>
}

const manifests = new URL("../../../deploy/kubernetes/relay", import.meta.url).pathname

const render = async (): Promise<ReadonlyArray<Resource>> => {
  const child = Bun.spawn(["kubectl", "kustomize", manifests], {
    stderr: "pipe",
    stdout: "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  return Bun.YAML.parse(stdout) as ReadonlyArray<Resource>
}

const resource = (resources: ReadonlyArray<Resource>, kind: string, name: string): Resource => {
  const found = resources.find(
    (candidate) => candidate.kind === kind && candidate.metadata.name === name
  )
  if (found === undefined) {
    throw new Error(`missing ${kind}/${name}`)
  }
  return found
}

describe("relay Kubernetes deployment", () => {
  test("renders an isolated non-root relay and tunnel with external secrets", async () => {
    const resources = await render()

    expect(resources.map(({ kind, metadata }) => `${kind}/${metadata.name}`).sort()).toEqual([
      "Deployment/codex-router-egress",
      "Namespace/codex-router",
      "NetworkPolicy/codex-router-egress",
      "ServiceAccount/codex-router-egress"
    ])
    const deployment = resource(resources, "Deployment", "codex-router-egress")
    const spec = deployment.spec as {
      readonly replicas: number
      readonly template: {
        readonly spec: {
          readonly automountServiceAccountToken: boolean
          readonly containers: ReadonlyArray<Record<string, unknown>>
          readonly imagePullSecrets: ReadonlyArray<{ readonly name: string }>
          readonly securityContext: Record<string, unknown>
        }
      }
    }
    expect(spec.replicas).toBe(1)
    expect(spec.template.spec.automountServiceAccountToken).toBe(false)
    expect(spec.template.spec.imagePullSecrets).toEqual([{ name: "codex-router-ghcr" }])
    expect(spec.template.spec.securityContext).toMatchObject({
      runAsGroup: 1000,
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" }
    })
    const containers = Object.fromEntries(
      spec.template.spec.containers.map((container) => [container.name, container])
    )
    expect(containers.relay).toMatchObject({
      env: [
        {
          name: "CODEX_ROUTER_RELAY_TOKEN",
          valueFrom: {
            secretKeyRef: { key: "relay-token", name: "codex-router-egress" }
          }
        },
        { name: "HOST", value: "0.0.0.0" },
        { name: "PORT", value: "8788" }
      ],
      image:
        "ghcr.io/akua-dev/codex-router-relay@sha256:83d6a388dc003cd50d3734be96bf79274f36fc061fff530c24431a2e66a0fd17",
      securityContext: {
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
        readOnlyRootFilesystem: true
      }
    })
    expect(containers.tunnel).toMatchObject({
      args: [
        "tunnel",
        "--no-autoupdate",
        "--protocol",
        "http2",
        "run",
        "--token",
        "$(TUNNEL_TOKEN)"
      ],
      env: [
        {
          name: "TUNNEL_TOKEN",
          valueFrom: {
            secretKeyRef: { key: "tunnel-token", name: "codex-router-egress" }
          }
        }
      ],
      image:
        "cloudflare/cloudflared@sha256:a5b5e6fd9a372f054b9a843c219bfbcdceb54691605312a8b1ee72978bdf1aa1"
    })
    const networkPolicy = resource(resources, "NetworkPolicy", "codex-router-egress")
    expect(networkPolicy.spec).toMatchObject({
      egress: [
        {
          ports: [
            { port: 53, protocol: "TCP" },
            { port: 53, protocol: "UDP" }
          ]
        },
        {
          ports: [
            { port: 443, protocol: "TCP" },
            { port: 7844, protocol: "TCP" }
          ]
        }
      ],
      ingress: [],
      policyTypes: ["Ingress", "Egress"]
    })
    expect(
      JSON.stringify((networkPolicy.spec as { readonly egress: unknown }).egress)
    ).not.toContain("kube-system")
    expect(resources.some(({ kind }) => ["Ingress", "Secret", "Service"].includes(kind))).toBe(
      false
    )
  })
})
