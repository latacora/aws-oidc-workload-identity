# Development and Maintenance Guide

This document is for developers and maintainers of the AWS OIDC Workload Identity project.

## Project Structure

```
aws-oidc-workload-identity/
├── token-exchange.js       # Lambda: Exchanges AWS credentials for OIDC tokens
├── jwks.js                 # Lambda: Exposes public keys in JWKS format
├── deploy.sh               # Deployment script
├── destroy.sh              # Cleanup script
├── package.json            # Node.js dependencies
├── test/                   # Test suite
│   ├── token-exchange.test.js
│   ├── jwks.test.js
│   └── integration.test.js
├── docs/
│   ├── tailscale.md        # Tailscale integration guide
│   └── client.md           # Client usage guide
├── README.md               # User documentation
├── SECURITY.md             # Security considerations
└── CLAUDE.md               # This file
```

## Development Setup

### Prerequisites

- Node.js 22+
- AWS CLI configured
- Git
- Bash shell

### Local Setup

```bash
# Clone repository
git clone https://github.com/your-org/aws-oidc-workload-identity.git
cd aws-oidc-workload-identity

# Install dependencies
npm install

# Run tests
npm test
```

## Testing

### Unit Tests

Run unit tests for individual Lambda functions:

```bash
npm test
```

Tests use Node.js built-in test runner with mocked AWS SDK clients.

### Integration Tests

Integration tests verify end-to-end token generation and verification:

```bash
npm test test/integration.test.js
```

### Manual Testing

Deploy to AWS and test manually:

```bash
# Deploy
export ISSUER="https://test.example.com"
./deploy.sh

# Test token exchange
curl -X POST $(cat deployment-output.json | jq -r '.token_url') \
  -H "Content-Type: application/json" \
  -d "{
    \"access_key_id\": \"$AWS_ACCESS_KEY_ID\",
    \"secret_access_key\": \"$AWS_SECRET_ACCESS_KEY\"
  }" | jq

# Test JWKS endpoint
curl $(cat deployment-output.json | jq -r '.jwks_url') | jq

# Cleanup
./destroy.sh
```

## Architecture Deep Dive

### Token Exchange Flow

1. **Request Reception**
   - Lambda receives POST request with AWS credentials
   - Credentials extracted from JSON body or headers

2. **Credential Verification**
   - New STS client created with provided credentials
   - `GetCallerIdentity` called to verify credentials
   - Returns account ID, ARN, and user ID

3. **JWT Generation**
   - Header constructed with algorithm, type, and key ID
   - Payload constructed with OIDC and AWS claims
   - Header and payload base64url encoded

4. **Signing**
   - Signing input: `base64url(header).base64url(payload)`
   - KMS `Sign` API called with RSA-SHA256 algorithm
   - Signature base64url encoded

5. **Response**
   - JWT returned: `header.payload.signature`
   - Includes token type and expiration time

### JWKS Endpoint

1. **Public Key Retrieval**
   - KMS `GetPublicKey` API called
   - Returns DER-encoded RSA public key

2. **JWK Conversion**
   - DER format converted to JWK format
   - Includes key type, use, algorithm, key ID, modulus, exponent

3. **Caching**
   - JWKS cached for 1 hour in Lambda memory
   - Reduces KMS API calls and improves performance

4. **Response**
   - JWKS JSON returned with public cache headers
   - Allows OIDC consumers to cache the key

## Code Conventions

### Style Guide

- Use ESM (ES Modules) syntax
- Use async/await for asynchronous operations
- Prefer const over let
- Use descriptive variable names
- Add JSDoc comments for functions
- Keep functions small and focused

### Error Handling

- Always catch and log errors
- Don't leak sensitive information in error messages
- Return appropriate HTTP status codes
- Log sufficient context for debugging

### Security

- Never log credentials or tokens
- Validate all inputs
- Use parameterized queries/commands
- Follow principle of least privilege
- Keep dependencies minimal

**Critical Security Requirement - Direct Invocation Protection**:

The token-exchange Lambda MUST have a resource-based policy that prevents direct invocation. Without this:
- Anyone with `lambda:InvokeFunction` permission can directly invoke the Lambda
- They can forge the entire event JSON, including `requestContext.authorizer.iam`
- This allows minting OIDC tokens for ANY AWS identity (complete auth bypass)

The deploy script automatically configures this protection by:
1. Allowing `lambda:InvokeFunctionUrl` for Function URL access
2. Allowing `lambda:InvokeFunction` ONLY with condition `lambda:InvokedViaFunctionUrl: true`

The `lambda:InvokedViaFunctionUrl` condition key:
- Set by AWS during IAM authorization, before Lambda execution
- Cannot be forged by attackers (unlike event payload data)
- Ensures Lambda only runs when invoked via Function URL with validated SigV4

