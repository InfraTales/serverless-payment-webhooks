# Runbook

What to do when an alarm fires. All three alarms go to the `Alerts` SNS topic.

## DlqNotEmpty

A message failed 5 times and moved to the dead-letter queue. The provider already got a 200, so it won't send this event again. The event waits in the DLQ for 14 days.

1. Find the cause in the processor logs. Search for `record failed`. Each line has the SQS `messageId` and the error.
2. Fix the cause: a code bug, a throttled table, or a missing permission.
3. Move the messages back to the main queue. In the SQS console, open the DLQ and choose **Start DLQ redrive**. You can also use the CLI:

```bash
aws sqs start-message-move-task \
  --source-arn <DLQ ARN> \
  --destination-arn <WebhookQueue ARN>
```

Redriving is safe. If an event was finished before it failed (for example, it failed on a later step), the idempotency table marks it COMPLETED and the processor skips it.

## QueueFallingBehind

The oldest message has waited more than 5 minutes for 5 minutes in a row. Events are arriving faster than the processor finishes them.

- Check processor errors and duration. A slow table or EventBridge throttling can cause this.
- If the load is real, raise `maxConcurrency` on the event source in the stack (it's 5).
- Messages stay in the queue for 4 days, so nothing is lost while you look.

## SignatureRejections

More than 20 requests got a 4xx in 5 minutes.

- **Right after a secret rotation:** the secret in Secrets Manager doesn't match the provider. Check both `current` and `previous`. Remember the 5 minute cache.
- **No rotation:** look at the access logs for source IPs. Someone may be probing the URL. The signature check blocks them, and the stage throttle limits the cost.
- **Many 400s, not 401s:** the provider changed its payload shape. Look at `lambda/shared/event.ts`.

## Checking one event

To see whether an event was processed, look it up by ID in the `ProcessedEvents` table:

```bash
aws dynamodb get-item --table-name <EventsTableName> \
  --key '{"eventId": {"S": "evt_123"}}'
```

| `status` | Meaning |
|---|---|
| (no item) | Never received, or the row expired after the retention period |
| `IN_PROGRESS` | A worker is processing it, or one died and the lock hasn't expired yet (2 minutes) |
| `COMPLETED` | Done. Any further delivery of this ID is skipped |
