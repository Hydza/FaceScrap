# Security Policy

**Maintainer:** Hydza

## Supported versions

Security fixes are prepared for the current default branch and, when applicable, the latest
published release. Older builds may not receive a backport. Reproduce a report against the newest
available version before submitting it.

## Reporting a vulnerability

Do not disclose an unpatched vulnerability in a public issue. Use the repository's
[private vulnerability report](https://github.com/Hydza/FaceScrap/security/advisories/new) when
that option is available. If it is unavailable, open a public issue that requests a private
contact channel without including technical details, secrets, personal information, or a working
exploit.

Include:

- A concise description and the affected FaceScrap version or commit.
- Reproduction steps and the security impact.
- The affected browser and operating-system versions.
- A minimal proof of concept, with private data and signed resource values removed.
- Any suggested mitigation or disclosure constraints.

Hydza will review the report, request missing details when needed, and coordinate disclosure after
a fix or mitigation is available. Response and release timing depends on severity,
reproducibility, and maintainer availability.

## Scope

Relevant reports include permission-boundary bypasses, unsafe handling of page-controlled data,
downloads from an unintended host, exposure of stored information, script injection, or a defect
that materially weakens the extension's security controls. General bugs, compatibility problems,
and feature requests belong in the public issue forms unless they have a concrete security impact.

Only test with accounts, content, and systems you are authorized to use. Do not access another
person's information, interrupt services, or retain data beyond what is needed to demonstrate the
issue.