Verification:
```bash
aws lambda get-policy --function-name aws-oidc-workload-identity-token-exchange | jq
# Must show condition: "lambda:InvokedViaFunctionUrl": "true"
```

### Documentation

- Use Mermaid diagrams for all architecture and flow diagrams
- Mermaid diagrams render natively in GitHub and are easier to maintain than ASCII art
- Do NOT add color styling - colors are illegible on GitHub's dark theme
- Keep diagrams simple and focused on one concept
- Example:
  ```mermaid
  graph TD
      A[Component A] -->|Action| B[Component B]
  ```

### Shell Scripts

- Run `shellcheck` on all shell scripts before committing
- Consider shellcheck suggestions carefully - they're usually right, but not always
- shellcheck's purpose is to flag potential issues; you decide which to address
- **Always document exceptions**: If you use `# shellcheck disable=SCXXXX`, explain why in a comment
- Do NOT add blanket disables at the file level - be specific about each exception
- Use your judgment to determine when shellcheck's advice doesn't apply
- shellcheck is not infallible - critically evaluate each suggestion

## Deployment

### Deployment Script

`deploy.sh` performs:

1. **Validation**
   - Checks required environment variables
   - Verifies AWS credentials

2. **KMS Key Creation**
   - Creates RSA_2048 asymmetric key
   - Tags key with project name
   - Creates alias for easy reference

3. **IAM Role Creation**
   - Creates Lambda execution role
   - Attaches basic execution policy
   - Adds custom policy for KMS and STS

4. **Lambda Packaging**
   - Creates temporary directory
   - Copies Lambda code
   - Installs AWS SDK dependencies
   - Creates ZIP archives

5. **Lambda Deployment**
   - Creates or updates Lambda functions
   - Sets environment variables
   - Creates Function URLs
   - **SECURITY CRITICAL**: Configures resource-based policy (see below)

6. **Security Configuration** (CRITICAL)
   - Adds resource-based policy to token-exchange Lambda
   - Restricts `lambda:InvokeFunction` with `lambda:InvokedViaFunctionUrl: true` condition
   - Prevents direct invocation that could forge IAM identity
   - Without this: Anyone with `lambda:InvokeFunction` can mint arbitrary credentials

7. **Output**
   - Prints endpoint URLs
   - Saves configuration to `deployment-output.json`

### Deployment Outputs

`deployment-output.json` contains:

```json
{
  "stack_name": "aws-oidc-workload-identity",
  "region": "us-east-1",
  "kms_key_id": "abc-123-def",
  "kms_key_arn": "arn:aws:kms:us-east-1:123456789012:key/abc-123-def",
  "issuer": "https://your-domain.com",
  "token_url": "https://abc123.lambda-url.us-east-1.on.aws/",
  "jwks_url": "https://xyz789.lambda-url.us-east-1.on.aws/",
  "lambda_role_arn": "arn:aws:iam::123456789012:role/aws-oidc-workload-identity-lambda-role"
}
```

## Maintenance

### Updating Dependencies

```bash
# Check for updates
npm outdated

# Update package.json
npm update

# Test after updates
npm test

# Redeploy
./deploy.sh
```

### Monitoring

Monitor these CloudWatch metrics:

- **Lambda Invocations**: Track token requests
- **Lambda Errors**: Detect failures
- **Lambda Duration**: Monitor performance
- **KMS Sign Operations**: Track signing activity

Create CloudWatch alarms for:

- High error rates (> 5%)
- Unusual request volumes
- High latency (> 1s p99)

### Log Analysis

CloudWatch Logs groups:

- `/aws/lambda/aws-oidc-workload-identity-token-exchange`
- `/aws/lambda/aws-oidc-workload-identity-jwks`

Useful queries:

```cloudwatch
# Failed authentications
fields @timestamp, @message
| filter @message like /Token exchange failed/
| filter @message like /401/

# Token generation stats
fields @timestamp, @message
| filter @message like /Identity verified/
| stats count() by bin(5m)

# Performance metrics
fields @timestamp, @duration
| stats avg(@duration), max(@duration), pct(@duration, 99) by bin(5m)
```

### KMS Key Rotation

KMS automatic key rotation is not supported for asymmetric keys. Manual rotation:

1. Create new KMS key:
   ```bash
   aws kms create-key \
     --key-usage SIGN_VERIFY \
     --key-spec RSA_2048
   ```

2. Update Lambda environment variables:
   ```bash
   aws lambda update-function-configuration \
     --function-name aws-oidc-workload-identity-token-exchange \
     --environment "Variables={KMS_KEY_ID=new-key-id,ISSUER=$ISSUER,TOKEN_LIFETIME_SECONDS=3600}"

   aws lambda update-function-configuration \
     --function-name aws-oidc-workload-identity-jwks \
     --environment "Variables={KMS_KEY_ID=new-key-id}"
   ```

3. Wait for old tokens to expire (1 hour)

