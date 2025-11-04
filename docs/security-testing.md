# Security Testing Plan

## Critical Security Control: Direct Invocation Protection

This document outlines the testing strategy for validating that direct Lambda invocation is properly blocked, preventing the critical vulnerability where attackers could forge IAM identity to mint arbitrary credentials.

## Threat Scenario

**Without proper resource-based policy**:
```bash
# Attacker with lambda:InvokeFunction permission
aws lambda invoke \
  --function-name aws-oidc-workload-identity-token-exchange \
  --payload '{
    "requestContext": {
      "authorizer": {
        "iam": {
          "userArn": "arn:aws:iam::123456789012:role/Administrator",
          "accountId": "123456789012",
          "userId": "FAKE-ID"
        }
      }
    }
  }' \
  output.json

# Result: Lambda trusts forged data, mints token for Administrator
```

**Impact**: Complete authentication bypass - attacker can impersonate any AWS identity.

## Testing Strategy

### Test 1: Verify Resource-Based Policy Exists

**Purpose**: Confirm the deployment script correctly creates the resource-based policy

**Test Method**:
```bash
#!/bin/bash
# test/security/verify-policy.sh

FUNCTION_NAME="aws-oidc-workload-identity-token-exchange"
REGION="${AWS_REGION:-us-east-1}"

echo "Fetching resource-based policy for $FUNCTION_NAME..."
POLICY=$(aws lambda get-policy \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION" \
  --query Policy \
  --output text 2>/dev/null)

if [ -z "$POLICY" ]; then
  echo "❌ CRITICAL: No resource-based policy found!"
  exit 1
fi

# Parse policy JSON
echo "$POLICY" | jq . > /tmp/policy.json

# Check for InvokeFunctionUrl statement
if ! echo "$POLICY" | jq -e '.Statement[] | select(.Action == "lambda:InvokeFunctionUrl")' > /dev/null; then
  echo "❌ CRITICAL: Missing InvokeFunctionUrl permission statement"
  exit 1
fi
echo "✓ Found InvokeFunctionUrl statement"

# Check for InvokeFunction statement with condition
if ! echo "$POLICY" | jq -e '.Statement[] | select(.Action == "lambda:InvokeFunction" and .Condition.Bool."lambda:InvokedViaFunctionUrl" == "true")' > /dev/null; then
  echo "❌ CRITICAL: Missing InvokeFunction statement with InvokedViaFunctionUrl condition"
  echo "This means direct invocation is NOT blocked!"
  exit 1
fi
echo "✓ Found InvokeFunction statement with InvokedViaFunctionUrl condition"

echo ""
echo "✓ Security policy correctly configured"
echo "Direct invocation protection is ENABLED"
```

**Expected Result**: Both statements present, exit code 0

**Failure Impact**: CRITICAL - deployment is insecure

---

### Test 2: Attempt Direct Invocation (Should Fail)

**Purpose**: Verify direct invocation is blocked even with valid AWS credentials

**Test Method**:
```bash
#!/bin/bash
# test/security/test-direct-invocation.sh

FUNCTION_NAME="aws-oidc-workload-identity-token-exchange"
REGION="${AWS_REGION:-us-east-1}"

echo "Attempting direct Lambda invocation (this should FAIL)..."

# Create payload that attempts to forge Administrator identity
PAYLOAD='{
  "version": "2.0",
  "requestContext": {
    "authorizer": {
      "iam": {
        "userArn": "arn:aws:iam::123456789012:role/Administrator",
        "accountId": "123456789012",
        "userId": "FORGED-USER-ID",
        "accessKey": "FORGED-ACCESS-KEY"
      }
    },
    "http": {
      "method": "POST"
    }
  }
}'

# Attempt direct invocation
ERROR_OUTPUT=$(aws lambda invoke \
  --function-name "$FUNCTION_NAME" \
  --payload "$PAYLOAD" \
  --region "$REGION" \
  /tmp/response.json 2>&1)

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "❌ CRITICAL SECURITY FAILURE!"
  echo "Direct invocation succeeded - attacker can forge IAM identity!"
  echo "Response:"
  cat /tmp/response.json
  exit 1
fi

# Check if error is specifically about permissions
if echo "$ERROR_OUTPUT" | grep -qi "AccessDeniedException\|not authorized"; then
  echo "✓ Direct invocation correctly blocked by IAM policy"
  echo "Error message: $ERROR_OUTPUT"
  exit 0
else
  echo "⚠ Warning: Invocation failed but with unexpected error"
  echo "Error: $ERROR_OUTPUT"
  exit 2
fi
```

