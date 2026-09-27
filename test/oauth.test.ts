// test/oauth.test.ts
import { expect, test } from "vitest"
import { finishProviderLogin, selectOAuthMethod, startProviderLogin } from "../src/oauth.ts"
import type { OAuthClient } from "../src/oauth.ts"

function fakeClient(over: any = {}) {
  const calls: any[] = []
  const client: OAuthClient = {
    provider: {
      auth: async () => over.authResponse ?? { anthropic: [{ type: "oauth", label: "Claude Pro" }, { type: "api", label: "API key" }] },
      oauth: {
        authorize: async (o) => { calls.push({ op: "authorize", o }); return over.authorizeResponse ?? { data: { url: "https://example.test/auth", method: "code", instructions: "Paste the code" } } },
        callback: async (o) => { calls.push({ op: "callback", o }); return over.callbackResponse ?? { data: true } },
      },
    },
  }
  return { client, calls }
}

test("selectOAuthMethod returns the oauth method index or -1", () => {
  expect(selectOAuthMethod([{ type: "api", label: "API key" }, { type: "oauth", label: "Pro" }])).toBe(1)
  expect(selectOAuthMethod([{ type: "api", label: "API key" }])).toBe(-1)
  expect(selectOAuthMethod(undefined)).toBe(-1)
})

test("startProviderLogin picks the oauth method and returns the authorization", async () => {
  const { client, calls } = fakeClient()
  const login = await startProviderLogin({ client, log: () => {} }, "anthropic")
  expect(login).toEqual({ providerId: "anthropic", method: 0, url: "https://example.test/auth", flow: "code", instructions: "Paste the code" })
  expect(calls).toEqual([{ op: "authorize", o: { path: { id: "anthropic" }, body: { method: 0 } } }])
})

test("startProviderLogin recognizes auto-method flows", async () => {
  const { client } = fakeClient({ authorizeResponse: { data: { url: "https://example.test/auth", method: "auto", instructions: "A browser window opened" } } })
  const login = await startProviderLogin({ client, log: () => {} }, "anthropic")
  expect(login.flow).toBe("auto")
})

test("startProviderLogin errors when the provider has no oauth method", async () => {
  const { client } = fakeClient({ authResponse: { anthropic: [{ type: "api", label: "API key" }] } })
  await expect(startProviderLogin({ client, log: () => {} }, "anthropic")).rejects.toThrow("no oauth method for anthropic")
})

test("finishProviderLogin exchanges the code and reports success", async () => {
  const { client, calls } = fakeClient()
  await finishProviderLogin({ client, log: () => {} }, "anthropic", "the-code")
  expect(calls).toEqual([
    { op: "callback", o: { path: { id: "anthropic" }, body: { method: 0, code: "the-code" } } },
  ])
})

test("finishProviderLogin errors when the callback reports failure", async () => {
  const { client } = fakeClient({ callbackResponse: { data: false } })
  await expect(finishProviderLogin({ client, log: () => {} }, "anthropic", "the-code")).rejects.toThrow("oauth callback for anthropic failed")
})

test("finishProviderLogin errors when the provider has no oauth method", async () => {
  const { client } = fakeClient({ authResponse: { anthropic: [{ type: "api", label: "API key" }] } })
  await expect(finishProviderLogin({ client, log: () => {} }, "anthropic", "the-code")).rejects.toThrow("no oauth method for anthropic")
})

test("provider login never logs credentials", async () => {
  const lines: string[] = []
  const log = (msg: string, fields?: Record<string, unknown>) => { lines.push(JSON.stringify({ msg, fields })) }
  const { client } = fakeClient()
  await startProviderLogin({ client, log }, "anthropic")
  await finishProviderLogin({ client, log }, "anthropic", "FAKE_CODE")
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.join("\n")).not.toMatch(/FAKE_(REFRESH|ACCESS)_TOKEN|FAKE_CODE/)
})
