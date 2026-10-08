# Security policy

## Supported versions

Lattice `0.0.0` is a prerelease. Security fixes apply to the current
development HEAD until a stable release line is declared.

## Reporting a vulnerability

Report vulnerabilities privately to the repository maintainers (open a
private security advisory on GitHub once the repository is public, or
contact the maintainers directly). Do not open a public issue with exploit
details.

Please include: affected version/commit, steps to reproduce, and the
impact you observed. We will acknowledge receipt, assess the report, and
coordinate a fix before any public disclosure.

## Security boundaries and credential handling

Lattice currently uses a `local-trusted` execution model. Tools run with
the local user's privileges; workspace checks, environment filtering and
renderer isolation do not provide an OS sandbox for arbitrary commands.
Review the project and requested actions before running a task.

- UI provider keys live in backend session memory and are scoped to the
  provider and normalized endpoint. The `openai` CLI preset can read an
  explicitly supplied `LATTICE_API_KEY`. Product configuration does not
  persist provider keys; there is no durable credential store.
- Credential-bearing requests require HTTPS except for loopback fixtures.
  The compatible adapter refuses redirects and withholds responses that
  reflect the configured key in returned text or tool arguments. These
  controls are targeted protections, not a universal secret detector.
- Child commands receive a filtered environment. Files supplied by the
  user and explicit command arguments can still contain sensitive data;
  do not put secrets in task text, project files, logs or exports.
- Desktop session bootstrap uses the private main/backend channel. HTTP
  requests check the bound Host and Origin, and authenticated API access
  uses an ephemeral HttpOnly, SameSite=Strict cookie. A malicious process
  already running as the user is outside this protection boundary.
- The local usage export refuses data matching its secret-shaped patterns.
  Pattern checks and regression tests do not prove that every possible
  credential or sensitive value will be detected.

Keep credentials, browser profiles, databases and local validation evidence
out of source commits and distribution packages. Report a suspected leak
through the private reporting route above.