**Expected Result**:
- Exit code 254 (AccessDeniedException)
- Error contains "not authorized" or similar
- No response.json generated or contains error

**Failure Impact**: CRITICAL - indicates vulnerability is exploitable

---

### Test 3: Verify Function URL Invocation Works

**Purpose**: Confirm legitimate Function URL access still works

**Test Method**:
```bash
#!/bin/bash
# test/security/test-function-url-access.sh

FUNCTION_NAME="aws-oidc-workload-identity-token-exchange"
REGION="${AWS_REGION:-us-east-1}"

echo "Testing Function URL invocation (this should SUCCEED)..."

# Get Function URL
FUNCTION_URL=$(aws lambda get-function-url-config \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION" \
  --query FunctionUrl \
  --output text)

if [ -z "$FUNCTION_URL" ]; then
  echo "❌ Could not retrieve Function URL"
  exit 1
fi

echo "Function URL: $FUNCTION_URL"

# Use aws4 to sign the request (requires npm install -g aws4-cli)
# Or use the client.js script
node client.js "$FUNCTION_URL" "test-audience" > /tmp/token-response.json

EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "❌ Function URL invocation failed"
  cat /tmp/token-response.json
  exit 1
fi

# Verify response structure
if ! jq -e '.access_token' /tmp/token-response.json > /dev/null; then
  echo "❌ Invalid response structure - missing access_token"
  exit 1
fi

echo "✓ Function URL invocation successful"
echo "✓ Token generated with proper identity verification"
```

**Expected Result**: Token successfully generated with real identity

**Failure Impact**: HIGH - legitimate access broken

---

### Test 4: Verify Policy After Updates

**Purpose**: Ensure policy persists after Lambda updates

**Test Method**:
```bash
#!/bin/bash
# test/security/test-policy-persistence.sh

FUNCTION_NAME="aws-oidc-workload-identity-token-exchange"
REGION="${AWS_REGION:-us-east-1}"

echo "Testing policy persistence after function update..."

# Get current policy
POLICY_BEFORE=$(aws lambda get-policy \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION" \
  --query Policy \
  --output text)

# Trigger a configuration update (no-op change)
aws lambda update-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION" \
  --description "Test update $(date +%s)" \
  > /dev/null

# Wait for update to complete
aws lambda wait function-updated \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION"

# Get policy after update
POLICY_AFTER=$(aws lambda get-policy \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION" \
  --query Policy \
  --output text)

# Compare policies (ignoring whitespace)
DIFF=$(diff <(echo "$POLICY_BEFORE" | jq -S .) <(echo "$POLICY_AFTER" | jq -S .))

if [ -n "$DIFF" ]; then
  echo "⚠ Warning: Policy changed after function update"
  echo "Diff:"
  echo "$DIFF"

  # Re-run verification
  bash test/security/verify-policy.sh
  exit $?
else
  echo "✓ Policy persisted correctly after function update"
fi
```

**Expected Result**: Policy unchanged after update

---

### Test 5: Cross-Account Invocation Attempt

**Purpose**: Verify even cross-account users with lambda:InvokeFunction cannot directly invoke

**Test Method**:
```bash
#!/bin/bash
# test/security/test-cross-account-block.sh

# This test requires a second AWS account
# Skip if SECONDARY_AWS_PROFILE is not set

if [ -z "$SECONDARY_AWS_PROFILE" ]; then
  echo "⊘ Skipping cross-account test (SECONDARY_AWS_PROFILE not set)"
  exit 0
fi

FUNCTION_ARN="arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:aws-oidc-workload-identity-token-exchange"

echo "Attempting direct invocation from secondary account..."
echo "(Using profile: $SECONDARY_AWS_PROFILE)"

# Attempt invocation using secondary account credentials
ERROR_OUTPUT=$(aws lambda invoke \
  --function-name "$FUNCTION_ARN" \
  --payload '{}' \
  --profile "$SECONDARY_AWS_PROFILE" \
  /tmp/response.json 2>&1)

if [ $? -eq 0 ]; then
  echo "❌ CRITICAL: Cross-account direct invocation succeeded!"
  exit 1
fi

if echo "$ERROR_OUTPUT" | grep -qi "AccessDeniedException"; then
  echo "✓ Cross-account direct invocation correctly blocked"
else
  echo "⚠ Unexpected error: $ERROR_OUTPUT"
  exit 2
fi
```

