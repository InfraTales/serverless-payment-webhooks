import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';

export interface PaymentWebhooksStackProps extends cdk.StackProps {
  /** Email address for DLQ and failed-payment alerts. Optional. */
  alertEmail?: string;
  /** Days to remember a processed event ID. Must outlast the provider's retry window. */
  retentionDays?: number;
}

const PROCESSOR_TIMEOUT = cdk.Duration.seconds(30);
// Lock: longer than the function timeout, so a slow worker keeps it while running.
// Visibility timeout: AWS recommends at least 6x the function timeout for SQS event sources.
const LOCK_SECONDS = 120;
const VISIBILITY_TIMEOUT = cdk.Duration.seconds(180);

export class PaymentWebhooksStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PaymentWebhooksStackProps = {}) {
    super(scope, id, props);
    const retentionDays = props.retentionDays ?? 30;

    // ---------- storage ----------
    const eventsTable = new dynamodb.TableV2(this, 'ProcessedEvents', {
      partitionKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const paymentsTable = new dynamodb.TableV2(this, 'Payments', {
      partitionKey: { name: 'paymentId', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---------- signing secret ----------
    // The provider issues the real secret. Paste it in after deploy:
    //   {"current": "<secret from provider>", "previous": ""}
    const signingSecret = new secretsmanager.Secret(this, 'SigningSecret', {
      description: 'Webhook signing secret from the payment provider. JSON: {"current": "...", "previous": "..."}',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ previous: '' }),
        generateStringKey: 'current',
        excludePunctuation: true,
        passwordLength: 48,
      },
    });

    // ---------- queue ----------
    const dlq = new sqs.Queue(this, 'WebhookDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    const queue = new sqs.Queue(this, 'WebhookQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: VISIBILITY_TIMEOUT,
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    // ---------- alerts ----------
    const alerts = new sns.Topic(this, 'Alerts', { enforceSSL: true });
    if (props.alertEmail) {
      new sns.Subscription(this, 'AlertEmail', { topic: alerts, protocol: sns.SubscriptionProtocol.EMAIL, endpoint: props.alertEmail });
    }

    // ---------- event bus for downstream consumers ----------
    const bus = new events.EventBus(this, 'PaymentEvents');
    new events.Rule(this, 'FailedPayments', {
      eventBus: bus,
      description: 'Alert a person when a payment fails',
      eventPattern: { source: ['webhooks.payments'], detailType: ['payment.failed'] },
      targets: [new targets.SnsTopic(alerts)],
    });

    // ---------- functions ----------
    const fnDefaults: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // Bundle the SDK clients too, so the code we test is the code that runs.
      bundling: { externalModules: [], minify: true, sourceMap: true },
    };
    const logGroup = (id: string) =>
      new logs.LogGroup(this, id, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });

    const receiver = new nodejs.NodejsFunction(this, 'Receiver', {
      ...fnDefaults,
      entry: path.join(__dirname, '../lambda/receiver.ts'),
      timeout: cdk.Duration.seconds(10),
      logGroup: logGroup('ReceiverLogs'),
      environment: {
        QUEUE_URL: queue.queueUrl,
        SIGNING_SECRET_ARN: signingSecret.secretArn,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    queue.grantSendMessages(receiver);
    signingSecret.grantRead(receiver);

    const processor = new nodejs.NodejsFunction(this, 'Processor', {
      ...fnDefaults,
      entry: path.join(__dirname, '../lambda/processor.ts'),
      timeout: PROCESSOR_TIMEOUT,
      logGroup: logGroup('ProcessorLogs'),
      environment: {
        EVENTS_TABLE: eventsTable.tableName,
        PAYMENTS_TABLE: paymentsTable.tableName,
        EVENT_BUS_NAME: bus.eventBusName,
        LOCK_SECONDS: String(LOCK_SECONDS),
        RETENTION_DAYS: String(retentionDays),
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    eventsTable.grantReadWriteData(processor);
    paymentsTable.grantReadWriteData(processor);
    bus.grantPutEventsTo(processor);
    processor.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(1),
        reportBatchItemFailures: true,
        // Caps how hard a burst of webhooks can hit DynamoDB and downstream systems.
        maxConcurrency: 5,
      }),
    );

    // ---------- public endpoint ----------
    const accessLogs = logGroup('ApiAccessLogs');
    const api = new apigwv2.HttpApi(this, 'WebhookApi', {
      description: 'Receives signed payment webhooks',
      createDefaultStage: false,
    });
    api.addRoutes({
      path: '/webhooks/payments',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('ReceiverIntegration', receiver),
    });
    const stage = new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: api,
      autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 },
    });
    (stage.node.defaultChild as apigwv2.CfnStage).accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        routeKey: '$context.routeKey',
        status: '$context.status',
        latency: '$context.responseLatency',
        integrationError: '$context.integrationErrorMessage',
      }),
    };

    // ---------- alarms ----------
    const alarmAction = new cwActions.SnsAction(alerts);
    new cloudwatch.Alarm(this, 'DlqNotEmpty', {
      alarmDescription: 'A webhook failed 5 times and is parked in the DLQ. Fix the cause, then redrive.',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    new cloudwatch.Alarm(this, 'QueueFallingBehind', {
      alarmDescription: 'The oldest webhook has waited more than 5 minutes.',
      metric: queue.metricApproximateAgeOfOldestMessage({ period: cdk.Duration.minutes(1), statistic: 'Maximum' }),
      threshold: 300,
      evaluationPeriods: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    new cloudwatch.Alarm(this, 'SignatureRejections', {
      alarmDescription: 'Many 4xx answers: a bad secret after rotation, or someone probing the endpoint.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '4xx',
        dimensionsMap: { ApiId: api.apiId, Stage: '$default' },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 20,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // ---------- outputs ----------
    new cdk.CfnOutput(this, 'WebhookUrl', { value: `${api.apiEndpoint}/webhooks/payments` });
    new cdk.CfnOutput(this, 'SigningSecretArn', { value: signingSecret.secretArn });
    new cdk.CfnOutput(this, 'EventsTableName', { value: eventsTable.tableName });
    new cdk.CfnOutput(this, 'PaymentsTableName', { value: paymentsTable.tableName });
    new cdk.CfnOutput(this, 'DlqUrl', { value: dlq.queueUrl });

    // ---------- cdk-nag: only by-design findings are acknowledged, each with a reason ----------
    const ack = (id: string, reason: string) => cdk.Validations.of(this).acknowledge({ id, reason });
    ack('AwsSolutions::AwsSolutions-APIG4',
      'Payment providers cannot sign requests with SigV4 or send JWTs. Each request is authenticated by an HMAC-SHA256 signature over the raw body with a 5-minute replay window, checked in the receiver before anything is queued.');
    ack('AwsSolutions::AwsSolutions-SMG4',
      'The payment provider issues and rotates this secret. Rotation is manual: put the new value in "current" and the old one in "previous", then remove "previous" once the provider has switched.');
    ack('AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      'The AWS managed basic execution policy only allows writing to CloudWatch Logs.');
  }
}
