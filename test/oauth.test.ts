// test/oauth.test.ts
import { expect, test } from "vitest"
import { finishProviderLogin, listOAuthProviders, selectOAuthMethod, startProviderLogin, waitForOAuthCompletion } from "../src/oauth.ts"
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

test("selectOAuthMethod prefers a headless/code method over the browser one", () => {
  expect(selectOAuthMethod([
    { type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
    { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
  ])).toBe(1)
  expect(selectOAuthMethod([{ type: "oauth", label: "Claude Pro" }])).toBe(0)
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

test("startProviderLogin uses the headless method for an openai-like pair", async () => {
  const { client, calls } = fakeClient({ authResponse: { openai: [
    { type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
    { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
  ] } })
  const login = await startProviderLogin({ client, log: () => {} }, "openai")
  expect(login.method).toBe(1)
  expect(calls).toEqual([{ op: "authorize", o: { path: { id: "openai" }, body: { method: 1 } } }])
})

test("startProviderLogin recognizes auto-method flows", async () => {
  const { client } = fakeClient({ authorizeResponse: { data: { url: "https://example.test/auth", method: "auto", instructions: "A browser window opened" } } })
  const login = await startProviderLogin({ client, log: () => {} }, "anthropic")
  expect(login.flow).toBe("auto")
})

test("listOAuthProviders returns sorted ids that expose an oauth method", () => {
  expect(listOAuthProviders(undefined)).toEqual([])
  expect(listOAuthProviders({
    anthropic: [{ type: "api", label: "API key" }],
    openai: [{ type: "oauth", label: "ChatGPT" }],
    github: [{ type: "api", label: "PAT" }, { type: "oauth", label: "GitHub" }],
  })).toEqual(["github", "openai"])
})

test("startProviderLogin errors when the provider has no oauth method", async () => {
  const { client } = fakeClient({ authResponse: { anthropic: [{ type: "api", label: "API key" }] } })
  await expect(startProviderLogin({ client, log: () => {} }, "anthropic")).rejects.toThrow("no oauth method for anthropic")
})

test("startProviderLogin lists the available oauth providers when the provider has none", async () => {
  const { client } = fakeClient({ authResponse: {
    anthropic: [{ type: "api", label: "API key" }],
    openai: [{ type: "oauth", label: "ChatGPT" }],
    github: [{ type: "oauth", label: "GitHub" }],
  } })
  await expect(startProviderLogin({ client, log: () => {} }, "anthropic"))
    .rejects.toThrow("no oauth method for anthropic; oauth providers: github, openai")
})

test("startProviderLogin reports when no provider exposes oauth", async () => {
  const { client } = fakeClient({ authResponse: { anthropic: [{ type: "api", label: "API key" }] } })
  await expect(startProviderLogin({ client, log: () => {} }, "anthropic"))
    .rejects.toThrow("no oauth method for anthropic; no providers expose OAuth")
})

test("startProviderLogin rejects an oauth method that needs extra setup prompts", async () => {
  const { client } = fakeClient({ authResponse: {
    anthropic: [{ type: "oauth", label: "Pro", prompts: [{ type: "text", key: "k", message: "m" }] }],
  } })
  await expect(startProviderLogin({ client, log: () => {} }, "anthropic"))
    .rejects.toThrow("provider anthropic OAuth needs extra setup steps; use /attach and run `opencode auth login`")
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

test("waitForOAuthCompletion resolves once the provider's oauth method disappears", async () => {
  let calls = 0
  const client: OAuthClient = {
    provider: {
      auth: async () => (++calls < 3 ? { anthropic: [{ type: "oauth", label: "Claude Pro" }] } : {}),
      oauth: { authorize: async () => ({}), callback: async () => ({}) },
    },
  }
  await expect(waitForOAuthCompletion(client, "anthropic", { timeoutMs: 2000, intervalMs: 5 })).resolves.toBe(true)
  expect(calls).toBe(3)
})

test("waitForOAuthCompletion resolves when the provider keeps a non-oauth method", async () => {
  let calls = 0
  const client: OAuthClient = {
    provider: {
      auth: async () => { calls += 1; return { anthropic: [{ type: "api", label: "API key" }] } },
      oauth: { authorize: async () => ({}), callback: async () => ({}) },
    },
  }
  await expect(waitForOAuthCompletion(client, "anthropic", { timeoutMs: 2000, intervalMs: 5 })).resolves.toBe(true)
  expect(calls).toBe(1)
})

test("waitForOAuthCompletion returns false when the oauth method never clears", async () => {
  let calls = 0
  const client: OAuthClient = {
    provider: {
      auth: async () => { calls += 1; return { anthropic: [{ type: "oauth", label: "Claude Pro" }] } },
      oauth: { authorize: async () => ({}), callback: async () => ({}) },
    },
  }
  await expect(waitForOAuthCompletion(client, "anthropic", { timeoutMs: 30, intervalMs: 5 })).resolves.toBe(false)
  expect(calls).toBeGreaterThanOrEqual(1)
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