4. Schedule old key deletion:
   ```bash
   aws kms schedule-key-deletion --key-id old-key-id --pending-window-in-days 7
   ```

### Scaling Considerations

**Lambda Concurrency**:
- Default: 1000 concurrent executions per region
- Reserve concurrency if needed
- Monitor throttling metrics

**KMS Limits**:
- Sign API: 500 requests/second (can be increased)
- GetPublicKey API: 2000 requests/second
- Monitor throttling exceptions

**Cost Optimization**:
- Enable Lambda Insights for detailed metrics
- Increase Lambda memory if needed (faster = cheaper per request)
- Implement caching in token exchange Lambda
- Use X-Ray for tracing if needed

## Troubleshooting

### Lambda Cold Starts

**Problem**: First request after idle takes 1-2 seconds

**Solutions**:
- Use provisioned concurrency (increases cost)
- Accept cold starts (usually acceptable for auth flows)
- Implement retry logic in clients

### KMS Throttling

**Problem**: High request volume causes KMS throttling

**Solutions**:
- Cache JWT signing input and signature
- Request KMS limit increase
- Implement backoff and retry

### Token Verification Failures

**Problem**: OIDC consumers can't verify tokens

**Solutions**:
- Verify JWKS endpoint is accessible
- Check clock synchronization (`iat` and `exp` claims)
- Ensure `kid` in token matches JWKS
- Verify signature algorithm matches

### Deployment Failures

**Problem**: `deploy.sh` fails

**Common Issues**:
- IAM permissions: Verify deployer has necessary permissions
- Service limits: Check Lambda and KMS quotas
- Region issues: Ensure services available in region
- Race conditions: IAM propagation can take 10+ seconds

## Contributing

### Pull Request Process

1. Fork the repository
2. Create feature branch: `git checkout -b feature/my-feature`
3. Make changes and add tests
4. Run test suite: `npm test`
5. Commit with descriptive message
6. Push to fork: `git push origin feature/my-feature`
7. Create Pull Request

### Code Review Checklist

- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] Security implications considered
- [ ] Error handling appropriate
- [ ] Logging adequate for debugging
- [ ] No sensitive data in logs
- [ ] Performance impact considered
- [ ] Backwards compatibility maintained

### Security Considerations for Changes

**When modifying token generation**:
- Ensure all claims are properly validated
- Don't add user-controlled data to claims without sanitization
- Test token verification with modified claims
- Consider replay attack implications

**When modifying credential verification**:
- Always verify credentials before issuing tokens
- Don't leak information about why verification failed
- Log enough for audit but not credentials
- Consider timing attacks

**When adding dependencies**:
- Audit dependency for known vulnerabilities
- Minimize dependency footprint
- Pin versions in package.json
- Document why dependency is needed

## Performance Optimization

### Current Performance

Typical performance (cold start):
- Token Exchange: 1-2s first request, 50-200ms subsequent
- JWKS: 500-1000ms first request, 10-50ms subsequent (cached)

### Optimization Strategies

1. **Increase Lambda Memory**
   - More memory = more CPU
   - Test 512MB vs 1024MB
   - Measure cost vs performance tradeoff

2. **Caching**
   - Cache JWKS in Lambda memory (already implemented)
   - Consider caching partial JWT construction
   - Cache KMS public key metadata

3. **Reduce Package Size**
   - Use tree-shaking compatible imports
   - Exclude dev dependencies from deployment
   - Consider Lambda layers for AWS SDK

4. **Connection Pooling**
   - AWS SDK v3 handles connection pooling
   - Keep Lambda warm with CloudWatch Events
   - Use VPC endpoints if Lambda in VPC

## Future Enhancements

Potential improvements for future versions:

1. **Additional Signing Algorithms**
   - Support ES256 (ECDSA)
   - Allow algorithm selection

2. **Token Caching**
   - Cache tokens for same identity
   - Reduces KMS calls
   - Must consider security implications

3. **Rate Limiting**
   - Add API Gateway for sophisticated rate limiting
   - WAF rules for DDoS protection
   - Per-identity rate limits

4. **Custom Domains**
   - CloudFront distribution
   - Custom domain with SSL certificate
   - Consistent issuer URL

5. **Metrics Dashboard**
   - CloudWatch dashboard
   - Token issuance metrics
   - Error rate tracking
   - Cost monitoring

6. **Multi-Region**
   - Deploy to multiple regions
   - Route53 health checks
   - Active-active or active-passive

## Support

For issues and questions:

1. Check [README.md](./README.md) and [docs/tailscale.md](./docs/tailscale.md)
2. Review [SECURITY.md](./SECURITY.md) for security concerns
3. Search existing GitHub issues
4. Create new issue with:
   - Clear description
   - Steps to reproduce
   - Expected vs actual behavior
   - Relevant logs (sanitized)
   - Environment details

## License

MIT License - see LICENSE file for details
