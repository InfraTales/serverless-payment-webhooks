// Lambda sets these before the handler module loads, so the tests must too.
Object.assign(process.env, {
  QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/webhooks',
  SIGNING_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:signing',
  EVENTS_TABLE: 'processed-events',
  PAYMENTS_TABLE: 'payments',
  EVENT_BUS_NAME: 'payment-events',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});
