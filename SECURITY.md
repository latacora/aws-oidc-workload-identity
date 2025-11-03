# Security Policy

## Security Model

AWS OIDC Workload Identity is designed to securely exchange AWS IAM credentials for OIDC tokens using cryptographic signing via AWS KMS.

### Trust Model

```
┌─────────────────────────────────────────────────────────────┐
│                        Trust Boundaries                      │
└─────────────────────────────────────────────────────────────┘

1. AWS IAM: Root of trust for identity
   └─> STS GetCallerIdentity: Verifies credentials

2. AWS KMS: Root of trust for cryptography
   └─> Private key never leaves HSM
   └─> Signs JWTs with RSA-2048

3. OIDC Consumer (e.g., Tailscale): Trusts tokens
   └─> Verifies signature using JWKS public key
   └─> Validates claims and expiration
```

### Security Properties

**Guaranteed**:
- Identity verification before token issuance
- Cryptographic proof of token authenticity
- Tamper-proof tokens (signature verification fails if modified)
- Short-lived credentials (1 hour default)
- Audit trail via CloudWatch Logs

**Not Guaranteed**:
- Protection against credential theft (if AWS creds stolen, attacker can get tokens)
- Token revocation (no revocation mechanism)
- Protection after token interception (use HTTPS)

## Threat Model

### Threats We Mitigate

#### 1. Token Forgery
**Threat**: Attacker creates fake tokens

**Mitigation**:
- KMS signs all tokens with private key in HSM
- OIDC consumers verify signature using JWKS
- Signature verification fails for forged tokens

#### 2. Token Tampering
**Threat**: Attacker modifies token claims

**Mitigation**:
- JWT signature covers header and payload
- Any modification invalidates signature
- Signature verification detects tampering

#### 3. Invalid Credential Use
**Threat**: Attacker uses invalid AWS credentials

**Mitigation**:
- STS GetCallerIdentity called before token issuance
- Invalid credentials result in 401 error
- No tokens issued for invalid credentials

#### 4. Private Key Exposure
**Threat**: Private signing key is stolen

**Mitigation**:
- Private key never leaves KMS HSM
- KMS provides FIPS 140-2 Level 2 validated HSMs
- Sign operations only, no export capability

### Threats We Don't Fully Mitigate

#### 1. Credential Theft
**Threat**: Attacker steals valid AWS credentials

**Risk**: Attacker can request valid tokens

**Residual Risk**:
- Short token lifetime limits exposure window
- CloudWatch logging provides audit trail
- IAM policies can restrict which credentials can get tokens

**Recommendations**:
- Use short-lived AWS credentials (STS temporary credentials)
- Enable CloudTrail for AWS API auditing
- Monitor CloudWatch logs for unusual patterns
- Use IAM Conditions to restrict token Lambda access

#### 2. Token Interception
**Threat**: Attacker intercepts token in transit

**Risk**: Attacker can use token until expiration

**Residual Risk**:
- HTTPS required but not enforced at application level
- No mutual TLS by default

**Recommendations**:
- Always use HTTPS for token requests
- Consider mutual TLS for high-security environments
- Use network segmentation
- Enable VPC endpoints for Lambda

#### 3. OIDC Consumer Compromise
**Threat**: OIDC consumer (e.g., Tailscale) is compromised

**Risk**: Attacker gains access to what tokens grant

**Residual Risk**:
- This solution doesn't protect against downstream compromise
- Tokens are valid if consumer is compromised

**Recommendations**:
- Follow OIDC consumer's security best practices
- Use least-privilege access policies
- Monitor consumer access patterns
- Implement defense in depth

#### 4. Token Replay
**Threat**: Attacker replays intercepted token

**Risk**: Token valid until expiration

**Residual Risk**:
- No per-request nonce by default
- Same token can be used multiple times

**Recommendations**:
- Use short token lifetime (1 hour default)
- OIDC consumer should implement additional checks
- Consider adding nonce for high-security use cases

## Security Best Practices

### Deployment Security

#### 1. Restrict Lambda Access

