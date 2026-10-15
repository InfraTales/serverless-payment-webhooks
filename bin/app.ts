#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { PaymentWebhooksStack } from '../lib/payment-webhooks-stack';

const app = new cdk.App();

new PaymentWebhooksStack(app, 'PaymentWebhooks', {
  alertEmail: app.node.tryGetContext('alertEmail'),
  env: { region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

// Fail synth on any unsuppressed AWS Solutions finding.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
