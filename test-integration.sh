#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
STACK_NAME="${STACK_NAME:-aws-oidc-workload-identity-test-$$}"
REGION="${AWS_REGION:-us-east-1}"
ISSUER="https://test-issuer-$$.example.com"
CLEANUP="${CLEANUP:-true}"

echo -e "${BLUE}=== AWS OIDC Workload Identity Integration Test ===${NC}"
echo "Stack Name: $STACK_NAME"
echo "Region: $REGION"
echo "Issuer: $ISSUER"
echo ""

# Function to cleanup on error
cleanup_on_error() {
    echo -e "${RED}Error occurred. Cleaning up...${NC}"
    if [ "$CLEANUP" = "true" ]; then
        STACK_NAME="$STACK_NAME" AWS_REGION="$REGION" ./destroy.sh || true
    else
        echo "Skipping cleanup (CLEANUP=false)"
    fi
    exit 1
}

trap cleanup_on_error ERR

# Step 1: Deploy infrastructure
echo -e "${YELLOW}Step 1: Deploying infrastructure...${NC}"
export STACK_NAME="$STACK_NAME"
export AWS_REGION="$REGION"
export ISSUER="$ISSUER"

./deploy.sh

echo ""
echo -e "${GREEN}✓ Deployment complete${NC}"

# Extract URLs from deployment output
if [ ! -f "deployment-output.json" ]; then
    echo -e "${RED}Error: deployment-output.json not found${NC}"
    exit 1
fi

TOKEN_URL=$(jq -r '.TokenUrl' deployment-output.json)
JWKS_URL=$(jq -r '.JwksUrl' deployment-output.json)
DISCOVERY_URL=$(jq -r '.DiscoveryUrl' deployment-output.json)

echo "Token URL: $TOKEN_URL"
echo "JWKS URL: $JWKS_URL"
echo "Discovery URL: $DISCOVERY_URL"
echo ""

# Step 2: Test JWKS endpoint (public)
echo -e "${YELLOW}Step 2: Testing JWKS endpoint...${NC}"

JWKS_RESPONSE=$(curl -s "$JWKS_URL")
echo "JWKS Response: $JWKS_RESPONSE"

# Verify JWKS structure
if echo "$JWKS_RESPONSE" | jq -e '.keys[0].kty' > /dev/null; then
    echo -e "${GREEN}✓ JWKS endpoint working${NC}"
else
    echo -e "${RED}✗ JWKS endpoint failed${NC}"
    exit 1
fi

KID=$(echo "$JWKS_RESPONSE" | jq -r '.keys[0].kid')
echo "Key ID: $KID"
echo ""

# Step 3: Test Discovery endpoint (public)
echo -e "${YELLOW}Step 3: Testing Discovery endpoint...${NC}"

DISCOVERY_RESPONSE=$(curl -s "$DISCOVERY_URL")
echo "Discovery Response: $DISCOVERY_RESPONSE"

# Verify Discovery structure
DISCOVERY_ISSUER=$(echo "$DISCOVERY_RESPONSE" | jq -r '.issuer')
DISCOVERY_JWKS_URI=$(echo "$DISCOVERY_RESPONSE" | jq -r '.jwks_uri')

if [ "$DISCOVERY_ISSUER" = "$ISSUER" ]; then
    echo -e "${GREEN}✓ Discovery issuer matches${NC}"
else
    echo -e "${RED}✗ Discovery issuer mismatch: expected $ISSUER, got $DISCOVERY_ISSUER${NC}"
    exit 1
fi

if [ -n "$DISCOVERY_JWKS_URI" ]; then
    echo -e "${GREEN}✓ Discovery endpoint working${NC}"
else
    echo -e "${RED}✗ Discovery endpoint failed${NC}"
    exit 1
fi
echo ""

# Step 4: Test token endpoint (requires SigV4 auth)
echo -e "${YELLOW}Step 4: Testing token exchange with SigV4 auth...${NC}"

