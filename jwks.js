/**
 * JWKS (JSON Web Key Set) Lambda
 *
 * Exposes the public key from KMS in JWKS format.
 * This endpoint is used by OIDC consumers (like Tailscale) to verify tokens.
 *
 * Standard JWKS endpoint: /.well-known/jwks.json
 */

import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import crypto from 'crypto';

const KMS_KEY_ID = process.env.KMS_KEY_ID;

const kmsClient = new KMSClient({});

// Cache the JWKS response for 1 hour
let cachedJWKS = null;
let cacheTimestamp = 0;
const CACHE_TTL = 3600 * 1000; // 1 hour in milliseconds

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
 * Convert DER-encoded public key to JWK format
 */
function publicKeyToJWK(publicKeyDER, keyId) {
  // Parse the DER-encoded public key
  const publicKey = crypto.createPublicKey({
    key: publicKeyDER,
    format: 'der',
    type: 'spki'
  });

  // Export as JWK
  const jwk = publicKey.export({ format: 'jwk' });

  // Add required JWKS fields
  return {
    kty: jwk.kty, // Key Type (RSA)
    use: 'sig', // Public key use (signature)
    alg: 'RS256', // Algorithm
    kid: keyId, // Key ID
    n: jwk.n, // Modulus
    e: jwk.e // Exponent
  };
}

/**
 * Get JWKS from KMS
 */
async function getJWKS() {
  // Check cache
  const now = Date.now();
  if (cachedJWKS && (now - cacheTimestamp) < CACHE_TTL) {
    console.log('Returning cached JWKS');
    return cachedJWKS;
  }

  console.log('Fetching public key from KMS');

  // Get public key from KMS
  const command = new GetPublicKeyCommand({ KeyId: KMS_KEY_ID });
  const response = await kmsClient.send(command);

  // Extract key ID from ARN or use provided KeyId
  let keyId = KMS_KEY_ID;
  if (response.KeyId) {
    const parts = response.KeyId.split('/');
    keyId = parts[parts.length - 1];
  }

  // Convert to JWK
  const jwk = publicKeyToJWK(response.PublicKey, keyId);

  // Construct JWKS
  const jwks = {
    keys: [jwk]
  };

  // Update cache
  cachedJWKS = jwks;
  cacheTimestamp = now;

  return jwks;
}

/**
 * Lambda handler
 */
export async function handler(event) {
  console.log('JWKS request received', {
    path: event.rawPath,
    method: event.requestContext?.http?.method
  });

  try {
    const jwks = await getJWKS();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
        'Access-Control-Allow-Origin': '*' // JWKS should be publicly accessible
      },
      body: JSON.stringify(jwks)
    };

  } catch (error) {
    console.error('JWKS fetch failed', {
      error: error.message,
      stack: error.stack
    });

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'internal_error',
        error_description: 'Failed to fetch JWKS'
      })
    };
  }
}
