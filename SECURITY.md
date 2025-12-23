# Security Policy

## Supported Versions

We release patches for security vulnerabilities for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | ✓                  |
| < 1.0   | ✗                  |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to: security@infratales.com

You should receive a response within 48 hours. If for some reason you do not, please follow up via email to ensure we received your original message.

Please include the following information (as much as you can provide):

- Type of issue (e.g. authentication bypass, data exposure, injection vulnerability, etc.)
- Full paths of source file(s) related to the manifestation of the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

This information will help us triage your report more quickly.

## Security Best Practices

When deploying this infrastructure:

### AWS Credentials

- **Never commit AWS credentials** to the repository
- Use IAM roles with least-privilege permissions
- Enable MFA for AWS console access
- Rotate access keys regularly
- Use AWS Secrets Manager for sensitive data

### Infrastructure Security

- **VPC**: All Lambda functions deployed in private subnets
- **Encryption**:
  - At rest: KMS encryption for DynamoDB, S3, SQS, SNS
  - In transit: TLS 1.2+ for all API communication
- **IAM**: Least-privilege policies for all resources
- **Security Groups**: Restrictive ingress/egress rules
- **API Gateway**: Consider adding API keys or AWS IAM authorization
- **Monitoring**: CloudWatch alarms for security events

### Payment Security (PCI Compliance)

- **Signature Validation**: Always implement proper HMAC-SHA256 validation for webhooks
- **Data Storage**: Never store full credit card numbers in DynamoDB
- **Data Retention**: Follow PCI DSS requirements for data retention
- **Encryption**: All payment data encrypted at rest and in transit
- **Access Control**: Limit IAM permissions to payment data
- **Audit Logging**: Enable CloudTrail for all API operations
- **Network Isolation**: Payment processing in isolated VPC subnets

### Code Security

- Run `npm audit` regularly to check for vulnerabilities
- Keep dependencies up to date
- Review third-party packages before use
- Use TypeScript strict mode for type safety
- Validate and sanitize all webhook payloads

### Deployment Security

- **Development**: Use separate AWS accounts from production
- **Testing**: Never use production data in test environments
- **Secrets**: Use environment variables or AWS Secrets Manager
- **Access**: Implement least-privilege IAM policies
- **Monitoring**: Enable CloudWatch Logs and metrics

### Security Checklist

Before deploying to production:

- [ ] Enable CloudTrail for audit logging
- [ ] Configure AWS Config for compliance monitoring
- [ ] Set up AWS GuardDuty for threat detection
- [ ] Enable VPC Flow Logs
- [ ] Configure Security Hub for security standards
- [ ] Review all IAM policies for least privilege
- [ ] Enable encryption for all data stores
- [ ] Configure backup and disaster recovery
- [ ] Set up monitoring and alerting
- [ ] Document security procedures
- [ ] Train team on security best practices
- [ ] Conduct security review
- [ ] Implement proper webhook signature validation
- [ ] Configure API Gateway throttling and quotas
- [ ] Set up WAF rules for API Gateway (if public)
- [ ] Review Lambda function code for security issues
- [ ] Enable X-Ray tracing for security analysis

### Known Security Considerations

#### API Gateway

- Current implementation uses Lambda integration without authentication
- Consider adding API keys, AWS IAM, or Cognito for production
- Implement request throttling and rate limiting
- Use WAF to protect against common attacks

#### Lambda Function URLs

- Health check endpoint has no authentication (`AuthType: NONE`)
- This is acceptable for health checks but not for payment data
- Consider moving health checks to separate function
- Use IAM authentication for sensitive endpoints

#### DynamoDB Access

- Uses IAM roles for authentication
- Supports fine-grained access control
- Enable point-in-time recovery
- Use KMS encryption at rest
- Consider enabling DynamoDB Streams encryption

#### S3 Archive Bucket

- Encrypted with KMS
- Versioning enabled
- Lifecycle policy transitions to Glacier
- Consider adding bucket policies for access control
- Enable S3 access logging

#### SQS Queues

- Encrypted with KMS
- Consider adding dead-letter queues
- Set appropriate visibility timeout
- Monitor queue depth for anomalies

#### Lambda Functions

- Execution roles with minimal permissions
- Environment variables for configuration (not secrets)
- VPC configuration for network isolation
- CloudWatch Logs for monitoring
- Consider using Lambda layers for shared code

#### Webhook Signature Validation

- Example code uses simplified validation (always returns true)
- **CRITICAL**: Implement proper HMAC-SHA256 validation before production
- Store webhook secrets in AWS Secrets Manager
- Rotate secrets regularly
- Validate timestamp to prevent replay attacks

### Responsible Disclosure

We follow the principle of responsible disclosure:

1. Report received and acknowledged within 48 hours
2. Issue investigated and confirmed (1-5 business days)
3. Patch developed and tested
4. Security advisory drafted
5. Patch released with security advisory
6. Public disclosure after users have time to update (typically 90 days)

We appreciate your efforts to responsibly disclose your findings and will make every effort to acknowledge your contributions.

## Security Updates

Security updates will be released as soon as possible after a vulnerability is confirmed. Updates will be announced via:

- GitHub Security Advisories
- Repository releases page
- README security section
- Email to known users (when possible)

## Questions

If you have questions about this security policy, please:

- Open a GitHub Discussion (for general security questions)
- Email security@infratales.com (for sensitive concerns)
- Review the documentation in docs/

## Attribution

This security policy is based on best practices from:
- [OWASP](https://owasp.org/)
- [AWS Security Best Practices](https://aws.amazon.com/security/best-practices/)
- [PCI DSS Guidelines](https://www.pcisecuritystandards.org/)
- [GitHub Security Best Practices](https://docs.github.com/en/code-security)

---

Originally created by Rahul Ladumor / InfraTales