Use Lambda Function URL auth type NONE carefully. Consider:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": "*",
      "Action": "lambda:InvokeFunctionUrl",
      "Resource": "arn:aws:lambda:region:account:function:token-exchange",
      "Condition": {
        "IpAddress": {
          "aws:SourceIp": ["10.0.0.0/8", "172.16.0.0/12"]
        }
      }
    }
  ]
}
```

#### 2. Enable CloudWatch Alarms

Monitor for security events:

```bash
# High error rate
aws cloudwatch put-metric-alarm \
  --alarm-name token-exchange-high-errors \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 \
  --metric-name Errors \
  --namespace AWS/Lambda \
  --period 300 \
  --statistic Sum \
  --threshold 10 \
  --dimensions Name=FunctionName,Value=aws-oidc-workload-identity-token-exchange

# Unusual invocation count
aws cloudwatch put-metric-alarm \
  --alarm-name token-exchange-high-invocations \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1 \
  --metric-name Invocations \
  --namespace AWS/Lambda \
  --period 300 \
  --statistic Sum \
  --threshold 1000
```

#### 3. Use VPC Endpoints

For internal-only use:

```bash
# Create VPC endpoint for Lambda
aws ec2 create-vpc-endpoint \
  --vpc-id vpc-xxx \
  --service-name com.amazonaws.region.lambda \
  --subnet-ids subnet-xxx \
  --security-group-ids sg-xxx
```

#### 4. Enable AWS CloudTrail

Track all KMS and IAM operations:

```bash
aws cloudtrail create-trail \
  --name oidc-audit-trail \
  --s3-bucket-name my-cloudtrail-bucket \
  --include-global-service-events \
  --is-multi-region-trail
```

### Operational Security

#### 1. Rotate KMS Keys Regularly

While KMS doesn't support automatic rotation for asymmetric keys, rotate manually:

- **Frequency**: Every 6-12 months
- **Process**: Create new key, update Lambdas, wait for old tokens to expire, delete old key
- **Downtime**: None (JWKS can expose multiple keys)

#### 2. Monitor Token Usage

Create CloudWatch Insights queries:

```cloudwatch
# Token issuance by identity
fields @timestamp, @message
| filter @message like /Identity verified/
| parse @message /arn: (?<arn>[^\s,]+)/
| stats count() by arn

# Failed authentication attempts
fields @timestamp, @message
| filter @message like /Token exchange failed/
| stats count() by bin(5m)
```

#### 3. Implement Rate Limiting

Consider adding API Gateway with throttling:

```yaml
# CloudFormation/SAM example
ApiGateway:
  Type: AWS::ApiGatewayV2::Api
  Properties:
    Name: oidc-token-api
    ThrottleSettings:
      BurstLimit: 100
      RateLimit: 50
```

#### 4. Regular Security Audits

- Review CloudWatch Logs monthly
- Audit IAM policies quarterly
- Review KMS key policies
- Test token verification regularly
- Update dependencies promptly

### Development Security

#### 1. Never Log Sensitive Data

**BAD**:
```javascript
console.log('Credentials:', accessKey, secretKey);
console.log('Token:', token);
```

**GOOD**:
```javascript
console.log('Token exchange request received', {
  path: event.rawPath,
  method: event.requestContext?.http?.method
  // No credentials or tokens
});
```

#### 2. Validate All Inputs

```javascript
// Validate credential format
if (!accessKeyId?.match(/^[A-Z0-9]{16,}$/)) {
  throw new Error('Invalid access key format');
}

// Validate audience
if (audience && !audience.match(/^[a-zA-Z0-9-_]+$/)) {
  throw new Error('Invalid audience format');
}
```

#### 3. Use Secure Dependencies

```bash
# Regular security audits
npm audit

# Fix vulnerabilities
npm audit fix

