/**
 * OIDC Discovery Lambda
 *
 * Implements the OIDC Discovery endpoint at /.well-known/openid-configuration
 *
 * This endpoint allows OIDC consumers to discover:
 * - The issuer URL
 * - The JWKS URI for token verification
 * - Supported algorithms and token types
 *
 * Reference: https://openid.net/specs/openid-connect-discovery-1_0.html
 */

const ISSUER = process.env.ISSUER;
const JWKS_URL = process.env.JWKS_URL;

// Cache the discovery document
let cachedDiscoveryDoc = null;

/**
 * Generate OIDC Discovery Document
 */
function getDiscoveryDocument() {
  if (cachedDiscoveryDoc) {
    return cachedDiscoveryDoc;
  }

  // Standard OIDC Discovery document
  // Only including fields relevant for workload identity
  cachedDiscoveryDoc = {
    issuer: ISSUER,
    jwks_uri: JWKS_URL,

    // We only support ID tokens for workload identity
    response_types_supported: ['id_token'],

    // Subject identifier types
    subject_types_supported: ['public'],

    // Signing algorithms supported
    id_token_signing_alg_values_supported: ['RS256'],

    // Claims supported in tokens
    claims_supported: [
      'iss',
      'sub',
      'aud',
      'iat',
      'exp',
      'aws:account',
      'aws:arn',
      'aws:userid',
      'aws:resource_type',
      'aws:resource_name',
      'aws:access_key',
      'aws:principal_org'
    ],

    // Token endpoint (for completeness, though we use Function URL directly)
    token_endpoint: ISSUER
  };

  return cachedDiscoveryDoc;
}

/**
 * Lambda handler
 */
export async function handler(event) {
  console.log('OIDC Discovery request received', {
    path: event.rawPath,
    method: event.requestContext?.http?.method
  });

  try {
    const discoveryDoc = getDiscoveryDocument();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(discoveryDoc)
    };

  } catch (error) {
    console.error('Discovery endpoint failed', {
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
        error_description: 'Failed to generate discovery document'
      })
    };
  }
}
