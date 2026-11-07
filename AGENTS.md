# intelifluxo — Agent Instructions

## Project Mission

Build EventMesh, an event processing platform focused on
reliability, observability, asynchronous processing and
intelligent operations.

The project is a portfolio-grade engineering system.
Technical decisions must prioritize correctness, clarity,
measurability and production-oriented engineering practices.

## Engineering Principles

- Prefer simple, explicit and maintainable designs.
- Avoid unnecessary abstractions and premature optimization.
- Define clear module and service boundaries.
- Document important architectural decisions using ADRs.
- Treat reliability as a first-class requirement.
- Make failures observable and recoverable.
- Design APIs and event contracts explicitly.
- Never claim a feature works without verification.

## AI Collaboration

- The EventMesh Lead coordinates the agents.
- Specialized agents must work within their responsibilities.
- Agents must communicate assumptions, dependencies and risks.
- Independent review is required for critical changes.
- Do not duplicate work across agents without coordination.
- Report uncertainty instead of inventing facts.

## Development Workflow

1. Understand the task and acceptance criteria.
2. Inspect the existing code before changing it.
3. Propose an implementation plan.
4. Implement in small, reviewable changes.
5. Run relevant tests and validations.
6. Document significant changes.
7. Report files changed, tests executed and remaining risks.

## Git Workflow

- Never commit directly to main.
- Use feature branches.
- Keep commits focused and descriptive.
- Use Pull Requests for integration.
- Do not force-push or rewrite shared history without approval.

## Security

- Never commit secrets, tokens, credentials or private keys.
- Never expose environment variables in logs.
- Validate external inputs.
- Apply least-privilege principles.
- Require human approval for destructive operations,
  production deployments and sensitive changes.

## Documentation

- Architecture decisions belong in docs/adr/.
- Product requirements belong in docs/product/.
- Architecture documentation belongs in docs/architecture/.
- Research and technical comparisons belong in docs/research/.