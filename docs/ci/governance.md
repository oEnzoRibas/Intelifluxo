# CI and pull request governance

Status: preparation; GitHub enforcement and check results have not been verified here. The repository is currently a public personal repository. Repository visibility does not imply that branch protection, required checks, reviews, or deployment controls are enabled.

## Stacked pull requests

Each PR in a stack targets its immediate dependency, not `main`, so its diff contains only that layer. Review and integrate from the bottom of the dependency stack upward. After a parent merges, retarget its child to the parent's target, update the child branch as needed, and recheck its diff and CI before merging. Do not merge a child ahead of its dependencies. Any history rewrite or push requires authorization under the project Git policy.

The local history shows PR #1 (event explorer) and PR #2 (integrated demo) merged into the history on which this CI branch is based. That does **not** establish that either has merged into `main`. The future integration order for the remaining branches has not been confirmed: the Lead must identify their actual dependency graph and PR targets, then integrate parent before child and this CI change at its agreed position. Do not infer the order from branch names or merge unrelated work into `main` without approval.

## Intended check names

The workflow owner supplied these exact names; their existence, results, and suitability as required checks must be observed on GitHub before enforcement:

- `Backend Quality`
- `Backend Tests`
- `Backend Integration`
- `Frontend Quality`
- `Frontend Tests`
- `Frontend Build`
- `CI Gate`

Treat `CI Gate` as a candidate aggregate, not proven coverage: inspect its workflow and observed behavior, including failures and skipped jobs, before deciding whether it alone can be required. No check is claimed active or required by this document.

## Safe activation of protection

1. A human owner approves the intended rules, bypasses, review policy, and target branch. Do not change GitHub settings as part of documentation or CI preparation.
2. Merge or otherwise make the approved workflows available as appropriate, and run representative PR checks on GitHub. Observe the exact context names and their source; verify success, failure, and relevant skipped-job behavior. Confirm `CI Gate` actually reflects the intended jobs.
3. The owner selects only observed, appropriate contexts as required checks, tests the rule on a representative PR, and confirms it blocks the intended failures without blocking legitimate changes. Record the outcome and any exceptions separately. Avoid requiring unobserved or renamed contexts that cannot report.
4. Reassess rules when workflow names, triggers, or repository governance change. No activation or validation has been performed by this document.

## Merge Queue and authorization

Merge Queue is not configured or confirmed available: the supplied GitHub GraphQL observation reported a null merge queue and owner type `User`. That observation alone does not prove a permanent product or plan limitation. Workflows are intended to remain `merge_group`-ready; their actual triggers and behavior must be verified once the workflow is available, and queue eligibility must be established from authoritative repository and plan capabilities before enabling or relying on it.

Human approval is required for destructive operations, deployments, production changes, and sensitive security changes. Branch protection, repository settings, secret provisioning, merging, pushing, and any deployment remain outside this documentation task; follow the project Git policy and obtain the relevant human authorization before making such changes.

## Evidence and open questions

- Local Git history at documentation time: `bd149c8` includes merges labeled PR #1 and PR #2; local `main` points to `d52eec5`.
- Check names, public personal-repository status, GraphQL observation, and `merge_group` intent were supplied by the task owner; they were not independently verified against GitHub here.
- Pending: Lead confirmation of stack dependencies, integration order, reviewers, rule owners, and the workflow owner's verification of aggregate and merge-group behavior.
