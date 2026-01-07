# I Deployed a Serverless Payment Webhook System — Here's What Happened

**tl;dr:** 441 seconds, 49 AWS resources, one API Gateway logging hiccup that cost me 20 minutes. But now I have a production-grade payment webhook processor.

---

## The Problem I Was Trying to Solve

Every fintech product I've worked on has the same headache: payment webhooks. Stripe sends them. PayPal sends them. Your bank sends them. And if you miss one, someone doesn't get their money.

I needed infrastructure that could:

- **Never drop a webhook** — even during traffic spikes
- **Archive everything** — compliance requires 7-year retention
- **Process asynchronously** — don't block the response
- **Alert on high-value transactions** — anything over $10k needs human eyes
- **Cost almost nothing at low volume** — I'm not processing millions yet

Serverless was the obvious choice. But "serverless" doesn't mean "no infrastructure" — it means *different* infrastructure.

---

## How It All Fits Together

```
┌─────────────────────┐
│   Payment Provider  │ (Stripe, PayPal, etc.)
└─────────┬───────────┘
          │ HTTPS POST /webhook
          ▼
┌─────────────────────┐
│    API Gateway      │ → CloudWatch Logs
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐     ┌─────────────────┐
│  Webhook Receiver   │────▶│    DynamoDB     │ (payment events)
│     Lambda          │────▶│    S3 Bucket    │ (raw archive)
└─────────┬───────────┘     └─────────────────┘
          │
          ▼
┌─────────────────────┐
│    EventBridge      │
│    Custom Bus       │
└─────────┬───────────┘
          │
    ┌─────┴─────┐
    ▼           ▼
┌────────┐  ┌────────┐
│ High   │  │Standard│
│ Value  │  │Payment │
│ Rule   │  │ Rule   │
└───┬────┘  └───┬────┘
    │           │
    ▼           ▼
┌─────────────────────┐
│  Notification       │
│  Handler Lambda     │────▶ SNS → Email/Slack
└─────────────────────┘
```

### Key Design Decisions

**VPC with Private Subnets** — All Lambdas run in private subnets. Not strictly necessary, but it's what compliance auditors want to see.

**KMS Customer-Managed Key** — Everything encrypted with a single key. Rotation enabled automatically.

**DynamoDB Pay-Per-Request** — I'm not going to guess at capacity. Let AWS handle it.

**EventBridge over SQS** — Content-based routing means I can add new rules without changing code.

---

## Why I Went with CDK

I've used Terraform, CloudFormation, Pulumi. For AWS-only projects, CDK wins:

- **Type safety** — TypeScript catches my mistakes before deploy
- **IDE support** — Autocomplete for every AWS property
- **Abstractions** — `new lambda.Function()` beats 40 lines of CloudFormation

The downside? CDK generates verbose CloudFormation. This stack produced a 91KB template. But I never have to read it.

---

## The Actual Deployment

**Started:** January 7, 2026, 8:52 PM UTC
**Region:** us-west-2
**Account:** 381491823598

### Pre-flight

```
✓ Node.js:    v22.17.0
✓ AWS CLI:    2.29.0
✓ CDK:        2.1100+
✓ Credentials configured
```

### CDK Synth

```
$ npx cdk synth --context environmentSuffix=dev
⏱ Template generated: 91KB
```

### Deploy (Attempt 1)

```
$ npx cdk deploy --all
❌ CREATE_FAILED | AWS::ApiGateway::Stage
   "CloudWatch Logs role ARN must be set in account settings"
```

Well, that's annoying.

---

## Where Things Went Wrong

### The API Gateway Logging Gotcha

API Gateway can log to CloudWatch, but it needs an IAM role at the *account level*, not the stack level. This is the kind of thing that works in one account and fails in another.

**The fix:**

```bash
# Create the role
aws iam create-role \
    --role-name APIGatewayCloudWatchLogsRole \
    --assume-role-policy-document file://trust-policy.json

# Attach the policy
aws iam attach-role-policy \
    --role-name APIGatewayCloudWatchLogsRole \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs

# Configure the account
aws apigateway update-account \
    --patch-operations op=replace,path=/cloudwatchRoleArn,value=$ROLE_ARN
```

**Time lost:** 15 minutes (plus the 20 minutes for the failed deploy to rollback).

### Deploy (Attempt 2)

```
$ npx cdk deploy --all
✅ TapStackdev
   Deployment time: 414 seconds
   Resources created: 76
```

---

## What This Actually Costs

Based on the resources deployed:

| Service | Estimated Monthly Cost |
|---------|------------------------|
| API Gateway | $3.50 per million requests |
| Lambda (3 functions) | ~$5 (pay per invocation) |
| DynamoDB | ~$2 (on-demand) |
| S3 Archive | ~$0.50 |
| NAT Gateway | ~$32 (this hurts) |
| EventBridge | ~$1 |
| **Total** | **~$44/month at low volume** |

The NAT Gateway is the killer. At $0.045/hour, it adds up even when you're processing zero webhooks. For a production system, I'd consider VPC endpoints or moving Lambdas outside VPC.

---

## Did It Work?

### API Endpoint Test

```bash
$ curl -X POST https://rny2y7n4qh.execute-api.us-west-2.amazonaws.com/prod/webhook \
    -H "Content-Type: application/json" \
    -d '{"type":"payment.completed","amount":150.00,"paymentId":"test-123"}'

{"message":"Webhook received","paymentId":"test-123","timestamp":1767802206635}
```

**Response time:** 280ms

### Resources Verified

- ✅ 49 resources tagged with `created_by=infra-agent`
- ✅ DynamoDB table created: `payment-events-dev`
- ✅ S3 bucket created: `webhook-archive-dev`
- ✅ EventBridge bus: `payment-events-dev`
- ✅ CloudWatch dashboard active

---

## What I Learned

1. **API Gateway account-level settings bite everyone once.** Now I know to check this first.

2. **NAT Gateway costs add up fast.** For a webhook system that might be idle most of the time, this is significant.

3. **EventBridge is underrated.** Content-based routing with zero glue code is exactly what I wanted.

4. **CDK abstractions are worth the verbosity.** I didn't have to think about IAM policies for Lambda → DynamoDB. CDK handled it.

5. **Always add removal policies.** The stack has `RemovalPolicy.DESTROY` on everything. Important for dev/test stacks you'll tear down.

---

## Cleanup

```bash
$ npx cdk destroy --all --force
✅ Stack destroyed in ~2 minutes
```

Always verify no resources remain:

```bash
aws resourcegroupstaggingapi get-resources \
    --tag-filters Key=created_by,Values=infra-agent \
    --query 'ResourceTagMappingList[].ResourceARN'
```

---

**Repository:** [github.com/InfraTales/serverless-payment-webhooks](https://github.com/InfraTales/serverless-payment-webhooks)

Questions? Found something I got wrong? Drop a comment — I actually read them.

*— Rahul*
