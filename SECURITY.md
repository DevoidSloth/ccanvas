# Security Policy

## Supported versions

ccanvas is pre-1.0 and under active development. Security fixes are applied to
the latest `main` and the most recent tagged release.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report them privately using GitHub's
[private vulnerability reporting](https://github.com/DevoidSloth/ccanvas/security/advisories/new)
("Report a vulnerability" under the repository's **Security** tab).

When reporting, please include:

- A description of the vulnerability and its impact
- Steps to reproduce, or a proof of concept
- The affected component (web app, Tauri desktop app, or the `server/` PTY backend)
- Any suggested remediation, if you have one

You can expect an initial acknowledgement within a few days. We will keep you
informed as we work on a fix and will credit you in the release notes unless you
prefer to remain anonymous.

## Security model — what to keep in mind

ccanvas is, by design, a tool that **spawns real shells and runs commands on your
machine**:

- Terminal and agent widgets run a real PTY in your canvas's working directory
  (in-process in the desktop app, or via the `server/pty-server.mjs` backend in
  the browser).
- The web-mode backend binds to `127.0.0.1:7531` and exposes shell + filesystem
  access to local clients. **Do not expose this port to untrusted networks.**
- `.ccnvs` workspace files describe widgets and layout. Treat workspace files
  from untrusted sources with the same caution you would any project you clone
  and run.

Because of this, the most impactful issues are ones that would let a remote
page, a malicious `.ccnvs` file, or another local user execute commands or read
files outside the intended working directory. Reports in those areas are
especially appreciated.
