# Contributing to Serverless Payment Webhooks

Thank you for your interest in contributing to the Serverless Payment Webhooks project! This is an educational infrastructure-as-code project designed to help developers learn best practices for building production-grade serverless payment processing systems on AWS.

## Code of Conduct

This project follows the InfraTales community standards:

- Be respectful and inclusive
- Welcome newcomers and beginners
- Focus on constructive feedback
- Assume good intentions
- Keep discussions professional

### Unacceptable Behavior

- Harassment or discrimination
- Trolling or inflammatory comments
- Personal attacks
- Spam or self-promotion
- Publishing others' private information

## How to Contribute

### 1. Reporting Bugs

Found a bug? Help us improve by reporting it:

**Before submitting:**
- Check if the issue already exists in GitHub Issues
- Verify it's reproducible with the latest version
- Check the troubleshooting guide

**When reporting, include:**
- Clear description of the issue
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node version, AWS region, etc.)
- Error messages and logs
- Infrastructure state (if applicable)

### 2. Suggesting Enhancements

Have an idea for improvement?

**Good enhancement requests include:**
- Clear use case or problem statement
- Proposed solution or approach
- Potential impact on existing functionality
- Alternative solutions considered
- Examples of similar implementations

### 3. Improving Documentation

Documentation improvements are always welcome:

- Fix typos or clarify confusing sections
- Add missing examples or use cases
- Improve architecture diagrams
- Update cost estimates
- Add troubleshooting scenarios
- Translate to other languages

### 4. Adding Examples

Help others learn by contributing examples:

- Real-world use cases
- Integration patterns
- Testing strategies
- Monitoring configurations
- Security hardening
- Cost optimization techniques

## Development Setup

### Prerequisites

- Node.js 18+ and npm 9+
- AWS CLI configured with appropriate credentials
- AWS CDK CLI: `npm install -g aws-cdk`
- TypeScript knowledge
- Git

### Getting Started

1. **Fork the repository**
   ```bash
   # Click "Fork" on GitHub, then:
   git clone https://github.com/YOUR-USERNAME/serverless-payment-webhooks.git
   cd serverless-payment-webhooks
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   # Set your AWS environment
   export AWS_PROFILE=your-profile
   export AWS_REGION=us-east-1
   ```

4. **Run tests**
   ```bash
   npm test
   ```

5. **Deploy to your test environment**
   ```bash
   npm run deploy
   ```

## Coding Standards

### TypeScript Conventions

- Use TypeScript strict mode
- Follow ESLint configuration
- Use meaningful variable and function names
- Add JSDoc comments for public APIs
- Avoid `any` types - use proper typing

### Infrastructure Code

- **Naming**: Use descriptive resource names with environmentSuffix
- **Tagging**: Tag all resources appropriately
- **Security**: Follow AWS security best practices
- **Cost**: Consider cost implications of changes
- **Testing**: Add unit and integration tests
- **Documentation**: Update docs for infrastructure changes

### Documentation

- Write clear, concise explanations
- Use real engineering tone (see InfraTales voice guidelines)
- Include "why" not just "how"
- Document trade-offs and limitations
- Provide code examples
- Update architecture diagrams as needed

### Commit Messages

Use conventional commit format:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**
```
feat(lambda): add signature validation for webhooks

- Implement HMAC-SHA256 validation
- Add unit tests for validation logic
- Update documentation

Closes #123
```

```
fix(dynamodb): correct GSI partition key type

The GSI was using NUMBER instead of STRING for the provider
field, causing query failures.

Fixes #456
```

## Pull Request Process

1. **Update your branch**
   ```bash
   git checkout main
   git pull upstream main
   git checkout your-feature-branch
   git rebase main
   ```

2. **Run tests**
   ```bash
   npm test
   npm run lint
   ```

3. **Update documentation**
   - Update README if behavior changes
   - Update architecture docs if structure changes
   - Update API docs if interfaces change
   - Add or update examples as needed

4. **Create pull request**
   - Use a clear, descriptive title
   - Reference related issues
   - Describe what changed and why
   - Include screenshots for UI changes
   - List breaking changes clearly
   - Mention how you tested the changes

5. **Code review**
   - Address reviewer feedback
   - Keep discussions focused and professional
   - Update based on suggestions
   - Ask questions if feedback is unclear

6. **Merge requirements**
   - All tests must pass
   - At least one maintainer approval
   - No unresolved conversations
   - Documentation updated
   - Follows coding standards

## Testing Guidelines

### Unit Tests

- Test individual constructs and functions
- Mock AWS services
- Aim for high code coverage
- Test error conditions
- Fast execution

### Integration Tests

- Test deployed infrastructure
- Verify actual AWS resource creation
- Test end-to-end workflows
- Clean up resources after tests

### Running Tests

```bash
# Unit tests only
npm run test:unit

# Integration tests (requires AWS account)
npm run test:integration

# All tests
npm test

# With coverage
npm run test:coverage
```

## Project Structure

```
serverless-payment-webhooks/
├── bin/                    # CDK app entry point
├── lib/                    # Infrastructure code
│   ├── lambda/            # Lambda function code
│   └── *.ts               # CDK constructs
├── tests/                 # Test files
│   ├── unit/             # Unit tests
│   └── integration/      # Integration tests
├── docs/                  # Documentation
├── diagrams/             # Architecture diagrams
├── examples/             # Example configurations
└── scripts/              # Utility scripts
```

## Community

### Getting Help

- **GitHub Discussions**: Ask questions and share ideas
- **GitHub Issues**: Report bugs and request features
- **Documentation**: Check the docs/ folder
- **Examples**: See examples/ for common patterns

### Recognition

We value all contributions:

- Contributors are acknowledged in README
- Significant contributions are highlighted in release notes
- Regular contributors may be invited as maintainers

## First-Time Contributors

Welcome! We're happy to help you get started:

1. Look for issues labeled `good first issue`
2. Read the documentation thoroughly
3. Start with small changes
4. Ask questions if you're unsure
5. Don't be afraid to make mistakes

This project is educational - we expect questions and are here to help you learn.

## Maintainers

Current maintainers:

- Rahul Ladumor (@RahulLadumor) - rahul.ladumor@infratales.com

## Questions?

- Open a GitHub Discussion
- Email: contact@infratales.com
- Check the FAQ in documentation

Thank you for contributing to InfraTales!

---

Originally created by Rahul Ladumor / InfraTales
