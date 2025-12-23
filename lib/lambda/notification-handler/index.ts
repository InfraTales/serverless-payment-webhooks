/**
 * Notification Handler Lambda Function
 *
 * Sends SNS alerts for high-value and failed payments to operations team.
 * Retrieves full payment details from DynamoDB before notifying.
 *
 * Originally created by Rahul Ladumor / InfraTales
 */

import { SQSEvent } from 'aws-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const snsClient = new SNSClient({});
const dynamoClient = new DynamoDBClient({});

const ALERT_TOPIC = process.env.ALERT_TOPIC!;
const PAYMENT_TABLE = process.env.PAYMENT_TABLE!;

export const handler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    try {
      const payment = JSON.parse(record.body);

      // Get full payment details from DynamoDB
      const result = await dynamoClient.send(
        new GetItemCommand({
          TableName: PAYMENT_TABLE,
          Key: {
            paymentId: { S: payment.paymentId },
            timestamp: { N: payment.timestamp.toString() },
          },
        })
      );

      if (!result.Item) {
        console.warn(`Payment ${payment.paymentId} not found in DynamoDB`);
        continue;
      }

      const amount = parseFloat(payment.amount || 0);
      const provider = payment.provider || 'unknown';
      const status = payment.status || 'unknown';

      // Send notification for high-value or failed payments
      if (amount > 10000 || status === 'failed') {
        const subject =
          status === 'failed'
            ? `URGENT: Failed Payment Alert - $${amount}`
            : `High-Value Payment Alert: $${amount}`;

        const message = `
Payment Notification
====================

Type: ${status === 'failed' ? 'FAILED PAYMENT' : 'HIGH-VALUE PAYMENT'}

Payment Details:
- Payment ID: ${payment.paymentId}
- Provider: ${provider}
- Amount: $${amount.toFixed(2)}
- Currency: ${payment.currency || 'USD'}
- Status: ${status}
- Timestamp: ${new Date(payment.processedAt || payment.timestamp).toISOString()}

${status === 'failed' ? 'IMMEDIATE ACTION REQUIRED' : 'Please review this transaction for compliance.'}

This is an automated alert from the Payment Webhook Processing System.
        `.trim();

        await snsClient.send(
          new PublishCommand({
            TopicArn: ALERT_TOPIC,
            Subject: subject,
            Message: message,
          })
        );

        console.log(
          `Sent alert for payment ${payment.paymentId} (${status}, $${amount})`
        );
      }
    } catch (error) {
      console.error('Error sending notification:', error);
      throw error;
    }
  }
};
