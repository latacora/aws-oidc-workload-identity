/**
 * Token Exchange Lambda Tests
 *
 * Security-critical tests for token generation and validation.
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';

// Mock AWS SDK clients
const mockSTSClient = {
  send: mock.fn()
};

const mockKMSClient = {
  send: mock.fn()
};

// Mock the AWS SDK imports
mock.module('@aws-sdk/client-sts', {
  namedExports: {
    STSClient: mock.fn(() => mockSTSClient),
    GetCallerIdentityCommand: mock.fn((input) => ({ input }))
  }
});

mock.module('@aws-sdk/client-kms', {
  namedExports: {
    KMSClient: mock.fn(() => mockKMSClient),
    SignCommand: mock.fn((input) => ({ input })),
    GetPublicKeyCommand: mock.fn((input) => ({ input }))
  }
});

// Set environment variables
process.env.KMS_KEY_ID = 'test-key-id';
process.env.ISSUER = 'https://test-issuer.example.com';
process.env.TOKEN_LIFETIME_SECONDS = '3600';

describe('Token Exchange Lambda', () => {
  beforeEach(() => {
    // Reset mocks before each test
    mockSTSClient.send.mock.resetCalls();
    mockKMSClient.send.mock.resetCalls();
  });

  describe('JWT Generation', () => {
    it('should generate valid JWT structure', async () => {
      // Mock KMS responses
      mockKMSClient.send.mock.mockImplementation((command) => {
        if (command.input.KeyId === 'test-key-id' && command.input.Message) {
          // Mock Sign command
          return Promise.resolve({
            Signature: crypto.randomBytes(256) // Mock RSA signature
          });
        } else {
          // Mock GetPublicKey command
          return Promise.resolve({
            KeyId: 'arn:aws:kms:us-east-1:123456789012:key/test-key-id'
          });
        }
      });

      // Mock STS GetCallerIdentity
      mockSTSClient.send.mock.mockImplementation(() => {
        return Promise.resolve({
          Account: '123456789012',
          Arn: 'arn:aws:iam::123456789012:role/TestRole',
          UserId: 'AIDACKCEVSQ6C2EXAMPLE'
        });
      });

      // Import handler after mocks are set up
      const { handler } = await import('../token-exchange.js');

      const event = {
        body: JSON.stringify({
          access_key_id: 'AKIAIOSFODNN7EXAMPLE',
          secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          audience: 'test-audience'
        }),
        headers: {},
        requestContext: {
          http: { method: 'POST' }
        },
        rawPath: '/token'
      };

      const response = await handler(event);

      assert.strictEqual(response.statusCode, 200);

      const body = JSON.parse(response.body);
      assert.ok(body.access_token);
      assert.strictEqual(body.token_type, 'Bearer');
      assert.strictEqual(body.expires_in, 3600);

      // Verify JWT structure (header.payload.signature)
      const parts = body.access_token.split('.');
      assert.strictEqual(parts.length, 3);

      // Decode and verify header
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      assert.strictEqual(header.alg, 'RS256');
      assert.strictEqual(header.typ, 'JWT');
      assert.ok(header.kid);

      // Decode and verify payload
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      assert.strictEqual(payload.iss, 'https://test-issuer.example.com');
      assert.strictEqual(payload.sub, 'arn:aws:iam::123456789012:role/TestRole');
      assert.strictEqual(payload.aud, 'test-audience');
      assert.strictEqual(payload['aws:account'], '123456789012');
      assert.strictEqual(payload['aws:arn'], 'arn:aws:iam::123456789012:role/TestRole');
      assert.ok(payload.iat);
      assert.ok(payload.exp);
      assert.ok(payload.exp > payload.iat);
    });

    it('should include correct AWS identity claims', async () => {
      mockKMSClient.send.mock.mockImplementation((command) => {
        if (command.input.KeyId === 'test-key-id' && command.input.Message) {
          return Promise.resolve({
            Signature: crypto.randomBytes(256)
          });
        } else {
          return Promise.resolve({
            KeyId: 'arn:aws:kms:us-east-1:123456789012:key/test-key-id'
          });
        }
      });

      mockSTSClient.send.mock.mockImplementation(() => {
        return Promise.resolve({
          Account: '123456789012',
          Arn: 'arn:aws:sts::123456789012:assumed-role/MyRole/session-name',
          UserId: 'AROACKCEVSQ6C2EXAMPLE:session-name'
        });
      });

      const { handler } = await import('../token-exchange.js');

      const event = {
        body: JSON.stringify({
          access_key_id: 'AKIAIOSFODNN7EXAMPLE',
          secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          session_token: 'SESSION_TOKEN'
        }),
        headers: {},
        requestContext: { http: { method: 'POST' } },
        rawPath: '/token'
      };

      const response = await handler(event);
      const body = JSON.parse(response.body);
      const parts = body.access_token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

      assert.strictEqual(payload['aws:resource_type'], 'assumed-role');
      assert.strictEqual(payload['aws:resource_name'], 'MyRole');
      assert.strictEqual(payload['aws:userid'], 'AROACKCEVSQ6C2EXAMPLE:session-name');
    });
  });

  describe('Credential Validation', () => {
    it('should reject missing credentials', async () => {
      const { handler } = await import('../token-exchange.js');

      const event = {
        body: JSON.stringify({}),
        headers: {},
        requestContext: { http: { method: 'POST' } },
        rawPath: '/token'
      };

      const response = await handler(event);

      assert.strictEqual(response.statusCode, 500);
      const body = JSON.parse(response.body);
      assert.strictEqual(body.error, 'invalid_request');
    });

    it('should reject invalid AWS credentials', async () => {
      mockSTSClient.send.mock.mockImplementation(() => {
        const error = new Error('The security token included in the request is invalid');
        error.name = 'InvalidClientTokenId';
        throw error;
      });

      const { handler } = await import('../token-exchange.js');

      const event = {
        body: JSON.stringify({
          access_key_id: 'INVALID',
          secret_access_key: 'INVALID'
        }),
        headers: {},
        requestContext: { http: { method: 'POST' } },
        rawPath: '/token'
      };

      const response = await handler(event);

      assert.strictEqual(response.statusCode, 401);
      const body = JSON.parse(response.body);
      assert.strictEqual(body.error, 'invalid_request');
      assert.strictEqual(body.error_description, 'Invalid AWS credentials');
    });
  });

  describe('Token Lifetime', () => {
    it('should respect TOKEN_LIFETIME_SECONDS', async () => {
      process.env.TOKEN_LIFETIME_SECONDS = '1800';

      mockKMSClient.send.mock.mockImplementation((command) => {
        if (command.input.KeyId === 'test-key-id' && command.input.Message) {
          return Promise.resolve({
            Signature: crypto.randomBytes(256)
          });
        } else {
          return Promise.resolve({
            KeyId: 'test-key-id'
          });
        }
      });

      mockSTSClient.send.mock.mockImplementation(() => {
        return Promise.resolve({
          Account: '123456789012',
          Arn: 'arn:aws:iam::123456789012:role/TestRole',
          UserId: 'AIDACKCEVSQ6C2EXAMPLE'
        });
      });

      const { handler } = await import('../token-exchange.js');

      const event = {
        body: JSON.stringify({
          access_key_id: 'AKIAIOSFODNN7EXAMPLE',
          secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
        }),
        headers: {},
        requestContext: { http: { method: 'POST' } },
        rawPath: '/token'
      };

      const response = await handler(event);
      const body = JSON.parse(response.body);

      assert.strictEqual(body.expires_in, 1800);

      const parts = body.access_token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      assert.strictEqual(payload.exp - payload.iat, 1800);

      // Reset
      process.env.TOKEN_LIFETIME_SECONDS = '3600';
    });
  });

  describe('Security Headers', () => {
    it('should include no-cache headers', async () => {
      mockKMSClient.send.mock.mockImplementation((command) => {
        if (command.input.Message) {
          return Promise.resolve({ Signature: crypto.randomBytes(256) });
        } else {
          return Promise.resolve({ KeyId: 'test-key-id' });
        }
      });

      mockSTSClient.send.mock.mockImplementation(() => {
        return Promise.resolve({
          Account: '123456789012',
          Arn: 'arn:aws:iam::123456789012:role/TestRole',
          UserId: 'AIDACKCEVSQ6C2EXAMPLE'
        });
      });

      const { handler } = await import('../token-exchange.js');

      const event = {
        body: JSON.stringify({
          access_key_id: 'AKIAIOSFODNN7EXAMPLE',
          secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
        }),
        headers: {},
        requestContext: { http: { method: 'POST' } },
        rawPath: '/token'
      };

      const response = await handler(event);

      assert.strictEqual(response.headers['Cache-Control'], 'no-store');
      assert.strictEqual(response.headers['Pragma'], 'no-cache');
      assert.strictEqual(response.headers['Content-Type'], 'application/json');
    });
  });

  describe('ARN Parsing', () => {
    it('should parse IAM role ARN correctly', async () => {
      mockKMSClient.send.mock.mockImplementation((command) => {
        if (command.input.Message) {
          return Promise.resolve({ Signature: crypto.randomBytes(256) });
        } else {
          return Promise.resolve({ KeyId: 'test-key-id' });
        }
      });

      mockSTSClient.send.mock.mockImplementation(() => {
        return Promise.resolve({
          Account: '123456789012',
          Arn: 'arn:aws:iam::123456789012:role/ServiceRole',
          UserId: 'AIDACKCEVSQ6C2EXAMPLE'
        });
      });

      const { handler } = await import('../token-exchange.js');

      const event = {
        body: JSON.stringify({
          access_key_id: 'AKIAIOSFODNN7EXAMPLE',
          secret_access_key: 'SECRET'
        }),
        headers: {},
        requestContext: { http: { method: 'POST' } },
        rawPath: '/token'
      };

      const response = await handler(event);
      const body = JSON.parse(response.body);
      const parts = body.access_token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

      assert.strictEqual(payload['aws:resource_type'], 'role');
      assert.strictEqual(payload['aws:resource_name'], 'ServiceRole');
    });

    it('should parse IAM user ARN correctly', async () => {
      mockKMSClient.send.mock.mockImplementation((command) => {
        if (command.input.Message) {
          return Promise.resolve({ Signature: crypto.randomBytes(256) });
        } else {
          return Promise.resolve({ KeyId: 'test-key-id' });
        }
      });

      mockSTSClient.send.mock.mockImplementation(() => {
        return Promise.resolve({
          Account: '123456789012',
          Arn: 'arn:aws:iam::123456789012:user/alice',
          UserId: 'AIDACKCEVSQ6C2EXAMPLE'
        });
      });

      const { handler } = await import('../token-exchange.js');

      const event = {
        body: JSON.stringify({
          access_key_id: 'AKIAIOSFODNN7EXAMPLE',
          secret_access_key: 'SECRET'
        }),
        headers: {},
        requestContext: { http: { method: 'POST' } },
        rawPath: '/token'
      };

      const response = await handler(event);
      const body = JSON.parse(response.body);
      const parts = body.access_token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

      assert.strictEqual(payload['aws:resource_type'], 'user');
      assert.strictEqual(payload['aws:resource_name'], 'alice');
    });
  });
});
