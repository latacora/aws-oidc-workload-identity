#!/bin/bash

set -e

# Configuration
STACK_NAME="${STACK_NAME:-aws-oidc-workload-identity}"
REGION="${AWS_REGION:-us-east-1}"
ISSUER="${ISSUER:-}" # Must be set by user

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== AWS OIDC Workload Identity Deployment ===${NC}"

# Check if ISSUER is set
if [ -z "$ISSUER" ]; then
  echo -e "${RED}Error: ISSUER environment variable must be set${NC}"
  echo "Example: export ISSUER=https://your-domain.com"
  exit 1
fi

echo "Stack Name: $STACK_NAME"
echo "Region: $REGION"
echo "Issuer: $ISSUER"
echo ""

# Get AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Account ID: $ACCOUNT_ID"
echo ""

# Step 1: Create KMS Key
echo -e "${YELLOW}Step 1: Creating KMS asymmetric key...${NC}"

KMS_KEY_ID=$(aws kms list-aliases --query "Aliases[?AliasName=='alias/$STACK_NAME'].TargetKeyId" --output text)

if [ -z "$KMS_KEY_ID" ]; then
  echo "Creating new KMS key..."

  KMS_KEY_ID=$(aws kms create-key \
    --key-usage SIGN_VERIFY \
    --key-spec RSA_2048 \
    --description "OIDC token signing key for $STACK_NAME" \
    --tags TagKey=Project,TagValue=$STACK_NAME \
    --query KeyMetadata.KeyId \
    --output text \
    --region $REGION)

  echo "Created KMS key: $KMS_KEY_ID"

  # Create alias
  aws kms create-alias \
    --alias-name "alias/$STACK_NAME" \
    --target-key-id "$KMS_KEY_ID" \
    --region $REGION

  echo "Created alias: alias/$STACK_NAME"
else
  echo "Using existing KMS key: $KMS_KEY_ID"
fi

echo ""

# Step 2: Create IAM role for Lambda functions
echo -e "${YELLOW}Step 2: Creating IAM role for Lambda functions...${NC}"

ROLE_NAME="${STACK_NAME}-lambda-role"

# Check if role exists
if aws iam get-role --role-name "$ROLE_NAME" 2>/dev/null; then
  echo "Role $ROLE_NAME already exists"
