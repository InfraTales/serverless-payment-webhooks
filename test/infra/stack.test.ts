import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { PaymentWebhooksStack } from '../../lib/payment-webhooks-stack';

const app = new cdk.App();
const stack = new PaymentWebhooksStack(app, 'Test', { alertEmail: 'ops@example.com', env: { region: 'us-east-1' } });
const template = Template.fromStack(stack);

test('two Lambda functions on the newest Node.js runtime, arm64, outside any VPC', () => {
  template.resourceCountIs('AWS::Lambda::Function', 2);
  template.allResourcesProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs24.x',
    Architectures: ['arm64'],
    VpcConfig: Match.absent(),
  });
});

test('no NAT gateway or VPC at all', () => {
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.resourceCountIs('AWS::EC2::VPC', 0);
});

test('queue has a DLQ after 5 receives and a visibility timeout 6x the processor timeout', () => {
  template.hasResourceProperties('AWS::SQS::Queue', {
    VisibilityTimeout: 180,
    RedrivePolicy: { maxReceiveCount: 5, deadLetterTargetArn: Match.anyValue() },
    SqsManagedSseEnabled: true,
  });
  template.hasResourceProperties('AWS::Lambda::Function', { Timeout: 30, Environment: { Variables: Match.objectLike({ LOCK_SECONDS: '120' }) } });
});

test('event source reports per-message failures and caps concurrency', () => {
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    BatchSize: 10,
    FunctionResponseTypes: ['ReportBatchItemFailures'],
    ScalingConfig: { MaximumConcurrency: 5 },
  });
});

test('idempotency table expires rows with TTL', () => {
  template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
    KeySchema: [{ AttributeName: 'eventId', KeyType: 'HASH' }],
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
  });
});

test('payments table is kept on stack delete', () => {
  template.hasResource('AWS::DynamoDB::GlobalTable', {
    Properties: { KeySchema: [{ AttributeName: 'paymentId', KeyType: 'HASH' }] },
    DeletionPolicy: 'Retain',
  });
});

test('one public route, POST only, with throttling and access logs', () => {
  template.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /webhooks/payments' });
  template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
    DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
    AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
  });
});

test('receiver can read the secret and send to the queue, and nothing else', () => {
  const policies = template.findResources('AWS::IAM::Policy');
  const receiverPolicy = Object.entries(policies).find(([id]) => id.startsWith('ReceiverServiceRole'))![1];
  const actions = receiverPolicy.Properties.PolicyDocument.Statement.flatMap((s: any) => [].concat(s.Action));
  expect(actions.some((a: string) => a.startsWith('dynamodb:'))).toBe(false);
  expect(actions.some((a: string) => a.startsWith('events:'))).toBe(false);
  expect(actions).toEqual(expect.arrayContaining(['sqs:SendMessage', 'secretsmanager:GetSecretValue']));
});

test('failed payments go to the alert topic', () => {
  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: { source: ['webhooks.payments'], 'detail-type': ['payment.failed'] },
  });
});

test('cdk-nag AWS Solutions finds no unacknowledged findings', () => {
  const nagApp = new cdk.App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-')) });
  new PaymentWebhooksStack(nagApp, 'Nag', { env: { region: 'us-east-1' } });
  cdk.Validations.of(nagApp).addPlugins(new AwsSolutionsChecks(nagApp));
  const assembly = nagApp.synth();
  const report = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'validation-report.json'), 'utf8'));
  for (const plugin of report.pluginReports) {
    expect(plugin.violations).toEqual([]);
    // Every acknowledgement must carry a written reason.
    for (const ack of plugin.suppressedViolations) expect(ack.reason.length).toBeGreaterThan(40);
  }
});

test('timeouts are ordered: processor timeout < lock < visibility timeout', () => {
  // If the lock were shorter than the function timeout, a slow worker could lose it mid-event
  // and a retry would process the same event twice. If visibility were shorter than the lock,
  // retries would arrive while the lock is still live and burn receive attempts towards the DLQ.
  const processor = Object.values<any>(template.findResources('AWS::Lambda::Function'))
    .find((f) => f.Properties.Environment.Variables.LOCK_SECONDS)!.Properties;
  const queue = Object.values<any>(template.findResources('AWS::SQS::Queue')).find((q) => q.Properties.RedrivePolicy)!.Properties;
  const lock = Number(processor.Environment.Variables.LOCK_SECONDS);

  expect(processor.Timeout).toBeLessThan(lock);
  expect(lock).toBeLessThan(queue.VisibilityTimeout);
  expect(queue.VisibilityTimeout).toBeGreaterThanOrEqual(6 * processor.Timeout);
});

test('alarms cover the DLQ, queue age, 4xx and 5xx, all wired to the alert topic', () => {
  const alarms = Object.values<any>(template.findResources('AWS::CloudWatch::Alarm'));
  expect(alarms.map((a) => a.Properties.MetricName).sort()).toEqual(
    ['4xx', '5xx', 'ApproximateAgeOfOldestMessage', 'ApproximateNumberOfMessagesVisible'],
  );
  for (const a of alarms) expect(a.Properties.AlarmActions).toHaveLength(1);
});
