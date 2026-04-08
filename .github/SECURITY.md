# Security Policy

DB-MCP is designed to expose controlled, read-only inspection capabilities. Security changes should preserve that model.

## Supported behavior

- Read-only SQL access only.
- Allowlisted GitHub repository access only.
- Bounded result sizes, timeouts, and cache payload sizes.
- Explicit schema restrictions where configured.

## Report security issues

If you find a vulnerability, report it through the repository maintainer’s normal private disclosure process.

Include:

- the affected route or tool,
- the database or GitHub path involved,
- the exact request shape,
- and the observed behavior.

## What not to do

- Do not add write-capable SQL paths without a strong documented reason.
- Do not weaken allowlist checks for GitHub repositories.
- Do not remove timeout or payload limits unless the change is clearly justified and reviewed.
