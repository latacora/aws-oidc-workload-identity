/**
 * Integration Tests
 *
 * End-to-end tests for the complete OIDC flow.
 * These tests verify token generation and validation.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';

describe('Integration Tests', () => {
  describe('End-to-End Token Flow', () => {
    it('should generate token that can be verified with JWKS', async () => {
      // Generate a real key pair for this test
      const keyPair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
          type: 'spki',
          format: 'der'
        },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'der'
        }
      });

      // Mock KMS to use our test key pair
      const mockKMSClient = {
        send: mock.fn((command) => {
          if (command.input.Message) {
            // Sign command
            const privateKey = crypto.createPrivateKey({
              key: keyPair.privateKey,
              format: 'der',
              type: 'pkcs8'
            });

            const signature = crypto.sign(
              'sha256',
              command.input.Message,
              privateKey
            );

            return Promise.resolve({ Signature: signature });
          } else {
            // GetPublicKey command
            return Promise.resolve({
              KeyId: 'arn:aws:kms:us-east-1:123456789012:key/test-key-id',
              PublicKey: keyPair.publicKey
            });
          }
        })
      };

      const mockSTSClient = {
        send: mock.fn(() => {
          return Promise.resolve({
            Account: '123456789012',
            Arn: 'arn:aws:iam::123456789012:role/TestRole',
            UserId: 'AIDACKCEVSQ6C2EXAMPLE'
          });
        })
      };

      // Mock AWS SDK
      mock.module('@aws-sdk/client-kms', {
        namedExports: {
          KMSClient: mock.fn(() => mockKMSClient),
          SignCommand: mock.fn((input) => ({ input })),
          GetPublicKeyCommand: mock.fn((input) => ({ input }))
        }
      });

      mock.module('@aws-sdk/client-sts', {
        namedExports: {
          STSClient: mock.fn(() => mockSTSClient),
          GetCallerIdentityCommand: mock.fn((input) => ({ input }))
        }
      });

      // Set environment
      process.env.KMS_KEY_ID = 'test-key-id';
      process.env.ISSUER = 'https://test-issuer.example.com';
      process.env.TOKEN_LIFETIME_SECONDS = '3600';

      // Step 1: Get token from token-exchange Lambda
      const tokenHandler = (await import('../token-exchange.js')).handler;

      const tokenEvent = {
        body: JSON.stringify({
          access_key_id: 'AKIAIOSFODNN7EXAMPLE',
          secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          audience: 'test-audience'
        }),
        headers: {},
        requestContext: { http: { method: 'POST' } },
        rawPath: '/token'
      };

      const tokenResponse = await tokenHandler(tokenEvent);
      assert.strictEqual(tokenResponse.statusCode, 200);

      const tokenBody = JSON.parse(tokenResponse.body);
      const token = tokenBody.access_token;

      // Step 2: Get JWKS from JWKS Lambda
      const jwksHandler = (await import('../jwks.js')).handler;

      const jwksEvent = {
        headers: {},
        requestContext: { http: { method: 'GET' } },
        rawPath: '/.well-known/jwks.json'
      };

      const jwksResponse = await jwksHandler(jwksEvent);
      assert.strictEqual(jwksResponse.statusCode, 200);

      const jwks = JSON.parse(jwksResponse.body);

      // Step 3: Verify token using JWKS
      const [headerB64, payloadB64, signatureB64] = token.split('.');

      // Decode header and payload
      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

      // Find matching key in JWKS
      const jwk = jwks.keys.find(k => k.kid === header.kid);
      assert.ok(jwk, 'JWK with matching kid should exist');

      // Reconstruct public key from JWK
      const publicKey = crypto.createPublicKey({
        key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
        format: 'jwk'
      });

      // Verify signature
      const signatureBuffer = Buffer.from(signatureB64, 'base64url');
      const dataToVerify = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');

      const isValid = crypto.verify(
        'sha256',
        dataToVerify,
        publicKey,
        signatureBuffer
      );

      assert.ok(isValid, 'Token signature should be valid');

      // Verify claims
      assert.strictEqual(payload.iss, 'https://test-issuer.example.com');
      assert.strictEqual(payload.sub, 'arn:aws:iam::123456789012:role/TestRole');
      assert.strictEqual(payload.aud, 'test-audience');
      assert.strictEqual(payload['aws:account'], '123456789012');
    });
  });

  describe('Token Validation', () => {
    it('should reject tampered tokens', async () => {
      // Generate key pair
      const keyPair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
          type: 'spki',
          format: 'der'
        },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'der'
        }
      });

      const mockKMSClient = {
        send: mock.fn((command) => {
          if (command.input.Message) {
            const privateKey = crypto.createPrivateKey({
              key: keyPair.privateKey,
              format: 'der',
              type: 'pkcs8'
            });
            const signature = crypto.sign('sha256', command.input.Message, privateKey);
            return Promise.resolve({ Signature: signature });
          } else {
            return Promise.resolve({
              KeyId: 'test-key-id',
              PublicKey: keyPair.publicKey
            });
          }
        })
      };

      const mockSTSClient = {
        send: mock.fn(() => {
          return Promise.resolve({
            Account: '123456789012',
            Arn: 'arn:aws:iam::123456789012:role/TestRole',
            UserId: 'AIDACKCEVSQ6C2EXAMPLE'
          });
        })
      };

      mock.module('@aws-sdk/client-kms', {
        namedExports: {
          KMSClient: mock.fn(() => mockKMSClient),
          SignCommand: mock.fn((input) => ({ input })),
          GetPublicKeyCommand: mock.fn((input) => ({ input }))
        }
      });

      mock.module('@aws-sdk/client-sts', {
        namedExports: {
          STSClient: mock.fn(() => mockSTSClient),
          GetCallerIdentityCommand: mock.fn((input) => ({ input }))
        }
      });

      process.env.KMS_KEY_ID = 'test-key-id';
      process.env.ISSUER = 'https://test-issuer.example.com';

      // Get valid token
      const tokenHandler = (await import('../token-exchange.js')).handler;
      const tokenEvent = {
        body: JSON.stringify({
          access_key_id: 'AKIAIOSFODNN7EXAMPLE',
          secret_access_key: 'SECRET'
        }),
        headers: {},
        requestContext: { http: { method: 'POST' } },
        rawPath: '/token'
      };

      const tokenResponse = await tokenHandler(tokenEvent);
      const tokenBody = JSON.parse(tokenResponse.body);
      const token = tokenBody.access_token;

      // Tamper with payload
      const [headerB64, payloadB64, signatureB64] = token.split('.');
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

      // Change account ID
      payload['aws:account'] = '999999999999';

      const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const tamperedToken = `${headerB64}.${tamperedPayloadB64}.${signatureB64}`;

      // Get JWKS
      const jwksHandler = (await import('../jwks.js')).handler;
      const jwksEvent = {
        headers: {},
        requestContext: { http: { method: 'GET' } },
        rawPath: '/.well-known/jwks.json'
      };

      const jwksResponse = await jwksHandler(jwksEvent);
      const jwks = JSON.parse(jwksResponse.body);

      // Try to verify tampered token
      const [tHeaderB64, tPayloadB64, tSignatureB64] = tamperedToken.split('.');
      const tHeader = JSON.parse(Buffer.from(tHeaderB64, 'base64url').toString());

      const jwk = jwks.keys.find(k => k.kid === tHeader.kid);
      const publicKey = crypto.createPublicKey({
        key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
        format: 'jwk'
      });

      const signatureBuffer = Buffer.from(tSignatureB64, 'base64url');
      const dataToVerify = Buffer.from(`${tHeaderB64}.${tPayloadB64}`, 'utf8');

      const isValid = crypto.verify(
        'sha256',
        dataToVerify,
        publicKey,
        signatureBuffer
      );

      assert.strictEqual(isValid, false, 'Tampered token should not be valid');
    });
  });

  describe('OIDC Compliance', () => {
    it('should generate OIDC-compliant tokens', async () => {
      const keyPair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' }
      });

      const mockKMSClient = {
        send: mock.fn((command) => {
          if (command.input.Message) {
            const privateKey = crypto.createPrivateKey({
              key: keyPair.privateKey,
              format: 'der',
              type: 'pkcs8'
            });
            return Promise.resolve({
              Signature: crypto.sign('sha256', command.input.Message, privateKey)
            });
          } else {
            return Promise.resolve({
              KeyId: 'test-key-id',
              PublicKey: keyPair.publicKey
            });
          }
        })
      };

      const mockSTSClient = {
        send: mock.fn(() => {
          return Promise.resolve({
            Account: '123456789012',
            Arn: 'arn:aws:iam::123456789012:role/TestRole',
            UserId: 'AIDACKCEVSQ6C2EXAMPLE'
          });
        })
      };

      mock.module('@aws-sdk/client-kms', {
        namedExports: {
          KMSClient: mock.fn(() => mockKMSClient),
          SignCommand: mock.fn((input) => ({ input })),
          GetPublicKeyCommand: mock.fn((input) => ({ input }))
        }
      });

      mock.module('@aws-sdk/client-sts', {
        namedExports: {
          STSClient: mock.fn(() => mockSTSClient),
          GetCallerIdentityCommand: mock.fn((input) => ({ input }))
        }
      });

      process.env.KMS_KEY_ID = 'test-key-id';
      process.env.ISSUER = 'https://test-issuer.example.com';
      process.env.TOKEN_LIFETIME_SECONDS = '3600';

      const tokenHandler = (await import('../token-exchange.js')).handler;
      const tokenEvent = {
        body: JSON.stringify({
          access_key_id: 'AKIAIOSFODNN7EXAMPLE',
          secret_access_key: 'SECRET'
        }),
        headers: {},
        requestContext: { http: { method: 'POST' } },
        rawPath: '/token'
      };

      const response = await tokenHandler(tokenEvent);
      const body = JSON.parse(response.body);
      const token = body.access_token;

      const [headerB64, payloadB64] = token.split('.');
      const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

      // Verify OIDC required claims
      assert.ok(payload.iss, 'Must have issuer (iss)');
      assert.ok(payload.sub, 'Must have subject (sub)');
      assert.ok(payload.aud, 'Must have audience (aud)');
      assert.ok(payload.iat, 'Must have issued at (iat)');
      assert.ok(payload.exp, 'Must have expiration (exp)');

      // Verify header
      assert.strictEqual(header.alg, 'RS256', 'Must use RS256 algorithm');
      assert.strictEqual(header.typ, 'JWT', 'Must be JWT type');
      assert.ok(header.kid, 'Must have key ID (kid)');

      // Verify time constraints
      const now = Math.floor(Date.now() / 1000);
      assert.ok(payload.iat <= now + 5, 'iat should be current or past time');
      assert.ok(payload.exp > now, 'Token should not be expired');
      assert.ok(payload.exp === payload.iat + 3600, 'Token lifetime should match');
    });
  });
});
