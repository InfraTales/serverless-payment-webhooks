# Security notes

This page explains each security choice in the stack, and the ones we chose not to make.

## Who can call the endpoint

The webhook URL is public, because the payment provider has to reach it. Providers can't sign requests with AWS SigV4 or send a JWT, so API Gateway authorizers don't fit. Instead, the receiver checks a signature on every request before it does anything else.

For the body `{"id":"evt_1"}` and the secret `whsec_example`, the provider sends this header:

```text
X-Webhook-Signature: t=1760000000,v1=324793fc8eea6a5d3b2d921379e2ebd9720629dc5761240a0a3f26cddfe8960d
```

`v1` is HMAC-SHA256 of `"<t>.<raw body>"` with the shared secret. The receiver rejects the request when:

- the header is missing or malformed
- `t` is more than 5 minutes from now (a replayed request)
- no secret produces a matching signature

The comparison uses `crypto.timingSafeEqual`, so response timing doesn't reveal how close a guess was. A rejected caller gets the same `401 invalid signature` answer every time. The reason goes to the logs only.

## Why the raw body matters

The HMAC covers the exact bytes the provider sent. If you parse the JSON and serialize it again, spacing and key order change, and a valid request fails. The receiver checks the raw body and then queues that same raw body. There's a test for this.

## The signing secret

The secret is stored in AWS Secrets Manager as JSON:

```json
{ "current": "whsec_from_provider", "previous": "" }
```

To rotate it, set `previous` to the old value and `current` to the new one. Switch the provider over, wait a day, then clear `previous`. The receiver caches the secret for 5 minutes, so a change takes up to 5 minutes to apply.

After the first deploy, `current` holds a random value. Replace it with the provider's secret, or every request gets a 401.

## Least privilege

| Function | Can do | Can't do |
|---|---|---|
| Receiver | Read one secret, send to one queue | Read or write any table, publish events |
| Processor | Read and write the two tables, put events on one bus, consume one queue | Read the signing secret |

A bug in the receiver can't change payment state. The worst it can do is queue a bad message, and the processor validates every message again.

## Abuse limits

- Bodies over 64 KB are rejected before any crypto runs.
- The API stage is throttled to 50 requests per second with a burst of 100. Raise it if your provider sends more.
- The 4xx alarm fires on more than 20 rejections in 5 minutes. That usually means a bad secret after rotation, or someone probing the URL.

## What we chose not to add

- **AWS WAF.** HTTP APIs can't attach a web ACL. If you need WAF, put Amazon CloudFront in front, or switch to a REST API, which costs more per request.
- **A customer managed AWS KMS key.** Tables and queues use AWS managed encryption. The data is payment IDs, amounts and statuses, with no card numbers. A customer managed key adds a monthly fee and key-policy work. Add one if your compliance rules require it.
- **A VPC.** No function talks to anything private, so there's nothing for a VPC to protect, and leaving it out removes the NAT Gateway cost.
- **Provider IP allowlists.** Some providers publish IP ranges. The signature check already proves who sent the request, and IP lists go stale.

## cdk-nag

`cdk synth` runs the cdk-nag AWS Solutions pack and fails on any finding that isn't acknowledged. Each acknowledgement has a written reason in `lib/payment-webhooks-stack.ts`:

| Rule | Why it's acknowledged |
|---|---|
| APIG4 (no authorizer) | Providers can't use SigV4 or JWT. The HMAC check in the receiver does this job. |
| SMG4 (no automatic rotation) | The provider issues the secret, so rotation is manual, with current and previous slots. |
| IAM4 (AWS managed policy) | `AWSLambdaBasicExecutionRole` only allows writing logs. |
