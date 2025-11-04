# Client Usage Guide

This guide explains how to use the AWS OIDC Token client to exchange AWS credentials for OIDC tokens.

## Overview

The client (`client.js`) handles AWS SigV4 authentication to request OIDC tokens from your deployed token exchange Lambda. It automatically uses AWS credentials from any standard source (environment variables, IAM roles, instance profiles, etc.).

## Installation

### Option 1: Use from Repository

```bash
# Clone the repository
git clone https://github.com/latacora/aws-oidc-workload-identity.git
cd aws-oidc-workload-identity

# Install dependencies
npm install

# Run the client
node client.js https://your-token-url/ tailscale
```

### Option 2: Install as Package

```bash
# Install dependencies globally or in your project
npm install @aws-sdk/credential-provider-node @smithy/signature-v4 @smithy/protocol-http @aws-crypto/sha256-js

# Copy client.js to your project
curl -O https://raw.githubusercontent.com/latacora/aws-oidc-workload-identity/main/client.js

# Run it
node client.js https://your-token-url/ tailscale
```

### Option 3: Use Docker Image

```bash
docker pull ghcr.io/latacora/aws-oidc-token:latest

docker run -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_REGION \
  ghcr.io/latacora/aws-oidc-token:latest \
  node client.js https://your-token-url/ tailscale
```

## Usage

### Basic Usage

```bash
node client.js <TOKEN_URL> [AUDIENCE]
```

**Arguments:**
- `TOKEN_URL` (required): The URL of your token exchange Lambda Function URL
- `AUDIENCE` (optional): The audience claim for the token (defaults to the issuer)

**Example:**
```bash
node client.js https://abc123.lambda-url.us-east-1.on.aws/ tailscale
```

**Output:**
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjEyMyJ9...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

### Environment Variables

The client respects standard AWS environment variables:

- `AWS_ACCESS_KEY_ID`: AWS access key
- `AWS_SECRET_ACCESS_KEY`: AWS secret key
- `AWS_SESSION_TOKEN`: Session token (for temporary credentials)
- `AWS_REGION`: AWS region (defaults to `us-east-1`)
- `AWS_PROFILE`: AWS CLI profile to use

**Example:**
```bash
export AWS_REGION=us-west-2
export AWS_PROFILE=production
node client.js https://your-token-url/ tailscale
```

## Authentication Methods

The client automatically discovers credentials using the AWS SDK credential provider chain:

1. **Environment Variables**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
2. **Shared Credentials File**: `~/.aws/credentials` (with `AWS_PROFILE`)
3. **ECS Container Credentials**: From `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`
4. **EC2 Instance Profile**: From EC2 instance metadata
5. **IAM Roles Anywhere**: For workloads outside AWS

No need to manually extract or provide credentials - the client handles everything.

## Integration Examples

### Shell Script

```bash
#!/bin/bash
set -e

TOKEN_URL="https://your-token-url/"
AUDIENCE="tailscale"

# Get token
RESPONSE=$(node /path/to/client.js "$TOKEN_URL" "$AUDIENCE")
TOKEN=$(echo "$RESPONSE" | jq -r '.access_token')

# Use the token
curl -H "Authorization: Bearer $TOKEN" https://api.example.com/
```

### Node.js Application

Embed the client code directly in your application:

```javascript
const { defaultProvider } = require('@aws-sdk/credential-provider-node');
const { SignatureV4 } = require('@smithy/signature-v4');
const { HttpRequest } = require('@smithy/protocol-http');
const { Sha256 } = require('@aws-crypto/sha256-js');
const https = require('https');

async function getOIDCToken(tokenUrl, audience = null) {
  const url = new URL(tokenUrl);
  if (audience) {
    url.searchParams.set('audience', audience);
  }

  const credentials = await defaultProvider()();

  const request = new HttpRequest({
    method: 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname + url.search,
    headers: {
      'host': url.hostname,
      'content-type': 'application/json'
    }
  });

  const signer = new SignatureV4({
    credentials,
    region: process.env.AWS_REGION || 'us-east-1',
    service: 'lambda',
    sha256: Sha256
  });

  const signedRequest = await signer.sign(request);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: signedRequest.hostname,
      path: signedRequest.path,
      method: signedRequest.method,
      headers: signedRequest.headers
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Usage
async function main() {
  const response = await getOIDCToken(
    'https://your-token-url/',
    'tailscale'
  );
  console.log('Token:', response.access_token);
}

main().catch(console.error);
```

### Python Application

```python
import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
import json

def get_oidc_token(token_url, audience='tailscale', region='us-east-1'):
    """Get OIDC token using AWS SigV4 authentication"""
    session = boto3.Session()
    credentials = session.get_credentials()

    # Build the request URL
    url = f"{token_url}?audience={audience}" if audience else token_url

    # Create AWS request
    request = AWSRequest(method='POST', url=url, headers={'Host': token_url.split('/')[2]})

    # Sign the request
    SigV4Auth(credentials, 'lambda', region).add_auth(request)

    # Make the request
    response = requests.post(
        url,
        headers=dict(request.headers)
    )
    response.raise_for_status()

    return response.json()

# Usage
if __name__ == '__main__':
    token_response = get_oidc_token('https://your-token-url/', 'tailscale')
    print(f"Access Token: {token_response['access_token']}")
```

### Docker Compose Sidecar

See [docker-compose.yml](./docker-compose.yml) for a complete sidecar example:

