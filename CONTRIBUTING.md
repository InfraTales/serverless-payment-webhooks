# Contributing

Thanks for helping. This repo shows how to process each payment webhook once on AWS. Every change has to keep that promise, and a test has to prove it.

## Setup

You need Node.js 22 or newer and npm. Docker is only needed for the DynamoDB tests.

```bash
npm ci
npm run check        # type check, lint, unit + flow + infra tests, synth with cdk-nag
```

To run the DynamoDB tests:

```bash
docker run -d --rm -p 8000:8000 amazon/dynamodb-local:3.3.2
DYNAMODB_ENDPOINT=http://localhost:8000 npm run test:int
```

You don't need an AWS account for either. You only need one for `npm run smoke` against a real deploy.

## Layout

| Path | What's there |
|---|---|
| `lambda/receiver.ts` | Signature check, validation, enqueue |
| `lambda/processor.ts` | Idempotent processing, ordering rule, publishing |
| `lambda/shared/` | Signature, idempotency store, event parsing, config |
| `lib/payment-webhooks-stack.ts` | The CDK stack |
| `test/unit`, `test/flow`, `test/infra` | Tests that run with `npm test` |
| `test/integration` | Condition expressions against DynamoDB Local |
| `scripts/smoke-test.ts` | Acts as the provider against a deployed stack |

## What a change needs

- **A test that fails without it.** For a bug, write the failing test first.
- **The fakes kept in step.** `test/fakes.ts` copies the rules of the DynamoDB conditions. If you change a condition, change the fake to match and add a case to `test/integration`, which checks the real one.
- **The timing rule kept.** Processor timeout < lock time < SQS visibility timeout. A test in `test/infra/stack.test.ts` enforces it.
- **A written reason for any cdk-nag acknowledgement.** Fix the finding if you can.
- **Docs updated** when behaviour changes: `README.md`, and `docs/` for security, alarms or cost.

## Pull requests

Branch from `main`, keep each pull request to one change, and say why in the description, not only what. CI must pass before merge.

Found a security problem? Don't open a public issue. [SECURITY.md](SECURITY.md) says where to send it.

---

Created by Rahul Ladumor / InfraTales
