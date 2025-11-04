#!/bin/bash

set -e

# Configuration
STACK_NAME="${STACK_NAME:-aws-oidc-workload-identity}"
REGION="${AWS_REGION:-us-east-1}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${RED}=== AWS OIDC Workload Identity Cleanup ===${NC}"
echo "Stack Name: $STACK_NAME"
echo "Region: $REGION"
echo ""

read -r -p "Are you sure you want to destroy all resources? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then
  echo "Cleanup cancelled"
  exit 0
fi

# Step 1: Delete Lambda functions
echo -e "${YELLOW}Step 1: Deleting Lambda functions...${NC}"

LAMBDA_TOKEN_NAME="${STACK_NAME}-token-exchange"
LAMBDA_JWKS_NAME="${STACK_NAME}-jwks"
LAMBDA_DISCOVERY_NAME="${STACK_NAME}-discovery"

for LAMBDA_NAME in "$LAMBDA_TOKEN_NAME" "$LAMBDA_JWKS_NAME" "$LAMBDA_DISCOVERY_NAME"; do
  echo "Deleting $LAMBDA_NAME..."

  # Delete function URL config if exists
  aws lambda delete-function-url-config \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" 2>/dev/null || true

  # Delete function
  aws lambda delete-function \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" 2>/dev/null || true
done

echo "Lambda functions deleted"
echo ""

# Step 2: Delete IAM role
echo -e "${YELLOW}Step 2: Deleting IAM role...${NC}"

ROLE_NAME="${STACK_NAME}-lambda-role"

# Detach managed policies
aws iam detach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" \
  --region "$REGION" 2>/dev/null || true

# Delete inline policies
aws iam delete-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "${STACK_NAME}-permissions" \
  --region "$REGION" 2>/dev/null || true

# Delete role
aws iam delete-role \
  --role-name "$ROLE_NAME" \
  --region "$REGION" 2>/dev/null || true

echo "IAM role deleted"
echo ""

# Step 3: Delete KMS key (schedule deletion)
echo -e "${YELLOW}Step 3: Scheduling KMS key deletion...${NC}"

KMS_KEY_ID=$(aws kms list-aliases --query "Aliases[?AliasName=='alias/$STACK_NAME'].TargetKeyId" --output text --region "$REGION")

if [ -n "$KMS_KEY_ID" ]; then
  # Delete alias first
  aws kms delete-alias \
    --alias-name "alias/$STACK_NAME" \
    --region "$REGION" 2>/dev/null || true

  # Schedule key deletion (minimum 7 days)
  aws kms schedule-key-deletion \
    --key-id "$KMS_KEY_ID" \
    --pending-window-in-days 7 \
    --region "$REGION" 2>/dev/null || true

  echo "KMS key scheduled for deletion in 7 days: $KMS_KEY_ID"
  echo "To cancel: aws kms cancel-key-deletion --key-id $KMS_KEY_ID --region $REGION"
else
  echo "No KMS key found"
fi

echo ""

# Step 4: Clean up local files
echo -e "${YELLOW}Step 4: Cleaning up local files...${NC}"

rm -rf .deploy
rm -f deployment-output.json

echo "Local deployment files cleaned up"
echo ""

echo -e "${GREEN}=== Cleanup Complete ===${NC}"
echo ""
echo -e "${YELLOW}Note: KMS key will be deleted in 7 days${NC}"
