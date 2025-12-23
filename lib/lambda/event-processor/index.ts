/**
 * Event Processor Lambda Function
 *
 * Processes queued payment events, transforms data, updates DynamoDB,
 * publishes to EventBridge, and routes high-value payments for notification.
 *
 * Originally created by Rahul Ladumor / InfraTales
 */

import { SQSEvent } from 'aws-lambda';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const dynamoClient = new DynamoDBClient({});
const eventBridgeClient = new EventBridgeClient({});
const sqsClient = new SQSClient({});

const PAYMENT_TABLE = process.env.PAYMENT_TABLE!;
const EVENT_BUS = process.env.EVENT_BUS!;
const NOTIFICATION_QUEUE = process.env.NOTIFICATION_QUEUE!;

export const handler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body);
      const { paymentId, timestamp, payload } = message;

      // Transform and enrich the payment data
      const processedPayment = {
        paymentId,
        timestamp,
        provider: payload.provider || 'unknown',
        amount: parseFloat(payload.amount || 0),
        currency: payload.currency || 'USD',
        status: payload.status || 'processed',
        processedAt: Date.now(),
      };

      // Update DynamoDB
      await dynamoClient.send(
        new UpdateItemCommand({
          TableName: PAYMENT_TABLE,
          Key: {
            paymentId: { S: paymentId },
            timestamp: { N: timestamp.toString() },
          },
          UpdateExpression:
            'SET #status = :status, processedAt = :processedAt, currency = :currency',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':status': { S: 'processed' },
            ':processedAt': { N: Date.now().toString() },
            ':currency': { S: processedPayment.currency },
          },
        })
      );

      // Send to EventBridge
      await eventBridgeClient.send(
        new PutEventsCommand({
          Entries: [
            {
              Source: 'payment.processor',
              DetailType: 'Payment Processed',
              Detail: JSON.stringify(processedPayment),
              EventBusName: EVENT_BUS,
            },
          ],
        })
      );

      // If high-value payment or failed, send to notification queue
      if (processedPayment.amount > 10000 || payload.status === 'failed') {
        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: NOTIFICATION_QUEUE,
            MessageBody: JSON.stringify(processedPayment),
          })
        );
        console.log(
          `High-value or failed payment queued for notification: ${paymentId}`
        );
      }

      console.log(
        `Processed payment ${paymentId}: $${processedPayment.amount}`
      );
    } catch (error) {
      console.error('Error processing payment:', error);
      throw error; // This will cause the message to be retried
    }
  }
};