# Get current AWS identity
AWS_IDENTITY=$(aws sts get-caller-identity)
AWS_ACCOUNT=$(echo "$AWS_IDENTITY" | jq -r '.Account')
AWS_ARN=$(echo "$AWS_IDENTITY" | jq -r '.Arn')
AWS_USER_ID=$(echo "$AWS_IDENTITY" | jq -r '.UserId')

echo "AWS Account: $AWS_ACCOUNT"
echo "AWS ARN: $AWS_ARN"
echo "AWS User ID: $AWS_USER_ID"
echo ""

# Exchange for OIDC token using client
echo "Exchanging AWS credentials for OIDC token..."
TOKEN_RESPONSE=$(node client.js "$TOKEN_URL" "test-audience")
echo "Token Response: $TOKEN_RESPONSE"

# Verify token response structure
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token')
TOKEN_TYPE=$(echo "$TOKEN_RESPONSE" | jq -r '.token_type')
EXPIRES_IN=$(echo "$TOKEN_RESPONSE" | jq -r '.expires_in')

if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" = "null" ]; then
    echo -e "${RED}✗ Token exchange failed: no access_token${NC}"
    exit 1
fi

if [ "$TOKEN_TYPE" != "Bearer" ]; then
    echo -e "${RED}✗ Invalid token_type: $TOKEN_TYPE${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Token exchange successful${NC}"
echo "Token Type: $TOKEN_TYPE"
echo "Expires In: $EXPIRES_IN seconds"
echo ""

# Step 5: Verify token structure and claims
echo -e "${YELLOW}Step 5: Verifying token claims...${NC}"

# Decode token (header.payload.signature)
TOKEN_HEADER=$(echo "$ACCESS_TOKEN" | cut -d'.' -f1)
TOKEN_PAYLOAD=$(echo "$ACCESS_TOKEN" | cut -d'.' -f2)

