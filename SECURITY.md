# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 2.x     | Yes       |
| 1.x     | No. Version 1 accepted unsigned webhooks. Upgrade. |

## Reporting a vulnerability

Please don't report security problems in public GitHub issues. Email security@infratales.com instead. You should hear back within 48 hours. If you don't, send a follow-up.

It helps to include:

- the type of issue (for example, a signature bypass or data exposure)
- the file and line, or the commit
- steps to reproduce, and a proof of concept if you have one
- what an attacker could do with it

We follow responsible disclosure. We confirm the report, fix it, publish an advisory, and give users time to upgrade before full details go public (usually 90 days).

## How this stack protects itself

The short version is below. [docs/security.md](docs/security.md) has the details and the reasons behind each choice.

- Every webhook is checked with HMAC-SHA256 over the raw body. Requests older than 5 minutes are rejected, which stops replays.
- The signing secret lives in AWS Secrets Manager. The receiver accepts a current and a previous secret, so you can rotate without dropping events.
- The receiver can only read that one secret and send to one queue. It can't touch the database.
- Each event ID is processed once, even when the provider or SQS delivers it more than once.
- Queues reject non-TLS requests. Tables and queues are encrypted at rest with AWS managed keys.

---

Originally created by Rahul Ladumor / InfraTales
