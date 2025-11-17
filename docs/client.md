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

### Token Expiration Handling

Tokens expire after 10 minutes by default (configurable via `TOKEN_LIFETIME_SECONDS`). Unlike many OIDC systems, **there are no refresh tokens** - you simply call the token exchange endpoint again with your AWS credentials to get a new token.

#### Understanding Token Expiration

**What happens when a token expires:**
1. The JWT's `exp` claim passes the current time
2. Signature verification at the Relying Party will still succeed
3. However, the Relying Party should reject expired tokens
4. To continue accessing the service, request a new token

**Important**: Token expiration affects the **JWT validity**, not necessarily your session at the Relying Party. Some services may maintain sessions that outlive individual tokens.

#### Recommended Re-authentication Pattern

**Best Practice**: Refresh tokens proactively before they expire (around 80% of lifetime):

```bash
#!/bin/bash
# Token lifetime: 10 minutes (600 seconds)
# Refresh after 8 minutes (480 seconds) = 80% of lifetime
while true; do
  node client.js https://your-token-url/ tailscale > /tmp/token.json
  sleep 480  # 8 minutes
done
```

**Why refresh early?**
- Prevents expired token errors
- Handles network delays and retries
- Ensures smooth continuous access
- Tolerates clock skew between systems

#### Client Implementation Examples

**Node.js - Automatic Token Management:**

```javascript
class OIDCTokenManager {
  constructor(tokenUrl, audience) {
    this.tokenUrl = tokenUrl;
    this.audience = audience;
    this.token = null;
    this.expiresAt = null;
  }

  async getToken() {
    const now = Date.now();

    // Return cached token if still valid (with 20% buffer before expiration)
    if (this.token && this.expiresAt && (this.expiresAt - now > (this.expiresIn * 0.2 * 1000))) {
      return this.token;
    }

    // Fetch new token
    console.log('Fetching new OIDC token...');
    const response = await getOIDCToken(this.tokenUrl, this.audience);

    this.token = response.access_token;
    this.expiresIn = response.expires_in;
    this.expiresAt = now + (response.expires_in * 1000);

    console.log(`Token refreshed, expires in ${response.expires_in} seconds`);
    return this.token;
  }

  async getAuthHeader() {
    const token = await this.getToken();
    return `Bearer ${token}`;
  }
}

// Usage
const tokenManager = new OIDCTokenManager('https://your-token-url/', 'tailscale');

// Automatically handles expiration and refresh
setInterval(async () => {
  const authHeader = await tokenManager.getAuthHeader();
  // Use authHeader for API calls
}, 60000); // Check every minute
```

**Python - Token Caching with Expiration:**

```python
import time
import boto3
import requests
from datetime import datetime, timedelta
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

class OIDCTokenManager:
    def __init__(self, token_url, audience='tailscale', region='us-east-1'):
        self.token_url = token_url
        self.audience = audience
        self.region = region
        self.token = None
        self.expires_at = None

    def get_token(self):
        """Get token, refreshing if expired or within 20% of expiration"""
        now = datetime.now()

        # Check if we have a valid cached token (with 20% buffer)
        if self.token and self.expires_at:
            time_remaining = (self.expires_at - now).total_seconds()
            if time_remaining > (600 * 0.2):  # 600 = default token lifetime
                return self.token

        # Fetch new token
        print('Fetching new OIDC token...')
        session = boto3.Session()
        credentials = session.get_credentials()

        url = f"{self.token_url}?audience={self.audience}"
        request = AWSRequest(method='POST', url=url,
                            headers={'Host': self.token_url.split('/')[2]})
        SigV4Auth(credentials, 'lambda', self.region).add_auth(request)

        response = requests.post(url, headers=dict(request.headers))
        response.raise_for_status()

        token_data = response.json()
        self.token = token_data['access_token']
        self.expires_at = now + timedelta(seconds=token_data['expires_in'])

        print(f"Token refreshed, expires in {token_data['expires_in']} seconds")
        return self.token

    def get_auth_header(self):
        """Get Authorization header with current token"""
        token = self.get_token()
        return f"Bearer {token}"

# Usage
token_manager = OIDCTokenManager('https://your-token-url/', 'tailscale')

# Use in your application
while True:
    auth_header = token_manager.get_auth_header()
    # Use auth_header for API calls
    time.sleep(60)  # Your application logic
```

