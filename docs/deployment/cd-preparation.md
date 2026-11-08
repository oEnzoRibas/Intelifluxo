# Continuous delivery preparation

Status: planning only. No deployment, GitHub environment, secret, release pipeline, or rollback procedure is established or verified by this document. A human must authorize deployments and production changes; the responsible owners must approve the deployment design and security controls first.

## Candidate environment and secret names

These are placeholders for discussion, not existing or approved configuration. Names only; never put values in documentation or source control.

| Kind | Placeholder name |
| --- | --- |
| Environment | `staging` |
| Environment | `production` |
| Secret | `DEPLOY_CREDENTIAL` |

Owners must choose actual environments, credential mechanisms, least-privilege permissions, approvals, and secret names. Prefer short-lived credentials where supported; do not provision anything until authorized.

## Artifact and version strategy

Proposed approach, pending engineering approval: build immutable, identifiable release artifacts from an approved commit; record the commit SHA, artifact digest, build/run identity, and release version together. Promote the same verified artifact between environments rather than rebuilding it. Define artifact retention, provenance, access controls, and compatibility checks before implementation. No current artifact format, registry, version scheme, or promotion mechanism is established here.

## Rollback preparation

Before any deployment, owners should document how to identify and redeploy the last known-good artifact, authorize rollback, validate service health, and communicate the outcome. Assess database and event/schema compatibility separately: reverting an application artifact may not reverse migrations, emitted events, or external side effects. Define recovery or forward-fix steps where rollback is unsafe. No rollback commands or recovery guarantees have been tested.

## Evidence and outstanding decisions

This is a proposed plan based on the task's CD preparation request, not evidence of an implemented delivery system. Deployment targets, service owners, release and retention policies, environment protections, credentials, health checks, and rollback compatibility remain to be specified and independently reviewed.
