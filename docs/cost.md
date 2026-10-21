# Cost

These are monthly costs in us-east-1, before the AWS Free Tier. We checked every price against the AWS Price List API on 2026-10-15, and the Lambda durations below are assumptions, not measurements.

## Assumptions

- Each event is one webhook. Bodies are under 1 KB, so every DynamoDB write is 1 write request unit.
- Both functions use 256 MB on arm64. We assumed 100 ms per receiver call and 200 ms per processor call, with one event per processor call (the worst case; batches make it cheaper). Measure your own numbers after a deploy.
- Each event costs 3 SQS requests (send, receive, delete) and 3 DynamoDB writes (claim, payment update, complete).
- About 1 KB of logs per event.

## The numbers

| Item | Price | 10,000 events | 1 million events |
|---|---|---|---|
| API Gateway HTTP API | $1.00 per million requests | $0.01 | $1.00 |
| Lambda (both functions) | $0.20 per million requests + $0.0000133334 per GB-second | $0.01 | $1.40 |
| SQS standard | $0.40 per million requests | $0.01 | $1.20 |
| DynamoDB on-demand writes | $0.625 per million write units | $0.02 | $1.88 |
| EventBridge custom events | $1.00 per million | $0.01 | $1.00 |
| Secrets Manager | $0.40 per secret + $0.05 per 10,000 calls | $0.45 | $0.49 |
| CloudWatch alarms (4) | $0.10 each | $0.40 | $0.40 |
| CloudWatch Logs | $0.50 per GB | $0.01 | $0.51 |
| **Total** | | **about $0.92** | **about $7.90** |

DynamoDB storage, point-in-time recovery and SNS round to zero at these volumes. Event IDs expire after 30 days, so the `ProcessedEvents` table stays small.

With the Free Tier (1 million Lambda requests, 1 million SQS requests, 10 alarms), the 10,000 event month costs about the price of the secret.

## What version 1 cost

Version 1 ran the functions in a VPC with one NAT Gateway. A NAT Gateway costs $0.045 an hour, which is about $32.85 a month before any traffic, plus $0.045 per GB processed. That is four times the 1 million event bill above, for a network path nothing needed.

## Things that change the bill

- **You pay for failed conditional writes.** Every duplicate costs one write unit for the claim that fails. That's cheap, but a provider replaying a big backlog shows up here.
- **A REST API instead of an HTTP API** costs $3.50 per million requests instead of $1.00. You'd switch only to attach AWS WAF.
- **A customer managed KMS key** adds $1 a month plus request charges.

## Sources

See `sources/aws-facts.md` in the article workspace, or the pricing pages:

- https://aws.amazon.com/api-gateway/pricing/
- https://aws.amazon.com/lambda/pricing/
- https://aws.amazon.com/sqs/pricing/
- https://aws.amazon.com/dynamodb/pricing/on-demand/
- https://aws.amazon.com/eventbridge/pricing/
- https://aws.amazon.com/secrets-manager/pricing/
- https://aws.amazon.com/cloudwatch/pricing/
- https://aws.amazon.com/vpc/pricing/
