/**
 * Token Exchange Lambda
 *
 * Exchanges AWS authentication for OIDC tokens.
 *
 * Flow:
 * 1. Verify incoming AWS credentials via STS GetCallerIdentity
 * 2. Extract identity claims (ARN, account, user/role info)
 * 3. Generate JWT with standard OIDC claims
 * 4. Sign JWT using KMS asymmetric key
 * 5. Return signed token
 */

import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { KMSClient, SignCommand, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import crypto from 'crypto';

const KMS_KEY_ID = process.env.KMS_KEY_ID;
const ISSUER = process.env.ISSUER; // e.g., https://your-domain.com
const TOKEN_LIFETIME_SECONDS = parseInt(process.env.TOKEN_LIFETIME_SECONDS || '3600', 10);

const stsClient = new STSClient({});
const kmsClient = new KMSClient({});

/**
 * Base64URL encoding (URL-safe base64 without padding)
 */
function base64url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Get KMS key ID for JWT header
 */
async function getKeyId() {
  const command = new GetPublicKeyCommand({ KeyId: KMS_KEY_ID });
  const response = await kmsClient.send(command);

  // Use the KeyId from response or derive from ARN
  if (response.KeyId) {
    // Extract just the key ID from ARN or full KeyId
    const parts = response.KeyId.split('/');
    return parts[parts.length - 1];
  }

  return KMS_KEY_ID;
}

/**
 * Sign data using KMS
 */
async function signWithKMS(data) {
  const command = new SignCommand({
    KeyId: KMS_KEY_ID,
    Message: data,
    MessageType: 'RAW',
    SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256'
  });

  const response = await kmsClient.send(command);
  return response.Signature;
}

/**
 * Verify AWS credentials and get caller identity
 */
async function verifyAWSCredentials(accessKeyId, secretAccessKey, sessionToken) {
  // Create a temporary STS client with provided credentials
  const tempStsClient = new STSClient({
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken
    }
  });

  const command = new GetCallerIdentityCommand({});
  const identity = await tempStsClient.send(command);

  return {
    account: identity.Account,
    arn: identity.Arn,
    userId: identity.UserId
  };
}

/**
 * Extract identity information from ARN
 */
function parseIdentity(arn, userId) {
  // ARN format: arn:aws:iam::123456789012:role/MyRole
  // or: arn:aws:sts::123456789012:assumed-role/MyRole/session-name
  const arnParts = arn.split(':');
  const service = arnParts[2]; // iam or sts
  const resourcePart = arnParts[5]; // role/MyRole or assumed-role/MyRole/session

  let resourceType = '';
  let resourceName = '';

  if (resourcePart) {
    const resourceParts = resourcePart.split('/');
    resourceType = resourceParts[0]; // role, user, assumed-role
    resourceName = resourceParts[1]; // MyRole, MyUser
  }

  return {
    service,
    resourceType,
    resourceName,
    arn,
    userId
  };
}

/**
 * Generate JWT
 */
async function generateJWT(identity, audience) {
  const now = Math.floor(Date.now() / 1000);
  const kid = await getKeyId();

  // JWT Header
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid
  };

  // Parse ARN to extract meaningful identity
  const parsedIdentity = parseIdentity(identity.arn, identity.userId);

  // JWT Claims (OIDC standard + AWS-specific)
  const claims = {
    // Standard OIDC claims
    iss: ISSUER,
    sub: identity.arn, // Subject: the AWS ARN
    aud: audience || ISSUER,
    iat: now,
    exp: now + TOKEN_LIFETIME_SECONDS,

    // AWS-specific claims
    'aws:account': identity.account,
    'aws:arn': identity.arn,
    'aws:userid': identity.userId,
    'aws:resource_type': parsedIdentity.resourceType,
    'aws:resource_name': parsedIdentity.resourceName
  };

  // Encode header and payload
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(claims));

  // Create signing input
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // Sign with KMS
  const signature = await signWithKMS(Buffer.from(signingInput, 'utf8'));
  const encodedSignature = base64url(signature);

  // Construct JWT
  return `${signingInput}.${encodedSignature}`;
}

/**
 * Parse AWS credentials from request
 */
function parseCredentials(event) {
  // Support multiple input formats:
  // 1. JSON body with credentials
  // 2. Authorization header (AWS SigV4)
  // 3. Query parameters

  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      // Not JSON, ignore
    }
  }

  // Extract credentials from body or headers
  const accessKeyId = body.access_key_id ||
                      event.headers?.['x-aws-access-key-id'];
  const secretAccessKey = body.secret_access_key ||
                          event.headers?.['x-aws-secret-access-key'];
  const sessionToken = body.session_token ||
                       event.headers?.['x-aws-session-token'];
  const audience = body.audience ||
                   event.queryStringParameters?.audience;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Missing AWS credentials');
  }

  return { accessKeyId, secretAccessKey, sessionToken, audience };
}

/**
 * Lambda handler
 */
export async function handler(event) {
  console.log('Token exchange request received', {
    path: event.rawPath,
    method: event.requestContext?.http?.method
  });

  try {
    // Parse credentials from request
    const { accessKeyId, secretAccessKey, sessionToken, audience } = parseCredentials(event);

    // Verify AWS credentials and get identity
    const identity = await verifyAWSCredentials(accessKeyId, secretAccessKey, sessionToken);

    console.log('Identity verified', {
      account: identity.account,
      arn: identity.arn
    });

    // Generate OIDC token
    const token = await generateJWT(identity, audience);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache'
      },
      body: JSON.stringify({
        access_token: token,
        token_type: 'Bearer',
        expires_in: TOKEN_LIFETIME_SECONDS
      })
    };

  } catch (error) {
    console.error('Token exchange failed', {
      error: error.message,
      stack: error.stack
    });

    // Don't leak sensitive error details
    const statusCode = error.name === 'InvalidClientTokenId' ? 401 : 500;
    return {
      statusCode,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'invalid_request',
        error_description: statusCode === 401 ? 'Invalid AWS credentials' : 'Token exchange failed'
      })
    };
  }
}
