## Summary

<!-- What does this change and why? -->

## Checklist

- [ ] `npm test` passes (tests mock `fetch`, no network calls)
- [ ] Read/write annotations are correct: read tools stay `readOnlyHint: true`; any state-changing tool sets `readOnlyHint: false` (and `destructiveHint: true` if it removes data)
- [ ] New list tools take a `limit`/`row_limit` and default it low (responses cost agents tokens)
- [ ] README tool table updated if tools were added or changed
- [ ] No `console.log` to stdout — diagnostics go to stderr only
