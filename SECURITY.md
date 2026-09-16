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

## Handling notes (what the product already enforces)

- API keys and Plow credentials are never written to the repository,
  the npm tarball, logs, transcripts, exports or model context. The
  `openai` CLI preset reads `LATTICE_API_KEY` from the environment; UI
  session keys live in server memory only.
- The local usage export refuses to write when secret-shaped data is
  detected.
- The optional Agent Index reporting path publishes per-day, per-model
  token counts only, and only after explicit opt-in.
