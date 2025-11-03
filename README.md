# AWS OIDC Workload Identity

Exchange AWS authentication for OIDC tokens using KMS-backed signing.

## ⚠️ Experimental - Unreviewed Code

**This project is experimental and has not undergone security review.** It is provided as a proof-of-concept implementation for exchanging AWS credentials for OIDC tokens. Before using in production:

- Conduct a thorough security review
- Test extensively in a non-production environment
- Understand the security implications (see [SECURITY.md](./SECURITY.md))
- Review open issues, particularly around token lifetime behavior (see issues)

Use at your own risk. This is not production-ready software.

## Overview

AWS provides a mechanism to exchange OIDC tokens for temporary AWS credentials (via `AssumeRoleWithWebIdentity`), but not the reverse: exchanging AWS credentials for OIDC tokens that external services can verify.

This project implements a minimal, secure solution for AWS-to-OIDC token exchange using:
- **AWS KMS** for cryptographic signing (private key never leaves AWS)
- **AWS Lambda** with Function URLs for serverless endpoints
- **AWS STS** for credential verification

This enables AWS workloads to authenticate with services that require OIDC tokens, such as [Tailscale Workload Identity](https://tailscale.com/blog/workload-identity-beta).

## Architecture

### High-Level Architecture

```mermaid
graph TB
    A[AWS Credentials] -->|STS Verify| B[Token Exchange Lambda]
    B -->|Sign JWT| C[KMS]
    C -->|Signature| B
    B -->|Return| D[OIDC Token JWT]
    D -->|Authenticate| E[OIDC Consumer<br/>e.g. Tailscale]
    E -->|Verify Token| F[JWKS Lambda]
    F -->|Get Public Key| C
    F -->|Return JWKS| E
```

### Token Exchange Flow

```mermaid
sequenceDiagram
    participant Client as AWS Workload
    participant TokenLambda as Token Exchange Lambda
    participant STS as AWS STS
    participant KMS as AWS KMS
    participant Consumer as OIDC Consumer<br/>(e.g. Tailscale)
    participant JWKSLambda as JWKS Lambda

    Note over Client,Consumer: Token Generation
    Client->>TokenLambda: POST /token<br/>{access_key, secret_key, session_token}
    TokenLambda->>STS: GetCallerIdentity(credentials)
    STS-->>TokenLambda: {Account, ARN, UserId}
    TokenLambda->>TokenLambda: Build JWT claims
    TokenLambda->>KMS: Sign(JWT header + payload)
    KMS-->>TokenLambda: Signature
    TokenLambda-->>Client: OIDC Token (JWT)

    Note over Client,Consumer: Token Verification
    Client->>Consumer: Authenticate with token
    Consumer->>JWKSLambda: GET /.well-known/jwks.json
    JWKSLambda->>KMS: GetPublicKey()
    KMS-->>JWKSLambda: Public key (DER)
    JWKSLambda-->>Consumer: JWKS (JSON)
    Consumer->>Consumer: Verify token signature<br/>Validate claims
    Consumer-->>Client: Access granted
```

### Components

1. **KMS Asymmetric Key** (`RSA_2048`)
   - Signs OIDC tokens
   - Private key never leaves KMS
   - Public key exposed via JWKS endpoint

2. **Token Exchange Lambda** (`/token` endpoint)
   - Accepts AWS credentials (access key, secret key, optional session token)
   - Verifies credentials via STS `GetCallerIdentity`
   - Generates JWT with standard OIDC claims
   - Signs JWT using KMS
   - Returns OIDC-compliant token

3. **JWKS Lambda** (`/.well-known/jwks.json` endpoint)
   - Exposes KMS public key in JWKS format
   - Used by OIDC consumers to verify tokens
   - Cached for performance

## Security Properties

- **Cryptographic Security**: Uses AWS KMS with RSA-2048, preventing private key exposure
- **Identity Verification**: All AWS credentials are verified via STS before token issuance
- **Short-lived Tokens**: Default 1-hour lifetime (configurable)
- **Immutable Audit Trail**: All operations logged to CloudWatch
- **No Stored Secrets**: Everything derives from AWS IAM and KMS
- **Tamper-proof**: JWT signatures cryptographically prevent token modification

## Deployment

### Prerequisites

- AWS CLI configured with appropriate credentials
- Bash shell
- Node.js 20+ (for local testing)
- Permissions to create: KMS keys, Lambda functions, IAM roles

### Quick Start

```bash
# Set your issuer URL (this will be in the token 'iss' claim)
export ISSUER="https://your-domain.com"

# Optional: customize stack name and region
export STACK_NAME="aws-oidc-workload-identity"
export AWS_REGION="us-east-1"

# Deploy
./deploy.sh
```

The deployment script will:
1. Create a KMS asymmetric signing key
2. Create IAM role with necessary permissions
3. Package and deploy Lambda functions
4. Create Lambda Function URLs
5. Output endpoints for token exchange and JWKS

### Post-Deployment

After deployment, you'll receive two URLs:

```
Token Endpoint: https://abc123.lambda-url.us-east-1.on.aws/
JWKS Endpoint: https://xyz789.lambda-url.us-east-1.on.aws/
```

**Important**: The `ISSUER` environment variable should typically match your token endpoint URL. You may want to:
1. Use a custom domain with CloudFront/API Gateway pointing to these Lambda URLs
2. Update the issuer to match: `export ISSUER=https://your-token-url/` and redeploy

## Usage

### Requesting a Token

```bash
# Using AWS credentials
curl -X POST https://your-token-url/ \
  -H "Content-Type: application/json" \
  -d '{
    "access_key_id": "AKIAIOSFODNN7EXAMPLE",
    "secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "session_token": "optional-session-token",
    "audience": "optional-audience"
  }'
```

Response:
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6I...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

### Token Claims

The generated JWT includes:

**Standard OIDC Claims:**
- `iss`: Issuer (your configured ISSUER)
- `sub`: Subject (AWS ARN)
- `aud`: Audience (from request or defaults to issuer)
- `iat`: Issued at timestamp
- `exp`: Expiration timestamp

**AWS-Specific Claims:**
- `aws:account`: AWS Account ID
- `aws:arn`: Full AWS ARN
- `aws:userid`: AWS User ID
- `aws:resource_type`: Type (role, user, assumed-role)
- `aws:resource_name`: Resource name

### Verifying Tokens

OIDC consumers can verify tokens using the JWKS endpoint:

```bash
curl https://your-jwks-url/
```

Response:
```json
{
  "keys": [
    {
      "kty": "RSA",
      "use": "sig",
      "alg": "RS256",
      "kid": "abc-123-def",
      "n": "...",
      "e": "AQAB"
    }
  ]
}
```

## Integration with Tailscale

See [TAILSCALE.md](./TAILSCALE.md) for detailed instructions on integrating with Tailscale Workload Identity.

Quick summary:
1. Deploy this solution
2. Configure Tailscale with your OIDC issuer and JWKS URL
3. Use the token endpoint to exchange AWS credentials for OIDC tokens
4. Present tokens to Tailscale for workload authentication

## Testing

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

The test suite includes:
- Unit tests for token generation
- Unit tests for JWKS endpoint
- Integration tests for end-to-end flow
- Security tests for token tampering
- OIDC compliance tests

## Configuration

Environment variables for Lambda functions:

### Token Exchange Lambda

- `KMS_KEY_ID`: KMS key ID or ARN (set by deployment)
- `ISSUER`: Token issuer URL (set by deployment)
- `TOKEN_LIFETIME_SECONDS`: Token lifetime in seconds (default: 3600)

### JWKS Lambda

- `KMS_KEY_ID`: KMS key ID or ARN (set by deployment)

## Cost Considerations

This solution uses serverless components with pay-per-use pricing:

- **Lambda**: Free tier includes 1M requests/month
- **KMS**: $1/month per key + $0.03 per 10,000 signing operations
- **CloudWatch Logs**: Minimal costs for logging

Estimated monthly cost for moderate usage (10k tokens/month): **~$1-2**

## Security Considerations

### Threat Model

**Protected Against:**
- Private key exposure (KMS stores keys in HSMs)
- Token tampering (cryptographic signatures)
- Invalid credential use (STS verification)
- Replay attacks (short token lifetime + unique `iat`)

**Not Protected Against:**
- Credential theft (if AWS credentials are stolen, attacker can get tokens)
- OIDC consumer compromise (tokens are valid if consumer is compromised)
- Token interception (use HTTPS for all communications)

### Best Practices

1. **Use Short-Lived Tokens**: Default 1 hour is recommended
2. **Restrict IAM Permissions**: Only allow necessary principals to invoke Lambda
3. **Enable CloudWatch Alarms**: Monitor for unusual token issuance patterns
4. **Rotate KMS Keys**: Periodically rotate KMS keys (requires redeployment)
5. **Use Custom Domains**: Hide Lambda URLs behind CloudFront with WAF
6. **Restrict JWKS Access**: While public, consider rate limiting
7. **Audit Token Claims**: Review what information is included in tokens

### Known Limitations

1. **Not a Hosted Service**: You must operate and monitor this infrastructure
2. **Lambda Cold Starts**: First request after idle period may be slower (~1-2s)
3. **No Token Revocation**: Tokens are valid until expiration (no revocation list)
4. **No Refresh Tokens**: Tokens must be reissued after expiration
5. **Limited Rate Limiting**: Lambda Function URLs have basic throttling but no sophisticated rate limiting
6. **Token Lifetime Semantics Unclear**: The relationship between OIDC token lifetime and resulting credential lifetime in consumer systems is not well-defined (see issue #1)

## Cleanup

```bash
./destroy.sh
```

This will:
1. Delete Lambda functions and Function URLs
2. Delete IAM role and policies
3. Schedule KMS key deletion (7-day waiting period)
4. Clean up local deployment artifacts

**Note**: KMS keys have a mandatory 7-30 day waiting period before deletion. To cancel:

```bash
aws kms cancel-key-deletion --key-id YOUR_KEY_ID --region us-east-1
```

## Troubleshooting

### Token Exchange Fails with 401

- Verify AWS credentials are valid: `aws sts get-caller-identity`
- Check CloudWatch logs for the token exchange Lambda

### Token Verification Fails

- Ensure JWKS URL is accessible
- Verify token hasn't expired
- Check that the `kid` in token header matches JWKS
- Confirm token hasn't been modified

### Deployment Fails

- Verify IAM permissions for deployment user
- Check AWS service quotas (Lambda functions, KMS keys)
- Review CloudFormation/deployment logs

## Contributing

Contributions welcome! This is a minimal implementation and can be extended:

- Add API Gateway for better rate limiting and logging
- Implement token caching to reduce KMS calls
- Add CloudFront distribution for custom domains
- Support additional signing algorithms (ES256, etc.)
- Add metrics and monitoring dashboards

## License

MIT

## Acknowledgments

- Inspired by [Tailscale Workload Identity](https://tailscale.com/blog/workload-identity-beta)
- Uses the S3 pre-signed URL technique for AWS identity verification
- Built with minimal dependencies for security and maintainability
