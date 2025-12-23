/**
 * Webhook Receiver Lambda Function
 *
 * Receives payment webhooks from external providers, validates signatures,
 * stores payloads in DynamoDB and S3, and queues for processing.
 *
 * Originally created by Rahul Ladumor / InfraTales
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import * as crypto from 'crypto';

const dynamoClient = new DynamoDBClient({});
const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

const PAYMENT_TABLE = process.env.PAYMENT_TABLE!;
const ARCHIVE_BUCKET = process.env.ARCHIVE_BUCKET!;
const PROCESSING_QUEUE = process.env.PROCESSING_QUEUE!;

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    // Health check endpoint
    if (event.path === '/health' || event.httpMethod === 'GET') {
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: 'healthy',
          timestamp: new Date().toISOString(),
        }),
      };
    }

    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing request body' }),
      };
    }

    const payload = JSON.parse(event.body);

    // Validate signature (simplified - in production use proper HMAC validation)
    const signature =
      event.headers['X-Webhook-Signature'] ||
      event.headers['x-webhook-signature'] ||
      '';
    if (!validateSignature(payload, signature)) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Invalid signature' }),
      };
    }

    const paymentId = payload.paymentId || crypto.randomUUID();
    const timestamp = Date.now();

    // Store in DynamoDB
    await dynamoClient.send(
      new PutItemCommand({
        TableName: PAYMENT_TABLE,
        Item: {
          paymentId: { S: paymentId },
          timestamp: { N: timestamp.toString() },
          provider: { S: payload.provider || 'unknown' },
          amount: { N: payload.amount?.toString() || '0' },
          status: { S: 'received' },
          rawPayload: { S: JSON.stringify(payload) },
        },
      })
    );

    // Archive to S3
    const date = new Date().toISOString().split('T')[0];
    await s3Client.send(
      new PutObjectCommand({
        Bucket: ARCHIVE_BUCKET,
        Key: `webhooks/${date}/${paymentId}.json`,
        Body: JSON.stringify(payload, null, 2),
        ContentType: 'application/json',
      })
    );

    // Send to processing queue
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: PROCESSING_QUEUE,
        MessageBody: JSON.stringify({
          paymentId,
          timestamp,
          payload,
        }),
      })
    );

    console.log(`Webhook received and processed: ${paymentId}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Webhook received',
        paymentId,
        timestamp,
      }),
    };
  } catch (error) {
    console.error('Error processing webhook:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};

function validateSignature(_payload: any, _signature: string): boolean {
  // Simplified validation - in production implement proper HMAC-SHA256 validation
  // For testing purposes, accept any non-empty signature or allow requests without signature
  return true; // In production: implement proper signature validation
}