**Expected Result**: AccessDeniedException

---

## Integration Test Suite

Create `test/security/run-all-security-tests.sh`:

```bash
#!/bin/bash

set -e

echo "================================"
echo "Security Test Suite"
echo "================================"
echo ""

# Test 1: Verify policy
echo "Test 1: Verify Resource-Based Policy"
bash test/security/verify-policy.sh
echo ""

# Test 2: Block direct invocation
echo "Test 2: Verify Direct Invocation Blocked"
bash test/security/test-direct-invocation.sh
echo ""

# Test 3: Allow Function URL
echo "Test 3: Verify Function URL Access"
bash test/security/test-function-url-access.sh
echo ""

# Test 4: Policy persistence
echo "Test 4: Verify Policy Persistence"
bash test/security/test-policy-persistence.sh
echo ""

# Test 5: Cross-account (optional)
echo "Test 5: Verify Cross-Account Block"
bash test/security/test-cross-account-block.sh
echo ""

echo "================================"
echo "✓ All security tests passed"
echo "================================"
```

---

## CI/CD Integration

Add to GitHub Actions or deployment pipeline:

```yaml
# .github/workflows/security-tests.yml
name: Security Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  security-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1

      - name: Deploy test stack
        run: |
          export ISSUER="https://test.example.com"
          ./deploy.sh

      - name: Run security tests
        run: |
          chmod +x test/security/*.sh
          bash test/security/run-all-security-tests.sh

      - name: Cleanup
        if: always()
        run: ./destroy.sh
```

---

## Manual Verification Checklist

After deployment, manually verify:

- [ ] Run `test/security/verify-policy.sh` - passes
- [ ] Run `test/security/test-direct-invocation.sh` - invocation blocked
- [ ] Run `test/security/test-function-url-access.sh` - access works
- [ ] Check AWS Lambda Console → Function → Configuration → Permissions → Resource-based policy statements
  - [ ] Statement with `lambda:InvokeFunctionUrl` exists
  - [ ] Statement with `lambda:InvokeFunction` and condition `lambda:InvokedViaFunctionUrl: true` exists
- [ ] Attempt manual direct invocation in AWS Console → Should fail with access denied

---

## Regression Prevention

**Critical**: These tests MUST be run:
1. After every deployment
2. Before every release
3. After any IAM policy changes
4. After Lambda function updates

**Failure of Test 2 (direct invocation) indicates CRITICAL vulnerability** - deployment must be rolled back immediately.

---

## Additional Security Testing

### Fuzzing Test
Test with malformed payloads to ensure no bypass:

```bash
# Various malformed payloads
aws lambda invoke --function-name X --payload '{"requestContext":null}' out.json
aws lambda invoke --function-name X --payload '{"requestContext":{"authorizer":{}}}' out.json
aws lambda invoke --function-name X --payload '{"requestContext":{"authorizer":{"iam":null}}}' out.json
```

All should fail with AccessDeniedException (blocked by IAM before reaching Lambda).

### Privilege Escalation Test
Verify users with partial permissions cannot exploit:

```bash
# User with only lambda:InvokeFunctionUrl (no lambda:InvokeFunction)
# Should be able to use Function URL but NOT directly invoke

# Test Function URL access
aws lambda invoke-url --url $FUNCTION_URL  # Should work (if they can pass SigV4)

# Test direct invocation
aws lambda invoke --function-name X --payload '{}' out.json  # Should fail (no lambda:InvokeFunction)
```

---

## Documentation

Test results should be documented in:
- Deployment logs
- Security audit reports
- Compliance documentation

Evidence to collect:
- Policy JSON from `aws lambda get-policy`
- Failed invocation error messages
- Successful Function URL access logs
- CloudWatch Logs showing blocked attempts
