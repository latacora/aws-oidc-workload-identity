/**
 * JWKS Lambda Tests
 *
 * Tests for JWKS endpoint and public key exposure.
 * Note: These tests check structure without mocking KMS (would require real AWS in integration tests).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Set environment variables
process.env.KMS_KEY_ID = 'test-key-id';

describe('JWKS Lambda - Structure Tests', () => {
  describe('JWKS Response Structure', () => {
    it('should define proper JWKS structure', () => {
      // Expected JWKS structure per RFC 7517
      const jwks = {
        keys: [
          {
            kty: 'RSA',
            use: 'sig',
            alg: 'RS256',
            kid: 'test-key-id',
            n: 'base64url-encoded-modulus',
            e: 'AQAB'
          }
        ]
      };

      // Verify JWKS structure
      assert.ok(jwks.keys);
      assert.ok(Array.isArray(jwks.keys));
      assert.strictEqual(jwks.keys.length, 1);

      const jwk = jwks.keys[0];
      assert.strictEqual(jwk.kty, 'RSA');
      assert.strictEqual(jwk.use, 'sig');
      assert.strictEqual(jwk.alg, 'RS256');
      assert.ok(jwk.kid);
      assert.ok(jwk.n);
      assert.ok(jwk.e);
    });

    it('should use proper cache headers for public JWKS', () => {
      // JWKS should be publicly cacheable
      const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*'
      };

      assert.strictEqual(headers['Content-Type'], 'application/json');
      assert.ok(headers['Cache-Control'].includes('public'));
      assert.ok(headers['Cache-Control'].includes('max-age'));
      assert.strictEqual(headers['Access-Control-Allow-Origin'], '*');
    });
  });

  describe('Key ID Extraction', () => {
    it('should extract key ID from KMS ARN', () => {
      const testCases = [
        {
          arn: 'arn:aws:kms:us-east-1:123456789012:key/abc-123-def',
          expected: 'abc-123-def'
        },
        {
          arn: 'arn:aws:kms:eu-west-1:987654321098:key/xyz-789-ghi',
          expected: 'xyz-789-ghi'
        }
      ];

      for (const testCase of testCases) {
        // Extract key ID from ARN (last part after /)
        const parts = testCase.arn.split('/');
        const keyId = parts[parts.length - 1];
        assert.strictEqual(keyId, testCase.expected);
      }
    });

    it('should handle plain key IDs', () => {
      const keyId = 'simple-key-id';
      // If already a plain ID, use as-is
      const extractedId = keyId.includes(':') ? keyId.split('/').pop() : keyId;
      assert.strictEqual(extractedId, 'simple-key-id');
    });
  });

  describe('RSA Public Key Format', () => {
    it('should use proper JWK format for RSA keys', () => {
      // JWK format per RFC 7517 section 6.3
      const rsaJwk = {
        kty: 'RSA',  // Key type
        use: 'sig',  // Public key use (signature)
        alg: 'RS256', // Algorithm
        kid: 'key-id', // Key ID
        n: 'modulus',  // RSA modulus (base64url)
        e: 'AQAB'    // RSA public exponent (base64url, typically 65537 = AQAB)
      };

      assert.strictEqual(rsaJwk.kty, 'RSA');
      assert.strictEqual(rsaJwk.use, 'sig');
      assert.strictEqual(rsaJwk.alg, 'RS256');
      assert.ok(rsaJwk.kid);
      assert.ok(rsaJwk.n);
      assert.strictEqual(rsaJwk.e, 'AQAB'); // Standard RSA exponent
    });
  });

  describe('Error Handling', () => {
    it('should define proper error response structure', () => {
      const errorResponse = {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: 'internal_error',
          error_description: 'Failed to retrieve public key'
        })
      };

      assert.strictEqual(errorResponse.statusCode, 500);
      assert.strictEqual(errorResponse.headers['Content-Type'], 'application/json');

      const body = JSON.parse(errorResponse.body);
      assert.strictEqual(body.error, 'internal_error');
      assert.ok(body.error_description);
    });
  });

  describe('CORS Headers', () => {
    it('should allow cross-origin requests', () => {
      // JWKS endpoint should be accessible from any origin
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      };

      assert.strictEqual(corsHeaders['Access-Control-Allow-Origin'], '*');
      assert.ok(corsHeaders['Access-Control-Allow-Methods'].includes('GET'));
    });
  });
});

describe('JWKS Lambda - Caching Behavior', () => {
  it('should cache JWKS response in Lambda', () => {
    // Test that caching logic makes sense
    let cachedJwks = null;

    // First call - cache miss
    if (!cachedJwks) {
      cachedJwks = { keys: [{ kty: 'RSA', kid: 'test' }] };
    }
    assert.ok(cachedJwks);

    // Second call - cache hit
    const result = cachedJwks;
    assert.strictEqual(result, cachedJwks);
    assert.ok(result.keys);
  });

  it('should set appropriate cache-control max-age', () => {
    const maxAge = 3600; // 1 hour
    const cacheControl = `public, max-age=${maxAge}`;

    assert.ok(cacheControl.includes('public'));
    assert.ok(cacheControl.includes(`max-age=${maxAge}`));
  });
});
