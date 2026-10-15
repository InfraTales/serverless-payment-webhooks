#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { PaymentWebhooksStack } from '../lib/payment-webhooks-stack';

const app = new cdk.App();

// Optional: cdk deploy -c alertEmail=you@example.com
const alertEmail: unknown = app.node.tryGetContext('alertEmail');
if (alertEmail !== undefined && (typeof alertEmail !== 'string' || !alertEmail.includes('@'))) {
  throw new Error(`alertEmail must be an email address, got ${JSON.stringify(alertEmail)}`);
}

new PaymentWebhooksStack(app, 'PaymentWebhooks', {
  alertEmail,
  env: { region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

// Fail synth on any unsuppressed AWS Solutions finding.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
