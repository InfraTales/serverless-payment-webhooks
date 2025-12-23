/**
 * Payment Webhook Infrastructure Stack
 *
 * Complete serverless infrastructure for processing payment webhooks with
 * PCI compliance considerations. Includes API Gateway, Lambda functions,
 * DynamoDB, S3 archival, EventBridge routing, and CloudWatch monitoring.
 *
 * Key Features:
 * - Webhook signature validation
 * - Automatic payload archival to S3
 * - Event-driven processing pipeline
 * - High-value payment alerting
 * - Comprehensive monitoring and dashboards
 *
 * Originally created by Rahul Ladumor / InfraTales
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

interface PaymentWebhookStackProps {
  environmentSuffix: string;
}

export class PaymentWebhookStack extends Construct {
  constructor(scope: Construct, id: string, props: PaymentWebhookStackProps) {
    super(scope, id);

    const { environmentSuffix } = props;

    // KMS key for encryption - FIXED: Changed to DESTROY for CI/CD
    const encryptionKey = new kms.Key(this, 'EncryptionKey', {
      description: `KMS key for payment webhook system ${environmentSuffix}`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // VPC for Lambda functions
    const vpc = new ec2.Vpc(this, 'WebhookVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // DynamoDB table for payment events - FIXED: Changed to DESTROY
    const paymentTable = new dynamodb.Table(this, 'PaymentTable', {
      tableName: `payment-events-${environmentSuffix}`,
      partitionKey: { name: 'paymentId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // GSI for querying by payment provider
    paymentTable.addGlobalSecondaryIndex({
      indexName: 'ProviderTimestampIndex',
      partitionKey: { name: 'provider', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
    });

    // S3 bucket for webhook archives - FIXED: Changed to DESTROY + autoDeleteObjects
    const archiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
      bucketName: `webhook-archive-${environmentSuffix}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: encryptionKey,
      versioned: true,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // SQS queues for message delivery
    const processingQueue = new sqs.Queue(this, 'ProcessingQueue', {
      queueName: `processing-queue-${environmentSuffix}`,
      visibilityTimeout: cdk.Duration.seconds(180),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
    });

    const notificationQueue = new sqs.Queue(this, 'NotificationQueue', {
      queueName: `notification-queue-${environmentSuffix}`,
      visibilityTimeout: cdk.Duration.seconds(180),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
    });

    // SNS topic for alerts
    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `payment-alerts-${environmentSuffix}`,
      displayName: 'Payment Alert Notifications',
      masterKey: encryptionKey,
    });

    // EventBridge custom event bus
    const paymentEventBus = new events.EventBus(this, 'PaymentEventBus', {
      eventBusName: `payment-events-${environmentSuffix}`,
    });

    // Lambda execution role
    const lambdaRole = new iam.Role(this, 'LambdaExecutionRole', {
      roleName: `payment-webhook-lambda-role-${environmentSuffix}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole'
        ),
      ],
    });

    paymentTable.grantReadWriteData(lambdaRole);
    archiveBucket.grantReadWrite(lambdaRole);
    processingQueue.grantSendMessages(lambdaRole);
    processingQueue.grantConsumeMessages(lambdaRole);
    notificationQueue.grantSendMessages(lambdaRole);
    notificationQueue.grantConsumeMessages(lambdaRole);
    alertTopic.grantPublish(lambdaRole);
    encryptionKey.grantEncryptDecrypt(lambdaRole);

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [paymentEventBus.eventBusArn],
      })
    );

    // SSM Parameter for configuration
    const configParameter = new ssm.StringParameter(this, 'ConfigParameter', {
      parameterName: `/payment-webhook/${environmentSuffix}/config`,
      stringValue: JSON.stringify({
        maxRetries: 3,
        timeoutMs: 30000,
      }),
    });

    configParameter.grantRead(lambdaRole);

    // Lambda function 1: Webhook Receiver
    const webhookReceiver = new lambda.Function(this, 'WebhookReceiver', {
      functionName: `webhook-receiver-${environmentSuffix}`,
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lib/lambda/webhook-receiver'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      role: lambdaRole,
      vpc: vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: {
        PAYMENT_TABLE: paymentTable.tableName,
        ARCHIVE_BUCKET: archiveBucket.bucketName,
        PROCESSING_QUEUE: processingQueue.queueUrl,
        CONFIG_PARAM: configParameter.parameterName,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Lambda function 2: Event Processor
    const eventProcessor = new lambda.Function(this, 'EventProcessor', {
      functionName: `event-processor-${environmentSuffix}`,
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lib/lambda/event-processor'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      role: lambdaRole,
      vpc: vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: {
        PAYMENT_TABLE: paymentTable.tableName,
        EVENT_BUS: paymentEventBus.eventBusName,
        NOTIFICATION_QUEUE: notificationQueue.queueUrl,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    eventProcessor.addEventSource(
      new SqsEventSource(processingQueue, {
        batchSize: 10,
      })
    );

    // Lambda function 3: Notification Handler
    const notificationHandler = new lambda.Function(
      this,
      'NotificationHandler',
      {
        functionName: `notification-handler-${environmentSuffix}`,
        runtime: lambda.Runtime.NODEJS_18_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromAsset('lib/lambda/notification-handler'),
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        role: lambdaRole,
        vpc: vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        environment: {
          ALERT_TOPIC: alertTopic.topicArn,
          PAYMENT_TABLE: paymentTable.tableName,
        },
        logRetention: logs.RetentionDays.ONE_MONTH,
      }
    );

    notificationHandler.addEventSource(
      new SqsEventSource(notificationQueue, {
        batchSize: 10,
      })
    );

    // Lambda function URL for health check
    const healthCheckUrl = webhookReceiver.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // API Gateway REST API
    const api = new apigateway.RestApi(this, 'WebhookApi', {
      restApiName: `webhook-api-${environmentSuffix}`,
      description: 'Payment Webhook API',
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      },
    });

    const webhookResource = api.root.addResource('webhook');
    webhookResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(webhookReceiver)
    );

    // EventBridge rules for routing based on amount
    new events.Rule(this, 'HighValuePaymentRule', {
      ruleName: `high-value-payments-${environmentSuffix}`,
      eventBus: paymentEventBus,
      eventPattern: {
        source: ['payment.processor'],
        detailType: ['Payment Processed'],
        detail: {
          amount: [{ numeric: ['>', 10000] }],
        },
      },
      targets: [new targets.SnsTopic(alertTopic)],
    });

    const standardPaymentLogs = new logs.LogGroup(this, 'StandardPaymentLogs', {
      logGroupName: `/aws/events/standard-payments-${environmentSuffix}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new events.Rule(this, 'StandardPaymentRule', {
      ruleName: `standard-payments-${environmentSuffix}`,
      eventBus: paymentEventBus,
      eventPattern: {
        source: ['payment.processor'],
        detailType: ['Payment Processed'],
        detail: {
          amount: [{ numeric: ['<=', 10000] }],
        },
      },
      targets: [new targets.CloudWatchLogGroup(standardPaymentLogs)],
    });

    // CloudWatch alarms
    new cloudwatch.Alarm(this, 'WebhookReceiverErrorAlarm', {
      alarmName: `webhook-receiver-errors-${environmentSuffix}`,
      metric: webhookReceiver.metricErrors({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Alert when webhook receiver has errors exceeding 1%',
    });

    new cloudwatch.Alarm(this, 'DynamoDBThrottleAlarm', {
      alarmName: `dynamodb-throttle-${environmentSuffix}`,
      metric: paymentTable.metricUserErrors({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Alert when DynamoDB is being throttled',
    });

    // CloudWatch Dashboard
    const dashboard = new cloudwatch.Dashboard(this, 'PaymentDashboard', {
      dashboardName: `payment-webhook-dashboard-${environmentSuffix}`,
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Latency',
        left: [
          api.metricLatency({
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations',
        left: [
          webhookReceiver.metricInvocations(),
          eventProcessor.metricInvocations(),
          notificationHandler.metricInvocations(),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Consumed Capacity',
        left: [
          paymentTable.metricConsumedReadCapacityUnits(),
          paymentTable.metricConsumedWriteCapacityUnits(),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'SQS Queue Depth',
        left: [
          processingQueue.metricApproximateNumberOfMessagesVisible(),
          notificationQueue.metricApproximateNumberOfMessagesVisible(),
        ],
        width: 12,
        height: 6,
      })
    );

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
      exportName: `payment-webhook-api-url-${environmentSuffix}`,
    });

    new cdk.CfnOutput(this, 'HealthCheckUrl', {
      value: healthCheckUrl.url,
      description: 'Lambda Function URL for health checks',
      exportName: `payment-webhook-health-url-${environmentSuffix}`,
    });

    new cdk.CfnOutput(this, 'PaymentTableName', {
      value: paymentTable.tableName,
      description: 'DynamoDB table name',
      exportName: `payment-table-name-${environmentSuffix}`,
    });

    new cdk.CfnOutput(this, 'EventBusName', {
      value: paymentEventBus.eventBusName,
      description: 'EventBridge event bus name',
      exportName: `payment-eventbus-name-${environmentSuffix}`,
    });

    new cdk.CfnOutput(this, 'ArchiveBucketName', {
      value: archiveBucket.bucketName,
      description: 'S3 archive bucket name',
      exportName: `payment-archive-bucket-${environmentSuffix}`,
    });
  }
}