```yaml
version: '3.8'

services:
  oidc-token:
    image: ghcr.io/latacora/aws-oidc-token:latest
    environment:
      - AWS_ACCESS_KEY_ID
      - AWS_SECRET_ACCESS_KEY
      - AWS_REGION=${AWS_REGION:-us-east-1}
      - TOKEN_URL=https://your-token-url/
      - AUDIENCE=tailscale
    command: >
      sh -c 'while true; do
        node client.js $$TOKEN_URL $$AUDIENCE > /tmp/token.json;
        sleep 3000;
      done'
    volumes:
      - token-data:/tmp

  app:
    image: your-app:latest
    volumes:
      - token-data:/tmp
    depends_on:
      - oidc-token

volumes:
  token-data:
```

## IAM Permissions

The AWS principal calling the token exchange Lambda must have the following IAM permission:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "lambda:InvokeFunctionUrl",
      "Resource": "arn:aws:lambda:REGION:ACCOUNT:function:STACK-NAME-token-exchange"
    }
  ]
}
```

**Example Policy:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "lambda:InvokeFunctionUrl",
      "Resource": "arn:aws:lambda:us-east-1:123456789012:function:aws-oidc-workload-identity-token-exchange"
    }
  ]
}
```

Attach this policy to:
- IAM users
- IAM roles (for EC2, ECS, Lambda, etc.)
- Service accounts

## Troubleshooting

### Error: "Missing AWS credentials"

**Cause**: No AWS credentials found in environment or credential chain.

**Solution**:
```bash
# Option 1: Use environment variables
export AWS_ACCESS_KEY_ID=your-key
export AWS_SECRET_ACCESS_KEY=your-secret
export AWS_REGION=us-east-1

# Option 2: Use AWS CLI profile
export AWS_PROFILE=default
aws sts get-caller-identity  # Verify credentials work

# Option 3: Use IAM role (EC2/ECS/Lambda)
# Credentials are automatically available
```

### Error: "403 Forbidden"

**Cause**: IAM principal lacks `lambda:InvokeFunctionUrl` permission.

**Solution**:
1. Verify your AWS identity: `aws sts get-caller-identity`
2. Check the Lambda resource ARN matches your deployment
3. Attach the required IAM policy (see IAM Permissions section)
4. Test: `aws lambda get-function-url-config --function-name FUNCTION_NAME`

### Error: "SignatureDoesNotMatch"

**Cause**: SigV4 signature validation failed.

**Solution**:
- Ensure `AWS_REGION` matches the Lambda function region
- Verify system clock is synchronized (SigV4 is time-sensitive)
- Check that credentials haven't expired
- Verify the token URL is correct

### Error: "ENOTFOUND" or "ECONNREFUSED"

**Cause**: Cannot reach the token endpoint URL.

**Solution**:
- Verify the token URL is correct
- Check network connectivity: `curl https://your-token-url/`
- Ensure DNS resolution works
- Check VPC/firewall settings if running in private network

### Token Expiry

Tokens expire after 1 hour by default. Implement refresh logic:

```bash
#!/bin/bash
# Refresh token every 50 minutes
while true; do
  node client.js https://your-token-url/ tailscale > /tmp/token.json
  sleep 3000  # 50 minutes
done
```

## Advanced Usage

### Custom Credential Provider

```javascript
const { fromIni } = require('@aws-sdk/credential-provider-ini');

// Use specific profile
const credentials = fromIni({ profile: 'production' });

// Pass to SignatureV4
const signer = new SignatureV4({
  credentials,
  region: 'us-east-1',
  service: 'lambda',
  sha256: Sha256
});
```

### Token Caching

```javascript
let cachedToken = null;
let tokenExpiry = null;

async function getOIDCTokenCached(tokenUrl, audience) {
  const now = Date.now();

  // Return cached token if still valid (with 5-minute buffer)
  if (cachedToken && tokenExpiry && (tokenExpiry - now > 300000)) {
    return cachedToken;
  }

  // Fetch new token
  const response = await getOIDCToken(tokenUrl, audience);
  cachedToken = response;
  tokenExpiry = now + (response.expires_in * 1000);

  return cachedToken;
}
```

### Multiple Audiences

```bash
# Get tokens for different audiences
node client.js https://your-token-url/ tailscale > tailscale-token.json
node client.js https://your-token-url/ api-gateway > api-token.json
node client.js https://your-token-url/ custom-service > custom-token.json
```

### Debugging

```bash
# Enable AWS SDK debug logging
export AWS_SDK_LOG_LEVEL=debug
node client.js https://your-token-url/ tailscale

# Verify credentials
aws sts get-caller-identity

# Test Lambda access
aws lambda get-function-url-config --function-name YOUR_FUNCTION_NAME

# Decode token (without verification)
TOKEN=$(node client.js https://your-token-url/ tailscale | jq -r '.access_token')
echo $TOKEN | cut -d'.' -f2 | base64 -d | jq
```

## Security Best Practices

1. **Never Log Tokens**: Tokens are bearer credentials - treat like passwords
2. **Use IAM Roles**: Prefer IAM roles over long-lived credentials
3. **Rotate Credentials**: Regularly rotate AWS access keys
4. **Limit Permissions**: Grant only `lambda:InvokeFunctionUrl` for the specific Lambda
5. **Use HTTPS**: Always use HTTPS for token URLs
6. **Monitor Usage**: Set up CloudWatch alarms for unusual token requests
7. **Short-lived Tokens**: Keep default 1-hour expiry, implement refresh
8. **Secure Storage**: Store tokens in memory only, never write to disk

## Additional Resources

- [Main README](../README.md) - Deployment and architecture
- [tailscale.md](./tailscale.md) - Tailscale integration guide
- [AWS SDK Credential Provider](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
- [AWS SigV4 Signing](https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html)
