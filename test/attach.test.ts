// test/attach.test.ts
import { expect, test } from "vitest"
import { attachCommand, attachReply, sessionIdReply } from "../src/attach.ts"

test("attachCommand renders the exact sbx exec opencode attach line", () => {
  expect(attachCommand({ sandboxName: "celly-demo" }, "ses_abc"))
    .toBe("sbx exec -it celly-demo bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s ses_abc'")
})

test("sessionIdReply shows the bare session id and the command behind a spoiler", () => {
  expect(sessionIdReply({ sandboxName: "celly-demo" }, "ses_abc"))
    .toBe("`ses_abc`\n||sbx exec -it celly-demo bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s ses_abc'||")
})

test("attachReply wraps the exact command in a code block", () => {
  expect(attachReply({ sandboxName: "celly-demo" }, "ses_abc"))
    .toBe("```\nsbx exec -it celly-demo bash -lc 'set -a; . ~/.config/celly/opencode.env; set +a; exec opencode attach http://127.0.0.1:4096 -s ses_abc'\n```")
})
