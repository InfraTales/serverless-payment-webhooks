/**
 * Loads each bundled Lambda file the way the Lambda runtime does.
 * Catches "Cannot find module" before it reaches AWS.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { PaymentWebhooksStack } from '../../lib/payment-webhooks-stack';

test('every bundled function loads and exports a handler', () => {
  const app = new cdk.App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-bundle-')) });
  new PaymentWebhooksStack(app, 'Bundle', { env: { region: 'us-east-1' } });
  const assembly = app.synth();

  const template = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'Bundle.template.json'), 'utf8'));
  const functions = Object.values<any>(template.Resources).filter((r) => r.Type === 'AWS::Lambda::Function');
  expect(functions).toHaveLength(2);

  for (const fn of functions) {
    // CDK writes each bundle to asset.<hash>, and the hash is the S3 key without ".zip".
    const hash = fn.Properties.Code.S3Key.replace('.zip', '');
    const mod = require(path.join(assembly.directory, `asset.${hash}`, 'index.js'));
    expect(typeof mod.handler).toBe('function');
  }
});