**Bash - Simple Cron-based Refresh:**

```bash
#!/bin/bash
# refresh-token.sh
# Refresh token every 8 minutes via cron

TOKEN_URL="https://your-token-url/"
AUDIENCE="tailscale"
TOKEN_FILE="/var/run/oidc-token.json"

# Fetch new token
node /path/to/client.js "$TOKEN_URL" "$AUDIENCE" > "$TOKEN_FILE.tmp"

# Atomic replace
if [ $? -eq 0 ]; then
    mv "$TOKEN_FILE.tmp" "$TOKEN_FILE"
    echo "$(date): Token refreshed successfully" >> /var/log/token-refresh.log
else
    echo "$(date): Token refresh failed" >> /var/log/token-refresh.log
    rm -f "$TOKEN_FILE.tmp"
    exit 1
fi
```

```bash
# Add to crontab: refresh every 8 minutes
*/8 * * * * /path/to/refresh-token.sh
```

**Docker Sidecar - Continuous Refresh:**

```yaml
# docker-compose.yml
version: '3.8'

services:
  token-refresher:
    image: ghcr.io/latacora/aws-oidc-token:latest
    environment:
      - AWS_ACCESS_KEY_ID
      - AWS_SECRET_ACCESS_KEY
      - AWS_REGION=${AWS_REGION:-us-east-1}
      - TOKEN_URL=https://your-token-url/
      - AUDIENCE=tailscale
      - REFRESH_INTERVAL=480  # 8 minutes
    command: >
      sh -c 'while true; do
        echo "Fetching token at $$(date)";
        node client.js $$TOKEN_URL $$AUDIENCE > /shared/token.json || echo "Failed to fetch token";
        sleep $$REFRESH_INTERVAL;
      done'
    volumes:
      - token-data:/shared

  app:
    image: your-app:latest
    volumes:
      - token-data:/shared:ro  # Read-only access to token
    depends_on:
      - token-refresher

volumes:
  token-data:
```

#### Handling Token Refresh Failures

Implement retry logic for transient failures:

```javascript
async function getTokenWithRetry(tokenUrl, audience, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await getOIDCToken(tokenUrl, audience);
    } catch (error) {
      console.error(`Token fetch attempt ${attempt} failed:`, error.message);

      if (attempt === maxRetries) {
        throw new Error(`Failed to fetch token after ${maxRetries} attempts`);
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt - 1) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
```

#### Monitoring Token Refresh

Track token refresh metrics in production:

```javascript
class MonitoredTokenManager extends OIDCTokenManager {
  constructor(tokenUrl, audience, metricsClient) {
    super(tokenUrl, audience);
    this.metricsClient = metricsClient;
    this.refreshCount = 0;
    this.errorCount = 0;
  }

  async getToken() {
    try {
      const token = await super.getToken();
      this.refreshCount++;
      this.metricsClient.increment('oidc.token.refresh.success');
      return token;
    } catch (error) {
      this.errorCount++;
      this.metricsClient.increment('oidc.token.refresh.error');
      throw error;
    }
  }

  getMetrics() {
    return {
      refreshCount: this.refreshCount,
      errorCount: this.errorCount,
      currentExpiry: this.expiresAt
    };
  }
}
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

  // Return cached token if still valid (with 2-minute buffer for 10-minute tokens)
  if (cachedToken && tokenExpiry && (tokenExpiry - now > 120000)) {
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
7. **Short-lived Tokens**: Keep default 10-minute expiry, implement proactive refresh (around 80% of lifetime)
8. **Secure Storage**: Store tokens in memory only, never write to disk unless absolutely necessary
9. **Handle Expiration Gracefully**: Implement automatic token refresh before expiration to prevent service disruptions

## Additional Resources

- [Main README](../README.md) - Deployment and architecture
- [tailscale.md](./tailscale.md) - Tailscale integration guide
- [AWS SDK Credential Provider](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
- [AWS SigV4 Signing](https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html)