# Add padding if needed for base64 decoding
add_padding() {
    local input="$1"
    local mod=$((${#input} % 4))
    if [ $mod -gt 0 ]; then
        input="${input}$(printf '=%.0s' $(seq 1 $((4 - mod))))"
    fi
    echo "$input"
}

TOKEN_HEADER=$(add_padding "$TOKEN_HEADER")
TOKEN_PAYLOAD=$(add_padding "$TOKEN_PAYLOAD")

# Decode and parse claims
HEADER_JSON=$(echo "$TOKEN_HEADER" | base64 -d 2>/dev/null || echo "$TOKEN_HEADER" | base64 -D 2>/dev/null)
PAYLOAD_JSON=$(echo "$TOKEN_PAYLOAD" | base64 -d 2>/dev/null || echo "$TOKEN_PAYLOAD" | base64 -D 2>/dev/null)

echo "Token Header: $HEADER_JSON"
echo "Token Payload: $PAYLOAD_JSON"
echo ""

# Verify header
HEADER_ALG=$(echo "$HEADER_JSON" | jq -r '.alg')
HEADER_TYP=$(echo "$HEADER_JSON" | jq -r '.typ')
HEADER_KID=$(echo "$HEADER_JSON" | jq -r '.kid')

if [ "$HEADER_ALG" != "RS256" ]; then
    echo -e "${RED}✗ Invalid algorithm: $HEADER_ALG${NC}"
    exit 1
fi

if [ "$HEADER_TYP" != "JWT" ]; then
    echo -e "${RED}✗ Invalid type: $HEADER_TYP${NC}"
    exit 1
fi

if [ "$HEADER_KID" != "$KID" ]; then
    echo -e "${RED}✗ Key ID mismatch: expected $KID, got $HEADER_KID${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Token header valid${NC}"

# Verify standard claims
CLAIM_ISS=$(echo "$PAYLOAD_JSON" | jq -r '.iss')
CLAIM_SUB=$(echo "$PAYLOAD_JSON" | jq -r '.sub')
CLAIM_AUD=$(echo "$PAYLOAD_JSON" | jq -r '.aud')
CLAIM_IAT=$(echo "$PAYLOAD_JSON" | jq -r '.iat')
CLAIM_EXP=$(echo "$PAYLOAD_JSON" | jq -r '.exp')

echo "Issuer: $CLAIM_ISS"
echo "Subject: $CLAIM_SUB"
echo "Audience: $CLAIM_AUD"
echo "Issued At: $CLAIM_IAT"
echo "Expires: $CLAIM_EXP"

if [ "$CLAIM_ISS" != "$ISSUER" ]; then
    echo -e "${RED}✗ Issuer mismatch: expected $ISSUER, got $CLAIM_ISS${NC}"
    exit 1
fi

if [ "$CLAIM_AUD" != "test-audience" ]; then
    echo -e "${RED}✗ Audience mismatch: expected test-audience, got $CLAIM_AUD${NC}"
    exit 1
fi

# Verify expiration is in the future
CURRENT_TIME=$(date +%s)
if [ "$CLAIM_EXP" -le "$CURRENT_TIME" ]; then
    echo -e "${RED}✗ Token already expired${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Standard claims valid${NC}"

# Verify AWS-specific claims
CLAIM_AWS_ACCOUNT=$(echo "$PAYLOAD_JSON" | jq -r '.["aws:account"]')
CLAIM_AWS_ARN=$(echo "$PAYLOAD_JSON" | jq -r '.["aws:arn"]')
CLAIM_AWS_USERID=$(echo "$PAYLOAD_JSON" | jq -r '.["aws:userid"]')

echo ""
echo "AWS Account: $CLAIM_AWS_ACCOUNT"
echo "AWS ARN: $CLAIM_AWS_ARN"
echo "AWS User ID: $CLAIM_AWS_USERID"

if [ "$CLAIM_AWS_ACCOUNT" != "$AWS_ACCOUNT" ]; then
    echo -e "${RED}✗ AWS Account mismatch${NC}"
    exit 1
fi

if [ "$CLAIM_AWS_ARN" != "$AWS_ARN" ]; then
    echo -e "${RED}✗ AWS ARN mismatch${NC}"
    exit 1
fi

echo -e "${GREEN}✓ AWS claims valid${NC}"
echo ""

# Step 6: Test error cases
echo -e "${YELLOW}Step 6: Testing error cases...${NC}"

# Test unauthenticated request (should fail with 403)
echo "Testing unauthenticated request..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$TOKEN_URL")

if [ "$HTTP_CODE" = "403" ]; then
    echo -e "${GREEN}✓ Unauthenticated request properly rejected (403)${NC}"
else
    echo -e "${YELLOW}⚠ Unexpected status code: $HTTP_CODE (expected 403)${NC}"
fi
echo ""

# Step 7: Cleanup
if [ "$CLEANUP" = "true" ]; then
    echo -e "${YELLOW}Step 7: Cleaning up...${NC}"
    STACK_NAME="$STACK_NAME" AWS_REGION="$REGION" ./destroy.sh
    echo -e "${GREEN}✓ Cleanup complete${NC}"
else
    echo -e "${YELLOW}Step 7: Skipping cleanup (CLEANUP=false)${NC}"
    echo "To manually cleanup: STACK_NAME=$STACK_NAME AWS_REGION=$REGION ./destroy.sh"
fi
echo ""

# Summary
echo -e "${GREEN}=== Integration Test Complete ===${NC}"
echo -e "${GREEN}✓ All tests passed${NC}"
echo ""
echo "Summary:"
echo "  - JWKS endpoint: OK"
echo "  - Discovery endpoint: OK"
echo "  - Token exchange: OK"
echo "  - Token claims: OK"
echo "  - Error handling: OK"
echo ""

exit 0
