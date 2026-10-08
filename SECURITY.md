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
the local user's privileges; workspace checks and environment filtering do
not provide an OS sandbox for arbitrary commands.

- UI provider keys live in server session memory. The `openai` CLI preset
  can read an explicitly supplied `LATTICE_API_KEY`. Product configuration
  does not persist provider keys.
- Child commands receive a filtered environment. Files supplied by the
  user and explicit command arguments can still contain sensitive data;
  do not put secrets in task text, project files, logs or exports.
- The local usage export refuses data matching its secret-shaped patterns.
  Pattern checks and regression tests do not prove that every possible
  credential or sensitive value will be detected.

Keep credentials, browser profiles, databases and local validation evidence
out of source commits and distribution packages.
