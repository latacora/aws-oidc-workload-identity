#!/usr/bin/env node

/**
 * OIDC Token Client
 *
 * Fetches OIDC tokens from AWS OIDC Workload Identity service using SigV4 auth.
 *
 * Usage:
 *   node client.js <token-url> [audience]
 *
 * Example:
 *   node client.js https://abc123.lambda-url.us-east-1.on.aws/ tailscale
 *
 * The client will:
 * 1. Use AWS credentials from environment (AWS_ACCESS_KEY_ID, etc.) or IAM role
 * 2. Sign the request with SigV4
 * 3. Call the token exchange endpoint
 * 4. Return the OIDC token
 */

import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import https from 'https';
import { URL } from 'url';

/**
 * Fetch OIDC token using SigV4 authentication
 */
async function getOIDCToken(tokenUrl, audience = null) {
  // Parse the token URL
  const url = new URL(tokenUrl);

  // Add audience as query parameter if provided
  if (audience) {
    url.searchParams.set('audience', audience);
  }

  // Get AWS credentials
  const credentials = await defaultProvider()();

  // Create HTTP request
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

  // Sign the request with SigV4
  const signer = new SignatureV4({
    credentials,
    region: process.env.AWS_REGION || 'us-east-1',
    service: 'lambda',
    sha256: Sha256
  });

  const signedRequest = await signer.sign(request);

  // Make the HTTP request
  return new Promise((resolve, reject) => {
    const options = {
      hostname: signedRequest.hostname,
      port: signedRequest.port || 443,
      path: signedRequest.path,
      method: signedRequest.method,
      headers: signedRequest.headers
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const response = JSON.parse(data);
            resolve(response);
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });

    req.end();
  });
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const tokenUrl = process.argv[2];
  const audience = process.argv[3];

  if (!tokenUrl) {
    console.error('Usage: node client.js <token-url> [audience]');
    console.error('');
    console.error('Example:');
    console.error('  node client.js https://abc123.lambda-url.us-east-1.on.aws/ tailscale');
    console.error('');
    console.error('AWS credentials will be loaded from:');
    console.error('  - Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)');
    console.error('  - IAM role (if running on EC2, ECS, Lambda, etc.)');
    console.error('  - ~/.aws/credentials file');
    process.exit(1);
  }

  getOIDCToken(tokenUrl, audience)
    .then((response) => {
      console.log('✅ Successfully obtained OIDC token');
      console.log('');
      console.log('Token:', response.access_token);
      console.log('Type:', response.token_type);
      console.log('Expires in:', response.expires_in, 'seconds');
      console.log('');
      console.log('To use with Tailscale:');
      console.log(`  tailscale up --auth-key=oauth:${response.access_token}`);
    })
    .catch((error) => {
      console.error('❌ Failed to obtain OIDC token');
      console.error('');
      console.error('Error:', error.message);
      console.error('');
      console.error('Troubleshooting:');
      console.error('  - Verify AWS credentials are configured');
      console.error('  - Check that you have lambda:InvokeFunctionUrl permission');
      console.error('  - Ensure the token URL is correct');
      console.error('  - Verify the Lambda Function URL uses AWS_IAM auth');
      process.exit(1);
    });
}

export { getOIDCToken };
