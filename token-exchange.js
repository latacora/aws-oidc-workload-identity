/**
 * Token Exchange Lambda
 *
 * Exchanges AWS SigV4 authenticated requests for OIDC tokens.
 *
 * Flow:
 * 1. Lambda Function URL validates SigV4 signature (automatic)
 * 2. Extract identity from requestContext.authorizer.iam
 * 3. Generate JWT with standard OIDC claims
 * 4. Sign JWT using KMS asymmetric key
 * 5. Return signed token
 *
 * No credentials are transmitted - caller signs request with AWS SigV4,
 * and Lambda runtime validates and provides identity information.
 *
 * SECURITY CRITICAL - Trust Model:
 * ===================================
 * This Lambda trusts event.requestContext.authorizer.iam as the source of truth
 * for caller identity. This is ONLY secure because:
 *
 * 1. Resource-based policy restricts lambda:InvokeFunction with condition:
 *    lambda:InvokedViaFunctionUrl: true
 *
 * 2. This means the Lambda can ONLY be invoked via Function URL, never directly
 *
 * 3. When invoked via Function URL:
 *    - AWS validates the SigV4 signature before invoking Lambda
 *    - AWS populates requestContext.authorizer.iam with verified identity
 *    - This data is trusted because AWS validated it
 *
 * 4. Direct invocation (aws lambda invoke) is blocked by IAM:
 *    - Even if attacker has valid IAM credentials
 *    - Even if attacker forges the entire event JSON
 *    - IAM policy blocks the invocation before Lambda executes
 *    - The lambda:InvokedViaFunctionUrl condition is set by AWS during
 *      authorization, before the Lambda runs, and cannot be forged
 *
 * WITHOUT the resource-based policy protection:
 * - Anyone with lambda:InvokeFunction permission could directly invoke this Lambda
 * - They could forge event.requestContext.authorizer.iam to impersonate any identity
 * - This would allow minting OIDC tokens for arbitrary AWS principals
 * - This is a CRITICAL vulnerability that bypasses all authentication
 *
 * The deploy script (deploy.sh) MUST configure this resource-based policy.
 * Verify with: aws lambda get-policy --function-name <function-name>
 */

import { KMSClient, SignCommand, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import crypto from 'crypto';

const KMS_KEY_ID = process.env.KMS_KEY_ID;
const ISSUER = process.env.ISSUER; // e.g., https://your-domain.com
const TOKEN_LIFETIME_SECONDS = parseInt(process.env.TOKEN_LIFETIME_SECONDS || '600', 10);

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
 * Extract identity from Lambda Function URL IAM auth context
 */
function extractIdentity(event) {
  const iamContext = event.requestContext?.authorizer?.iam;

  if (!iamContext) {
    throw new Error('Missing IAM authentication context. Ensure Function URL auth type is AWS_IAM.');
  }

  // Extract identity fields from IAM context
  // These are provided by Lambda after validating the SigV4 signature
  const {
    userArn,
    accountId,
    userId,
    callerId,
    accessKey,
    principalOrgId
  } = iamContext;

  if (!userArn || !accountId) {
    throw new Error('Incomplete IAM authentication context');
  }

  return {
    arn: userArn,
    account: accountId,
    userId: userId || callerId,
    accessKey,
    principalOrgId
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
 * Get audience from request
 */
function getAudience(event) {
  // Try query parameter first, then default to issuer
  return event.queryStringParameters?.audience || ISSUER;
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
    aud: audience,
    iat: now,
    exp: now + TOKEN_LIFETIME_SECONDS,

    // AWS-specific claims (from requestContext.authorizer.iam)
    'aws:account': identity.account,
    'aws:arn': identity.arn,
    'aws:userid': identity.userId,
    'aws:resource_type': parsedIdentity.resourceType,
    'aws:resource_name': parsedIdentity.resourceName
  };

  // Add optional claims if present
  if (identity.accessKey) {
    claims['aws:access_key'] = identity.accessKey;
  }

  if (identity.principalOrgId) {
    claims['aws:principal_org'] = identity.principalOrgId;
  }

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
 * Lambda handler
 */
export async function handler(event) {
  console.log('Token exchange request received', {
    path: event.rawPath,
    method: event.requestContext?.http?.method,
    hasIAMContext: !!event.requestContext?.authorizer?.iam
  });

  try {
    // Extract identity from IAM auth context
    // Lambda has already validated the SigV4 signature
    const identity = extractIdentity(event);

    console.log('Identity extracted from IAM context', {
      account: identity.account,
      arn: identity.arn
    });

    // Get audience from request
    const audience = getAudience(event);

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

    // Determine appropriate status code
    let statusCode = 500;
    let errorDescription = 'Token exchange failed';

    if (error.message.includes('Missing IAM authentication') ||
        error.message.includes('Incomplete IAM authentication')) {
      statusCode = 401;
      errorDescription = 'Missing or invalid IAM authentication. Ensure request is signed with AWS SigV4.';
    }

    return {
      statusCode,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'invalid_request',
        error_description: errorDescription
      })
    };
  }
}
