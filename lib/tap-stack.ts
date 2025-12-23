/**
 * Main CDK Stack for Serverless Payment Webhook System
 *
 * This stack serves as the top-level container that orchestrates
 * the payment webhook infrastructure components.
 *
 * Originally created by Rahul Ladumor / InfraTales
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { PaymentWebhookStack } from './payment-webhook-stack';

interface TapStackProps extends cdk.StackProps {
  environmentSuffix?: string;
}

export class TapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: TapStackProps) {
    super(scope, id, props);

    const environmentSuffix =
      props?.environmentSuffix ||
      this.node.tryGetContext('environmentSuffix') ||
      'dev';

    // Instantiate the payment webhook stack
    new PaymentWebhookStack(this, 'PaymentWebhookStack', {
      environmentSuffix: environmentSuffix,
    });
  }
}
