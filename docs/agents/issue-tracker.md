# GitHub Issues

Track issues and specs in `amemiya02/MINT`. Run `gh` from the MINT checkout.
Before filing the first issue in a session, verify the target with
`gh repo view --json nameWithOwner`.

- Publish a ticket with `gh issue create --title "..." --body-file <file>`.
- Fetch a ticket with `gh issue view <number> --json number,title,body,labels,comments`.
- Find open tickets with `gh issue list --state open`. Use `--label` to filter by triage role.
- Change labels with `gh issue edit <number> --add-label <label>` or `--remove-label <label>`.
- Record the reason for closing with `gh issue comment <number> --body-file <file>`,
  then close the issue with `gh issue close <number>`.

Link child tickets as GitHub sub-issues and record blockers as GitHub issue
dependencies. If those features are unavailable, put `Part of #<parent>` or
`Blocked by: #<blocker>` at the top of the child issue. A ticket is unblocked
when all its blockers are closed.

For `/wayfinder`, keep the map in one `wayfinder:map` issue and link its child
tickets in map order. Label each child `wayfinder:research`, `wayfinder:prototype`,
`wayfinder:grilling`, or `wayfinder:task`. Claim the first open, unassigned child
with no open blockers by assigning it to yourself. When finished, comment with
the result, close the child, and link the decision from the map.

**PRs as a request surface: no.**
