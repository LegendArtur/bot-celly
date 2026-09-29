---
"celly": patch
---

Log the cause when a pending approval or question is dropped without a decision (`run-ended`, `server-resolved`, `permission-replied`, `question-replied`, `question-rejected`, or `timeout`), with the thread, session, and request id. A later "this request is no longer active" click can now be traced to the request that was dropped.