else
  echo "Creating IAM role..."

  # Trust policy
  cat > /tmp/trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document file:///tmp/trust-policy.json \
    --description "Execution role for $STACK_NAME Lambda functions" \
    --region $REGION

  # Attach basic Lambda execution policy
  aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" \
    --region $REGION

  # Create and attach custom policy for KMS and STS
  cat > /tmp/lambda-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "kms:Sign",
        "kms:GetPublicKey"
      ],
      "Resource": "arn:aws:kms:$REGION:$ACCOUNT_ID:key/$KMS_KEY_ID"
    },
    {
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
EOF

  aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "${STACK_NAME}-permissions" \
    --policy-document file:///tmp/lambda-policy.json \
    --region $REGION

  echo "Waiting 10 seconds for IAM role to propagate..."
  sleep 10
fi

ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME"
echo "Role ARN: $ROLE_ARN"
echo ""

# Step 3: Package Lambda functions
echo -e "${YELLOW}Step 3: Packaging Lambda functions...${NC}"

mkdir -p .deploy
cd .deploy

# Package token-exchange Lambda
echo "Packaging token-exchange Lambda..."
mkdir -p token-exchange
cp ../token-exchange.js token-exchange/index.js

cd token-exchange
npm init -y > /dev/null 2>&1
npm install @aws-sdk/client-sts @aws-sdk/client-kms --omit=dev > /dev/null 2>&1
zip -q -r ../token-exchange.zip .
cd ..

# Package JWKS Lambda
echo "Packaging JWKS Lambda..."
mkdir -p jwks
cp ../jwks.js jwks/index.js

cd jwks
npm init -y > /dev/null 2>&1
npm install @aws-sdk/client-kms --omit=dev > /dev/null 2>&1
zip -q -r ../jwks.zip .
cd ..

cd ..
echo "Lambda packages created"
echo ""

# Step 4: Create/Update Lambda functions
echo -e "${YELLOW}Step 4: Deploying Lambda functions...${NC}"

# Token Exchange Lambda
LAMBDA_TOKEN_NAME="${STACK_NAME}-token-exchange"
echo "Deploying token-exchange Lambda..."

if aws lambda get-function --function-name "$LAMBDA_TOKEN_NAME" --region $REGION 2>/dev/null; then
  echo "Updating existing function..."
  aws lambda update-function-code \
    --function-name "$LAMBDA_TOKEN_NAME" \
    --zip-file fileb://.deploy/token-exchange.zip \
    --region $REGION > /dev/null

  aws lambda update-function-configuration \
    --function-name "$LAMBDA_TOKEN_NAME" \
    --environment "Variables={KMS_KEY_ID=$KMS_KEY_ID,ISSUER=$ISSUER,TOKEN_LIFETIME_SECONDS=3600}" \
    --region $REGION > /dev/null
else
  echo "Creating new function..."
  aws lambda create-function \
    --function-name "$LAMBDA_TOKEN_NAME" \
    --runtime nodejs20.x \
    --handler index.handler \
    --role "$ROLE_ARN" \
    --zip-file fileb://.deploy/token-exchange.zip \
    --environment "Variables={KMS_KEY_ID=$KMS_KEY_ID,ISSUER=$ISSUER,TOKEN_LIFETIME_SECONDS=3600}" \
    --timeout 30 \
    --memory-size 256 \
    --region $REGION > /dev/null

  # Wait for function to be active
  aws lambda wait function-active --function-name "$LAMBDA_TOKEN_NAME" --region $REGION

  # Create function URL
  TOKEN_URL_CONFIG=$(aws lambda create-function-url-config \
    --function-name "$LAMBDA_TOKEN_NAME" \
    --auth-type NONE \
    --region $REGION)

  # Add permission for function URL
  aws lambda add-permission \
    --function-name "$LAMBDA_TOKEN_NAME" \
    --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl \
    --principal "*" \
    --function-url-auth-type NONE \
    --region $REGION > /dev/null 2>&1 || true
fi

# Get function URL
TOKEN_URL=$(aws lambda get-function-url-config \
  --function-name "$LAMBDA_TOKEN_NAME" \
  --region $REGION \
  --query FunctionUrl \
  --output text)

echo "Token Exchange URL: $TOKEN_URL"

# JWKS Lambda
LAMBDA_JWKS_NAME="${STACK_NAME}-jwks"
echo "Deploying JWKS Lambda..."

if aws lambda get-function --function-name "$LAMBDA_JWKS_NAME" --region $REGION 2>/dev/null; then
  echo "Updating existing function..."
  aws lambda update-function-code \
    --function-name "$LAMBDA_JWKS_NAME" \
    --zip-file fileb://.deploy/jwks.zip \
    --region $REGION > /dev/null

  aws lambda update-function-configuration \
    --function-name "$LAMBDA_JWKS_NAME" \
    --environment "Variables={KMS_KEY_ID=$KMS_KEY_ID}" \
    --region $REGION > /dev/null
else
  echo "Creating new function..."
  aws lambda create-function \
    --function-name "$LAMBDA_JWKS_NAME" \
    --runtime nodejs20.x \
    --handler index.handler \
    --role "$ROLE_ARN" \
    --zip-file fileb://.deploy/jwks.zip \
    --environment "Variables={KMS_KEY_ID=$KMS_KEY_ID}" \
    --timeout 30 \
    --memory-size 128 \
    --region $REGION > /dev/null

  # Wait for function to be active
  aws lambda wait function-active --function-name "$LAMBDA_JWKS_NAME" --region $REGION

  # Create function URL
  JWKS_URL_CONFIG=$(aws lambda create-function-url-config \
    --function-name "$LAMBDA_JWKS_NAME" \
    --auth-type NONE \
    --region $REGION)

  # Add permission for function URL
  aws lambda add-permission \
    --function-name "$LAMBDA_JWKS_NAME" \
    --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl \
    --principal "*" \
    --function-url-auth-type NONE \
    --region $REGION > /dev/null 2>&1 || true
fi

# Get function URL
JWKS_URL=$(aws lambda get-function-url-config \
  --function-name "$LAMBDA_JWKS_NAME" \
  --region $REGION \
  --query FunctionUrl \
  --output text)

echo "JWKS URL: $JWKS_URL"
echo ""

# Save deployment info
cat > deployment-output.json <<EOF
{
  "stack_name": "$STACK_NAME",
  "region": "$REGION",
  "kms_key_id": "$KMS_KEY_ID",
  "kms_key_arn": "arn:aws:kms:$REGION:$ACCOUNT_ID:key/$KMS_KEY_ID",
  "issuer": "$ISSUER",
  "token_url": "$TOKEN_URL",
  "jwks_url": "$JWKS_URL",
  "lambda_role_arn": "$ROLE_ARN"
}
EOF

echo -e "${GREEN}=== Deployment Complete ===${NC}"
echo ""
echo "Configuration:"
echo "  Issuer: $ISSUER"
echo "  Token Endpoint: $TOKEN_URL"
echo "  JWKS Endpoint: $JWKS_URL"
echo ""
echo "Deployment details saved to: deployment-output.json"
echo ""
echo -e "${YELLOW}Important: Update your ISSUER to match one of these URLs if needed:${NC}"
echo "  export ISSUER=${TOKEN_URL%/}"
echo "  ./deploy.sh"