# Update dependencies
npm update
```

#### 4. Implement Security Headers

```javascript
return {
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
  },
  body: JSON.stringify(response)
};
```

## Known Security Limitations

### 1. No Token Revocation

**Limitation**: Tokens cannot be revoked before expiration

**Impact**: If credentials are compromised, attacker can use tokens until expiry

**Workarounds**:
- Use short token lifetime (1 hour)
- Rotate AWS credentials immediately if compromised
- Monitor for suspicious token usage
- OIDC consumer may implement additional checks

### 2. No Mutual TLS

**Limitation**: Lambda Function URLs don't support client certificates

**Impact**: Cannot cryptographically verify client identity

**Workarounds**:
- Use VPC endpoints and security groups
- Implement IP whitelisting
- Add additional authentication layer
- Use API Gateway with mutual TLS if needed

### 3. Limited Rate Limiting

**Limitation**: Function URLs have basic throttling only

**Impact**: DDoS or brute force attacks possible

**Workarounds**:
- Use API Gateway for sophisticated rate limiting
- Enable AWS WAF
- Implement application-level rate limiting
- Monitor and alert on unusual patterns

### 4. Same Token Reuse

**Limitation**: Same token can be used multiple times

**Impact**: Replay attacks possible within token lifetime

**Workarounds**:
- Use short token lifetime
- OIDC consumer should track token usage
- Add nonce claim for critical operations
- Implement additional request authentication

## Incident Response

### If AWS Credentials Are Compromised

1. **Immediately**:
   - Disable the compromised IAM user/role
   - Rotate all credentials
   - Review CloudWatch logs for token requests

2. **Within 1 hour**:
   - Wait for tokens to expire (default 1 hour)
   - Review OIDC consumer access logs
   - Identify what resources were accessed

3. **Within 24 hours**:
   - Complete security assessment
   - Implement additional controls
   - Update incident response procedures

### If KMS Key Is Suspected Compromised

**Note**: KMS private keys cannot be exported, making true compromise unlikely

1. **Immediately**:
   - Create new KMS key
   - Update Lambda functions to use new key
   - DO NOT delete old key yet

2. **Within 1 hour**:
   - Wait for tokens signed with old key to expire
   - Verify OIDC consumers recognize new JWKS

3. **After token expiration**:
   - Schedule old KMS key deletion (7-day waiting period)
   - Review KMS CloudTrail logs
   - Document incident

### If Token Is Leaked

1. **Assess Impact**:
   - Check token expiration time
   - Identify what token grants access to
   - Review access logs from OIDC consumer

2. **Immediate Actions**:
   - Cannot revoke token directly
   - Disable underlying AWS credentials if possible
   - Monitor for unauthorized usage

3. **Short Term** (within token lifetime):
   - Block access at OIDC consumer level if possible
   - Monitor all activity closely

4. **Long Term**:
   - Reduce token lifetime if needed
   - Implement additional security controls
   - Review credential handling procedures

## Vulnerability Disclosure

### Reporting Security Issues

**DO NOT** create public GitHub issues for security vulnerabilities.

Instead:
1. Email security concerns to: [your-security-email]
2. Include:
   - Description of vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

3. We will respond within:
   - 24 hours: Acknowledge receipt
   - 72 hours: Initial assessment
   - 30 days: Remediation plan or fix

### Security Updates

Security fixes will be:
- Released as soon as possible
- Documented in CHANGELOG
- Announced in GitHub releases
- Tagged with severity level

## Compliance Considerations

### HIPAA

This solution uses HIPAA-eligible AWS services:
- Lambda: HIPAA eligible
- KMS: HIPAA eligible
- CloudWatch: HIPAA eligible

Requirements:
- Sign AWS BAA
- Enable encryption at rest (KMS does this)
- Implement access controls
- Maintain audit logs

### PCI DSS

Considerations for payment card environments:
- KMS provides cryptographic key management
- CloudWatch Logs provide audit trail
- Regular security testing required
- Network segmentation recommended

### GDPR

If tokens contain personal data:
- Document what data is in tokens
- Implement data minimization
- Provide ability to stop token issuance
- Maintain audit logs for access requests

## Security Checklist

Before deploying to production:

- [ ] Review and restrict Lambda Function URL access
- [ ] Enable CloudWatch alarms for errors and unusual activity
- [ ] Configure CloudTrail for audit logging
- [ ] Test token verification with JWKS
- [ ] Implement monitoring and alerting
- [ ] Document incident response procedures
- [ ] Review IAM policies for least privilege
- [ ] Enable MFA for AWS accounts with admin access
- [ ] Test backup and recovery procedures
- [ ] Review security documentation with team
- [ ] Schedule regular security reviews
- [ ] Set up vulnerability scanning
- [ ] Configure AWS Config rules
- [ ] Enable AWS GuardDuty if not already enabled
- [ ] Review VPC security if using VPC endpoints

## Additional Resources

- [AWS KMS Best Practices](https://docs.aws.amazon.com/kms/latest/developerguide/best-practices.html)
- [AWS Lambda Security](https://docs.aws.amazon.com/lambda/latest/dg/lambda-security.html)
- [OIDC Security Considerations](https://openid.net/specs/openid-connect-core-1_0.html#Security)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [CIS AWS Foundations Benchmark](https://www.cisecurity.org/benchmark/amazon_web_services)
