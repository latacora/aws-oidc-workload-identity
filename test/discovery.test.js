/**
 * OIDC Discovery Endpoint Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Set environment variables for testing
process.env.ISSUER = 'https://test-issuer.example.com';
process.env.JWKS_URL = 'https://test-issuer.example.com/jwks.json';

describe('OIDC Discovery Endpoint', () => {
  describe('Discovery Document Structure', () => {
    it('should return valid discovery document structure', async () => {
      const { handler } = await import('../discovery.js');

      const event = {
        rawPath: '/.well-known/openid-configuration',
        requestContext: {
          http: {
            method: 'GET'
          }
        }
      };

      const response = await handler(event);

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.headers['Content-Type'], 'application/json');

      const discoveryDoc = JSON.parse(response.body);

      // Verify required OIDC Discovery fields
      assert.strictEqual(discoveryDoc.issuer, 'https://test-issuer.example.com');
      assert.strictEqual(discoveryDoc.jwks_uri, 'https://test-issuer.example.com/jwks.json');
      assert.ok(Array.isArray(discoveryDoc.response_types_supported));
      assert.ok(Array.isArray(discoveryDoc.subject_types_supported));
      assert.ok(Array.isArray(discoveryDoc.id_token_signing_alg_values_supported));
    });

    it('should include RS256 as supported algorithm', async () => {
      const { handler } = await import('../discovery.js');

      const event = {
        rawPath: '/.well-known/openid-configuration',
        requestContext: {
          http: {
            method: 'GET'
          }
        }
      };

      const response = await handler(event);
      const discoveryDoc = JSON.parse(response.body);

      assert.ok(discoveryDoc.id_token_signing_alg_values_supported.includes('RS256'));
    });

    it('should include AWS-specific claims in claims_supported', async () => {
      const { handler } = await import('../discovery.js');

      const event = {
        rawPath: '/.well-known/openid-configuration',
        requestContext: {
          http: {
            method: 'GET'
          }
        }
      };

      const response = await handler(event);
      const discoveryDoc = JSON.parse(response.body);

      assert.ok(discoveryDoc.claims_supported.includes('aws:account'));
      assert.ok(discoveryDoc.claims_supported.includes('aws:arn'));
      assert.ok(discoveryDoc.claims_supported.includes('aws:userid'));
    });

    it('should include proper cache headers', async () => {
      const { handler } = await import('../discovery.js');

      const event = {
        rawPath: '/.well-known/openid-configuration',
        requestContext: {
          http: {
            method: 'GET'
          }
        }
      };

      const response = await handler(event);

      assert.strictEqual(response.headers['Cache-Control'], 'public, max-age=3600');
      assert.strictEqual(response.headers['Access-Control-Allow-Origin'], '*');
    });
  });
});
