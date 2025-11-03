/**
 * JWKS Lambda Tests
 *
 * Tests for JWKS endpoint and public key exposure.
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';

// Mock AWS SDK clients
const mockKMSClient = {
  send: mock.fn()
};

// Mock the AWS SDK imports
mock.module('@aws-sdk/client-kms', {
  namedExports: {
    KMSClient: mock.fn(() => mockKMSClient),
    GetPublicKeyCommand: mock.fn((input) => ({ input }))
  }
});

// Set environment variables
process.env.KMS_KEY_ID = 'test-key-id';

// Generate a test RSA key pair for testing
function generateTestKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'der'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });
}

describe('JWKS Lambda', () => {
  let testKeyPair;

  beforeEach(() => {
    // Reset mocks before each test
    mockKMSClient.send.mock.resetCalls();

    // Generate fresh test key pair
    testKeyPair = generateTestKeyPair();
  });

  describe('JWKS Response', () => {
    it('should return valid JWKS structure', async () => {
      // Mock KMS GetPublicKey
      mockKMSClient.send.mock.mockImplementation(() => {
        return Promise.resolve({
          KeyId: 'arn:aws:kms:us-east-1:123456789012:key/test-key-id',
          PublicKey: testKeyPair.publicKey
        });
      });

      // Import handler after mocks are set up
      const { handler } = await import('../jwks.js');

      const event = {
        headers: {},
        requestContext: {
          http: { method: 'GET' }
        },
        rawPath: '/.well-known/jwks.json'
      };

      const response = await handler(event);

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.headers['Content-Type'], 'application/json');

      const jwks = JSON.parse(response.body);

      // Verify JWKS structure
      assert.ok(jwks.keys);
      assert.ok(Array.isArray(jwks.keys));
      assert.strictEqual(jwks.keys.length, 1);

      const jwk = jwks.keys[0];

      // Verify JWK required fields
      assert.strictEqual(jwk.kty, 'RSA');
      assert.strictEqual(jwk.use, 'sig');
      assert.strictEqual(jwk.alg, 'RS256');
      assert.ok(jwk.kid);
      assert.ok(jwk.n); // RSA modulus
      assert.ok(jwk.e); // RSA exponent
    });

    it('should include proper cache headers', async () => {
      mockKMSClient.send.mock.mockImplementation(() => {
        return Promise.resolve({
          KeyId: 'test-key-id',
          PublicKey: testKeyPair.publicKey
        });
      });

      const { handler } = await import('../jwks.js');

      const event = {
        headers: {},
        requestContext: { http: { method: 'GET' } },
        rawPath: '/.well-known/jwks.json'
      };

      const response = await handler(event);

      assert.strictEqual(response.headers['Cache-Control'], 'public, max-age=3600');
      assert.strictEqual(response.headers['Access-Control-Allow-Origin'], '*');
    });
  });

  describe('Public Key Conversion', () => {
    it('should correctly convert DER to JWK', async () => {
      mockKMSClient.send.mock.mockImplementation(() => {
        return Promise.resolve({
          KeyId: 'test-key-id',
          PublicKey: testKeyPair.publicKey
        });
      });

      const { handler } = await import('../jwks.js');

      const event = {
        headers: {},
        requestContext: { http: { method: 'GET' } },
        rawPath: '/.well-known/jwks.json'
      };

      const response = await handler(event);
      const jwks = JSON.parse(response.body);
      const jwk = jwks.keys[0];

      // Reconstruct public key from JWK
      const reconstructedKey = crypto.createPublicKey({
        key: {
          kty: jwk.kty,
          n: jwk.n,
          e: jwk.e
        },
        format: 'jwk'
      });

      // Verify we can use the key for verification
      const testData = Buffer.from('test data');
      const originalKey = crypto.createPublicKey({
        key: testKeyPair.publicKey,
        format: 'der',
        type: 'spki'
      });

      // Export both keys and compare
      const originalPEM = originalKey.export({ type: 'spki', format: 'pem' });
      const reconstructedPEM = reconstructedKey.export({ type: 'spki', format: 'pem' });

      assert.strictEqual(originalPEM, reconstructedPEM);
    });
  });

  describe('Key ID Extraction', () => {
    it('should extract key ID from ARN', async () => {
      mockKMSClient.send.mock.mockImplementation(() => {
        return Promise.resolve({
          KeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc-123-def',
          PublicKey: testKeyPair.publicKey
        });
      });

      const { handler } = await import('../jwks.js');

      const event = {
        headers: {},
        requestContext: { http: { method: 'GET' } },
        rawPath: '/.well-known/jwks.json'
      };

      const response = await handler(event);
      const jwks = JSON.parse(response.body);

      assert.strictEqual(jwks.keys[0].kid, 'abc-123-def');
    });

    it('should use provided key ID if ARN not available', async () => {
      mockKMSClient.send.mock.mockImplementation(() => {
        return Promise.resolve({
          KeyId: null,
          PublicKey: testKeyPair.publicKey
        });
      });

      const { handler } = await import('../jwks.js');

      const event = {
        headers: {},
        requestContext: { http: { method: 'GET' } },
        rawPath: '/.well-known/jwks.json'
      };

      const response = await handler(event);
      const jwks = JSON.parse(response.body);

      assert.strictEqual(jwks.keys[0].kid, 'test-key-id');
    });
  });

  describe('Error Handling', () => {
    it('should handle KMS errors gracefully', async () => {
      mockKMSClient.send.mock.mockImplementation(() => {
        throw new Error('KMS service unavailable');
      });

      const { handler } = await import('../jwks.js');

      const event = {
        headers: {},
        requestContext: { http: { method: 'GET' } },
        rawPath: '/.well-known/jwks.json'
      };

      const response = await handler(event);

      assert.strictEqual(response.statusCode, 500);
      const body = JSON.parse(response.body);
      assert.strictEqual(body.error, 'internal_error');
    });
  });

  describe('Caching', () => {
    it('should cache JWKS response', async () => {
      let callCount = 0;
      mockKMSClient.send.mock.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          KeyId: 'test-key-id',
          PublicKey: testKeyPair.publicKey
        });
      });

      const { handler } = await import('../jwks.js');

      const event = {
        headers: {},
        requestContext: { http: { method: 'GET' } },
        rawPath: '/.well-known/jwks.json'
      };

      // First request
      await handler(event);
      assert.strictEqual(callCount, 1);

      // Second request (should use cache)
      await handler(event);
      assert.strictEqual(callCount, 1, 'Should not call KMS again due to cache');

      // Third request (should still use cache)
      await handler(event);
      assert.strictEqual(callCount, 1, 'Should still use cached value');
    });
  });
});
