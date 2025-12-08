#!/bin/bash

echo "📄 Creating test bill..."

# Create a simple test bill
cat > test-bill.txt << 'BILL'
NATI EXPENSE RECEIPT
====================
Date: 2025-11-28
Category: Food

Item: Team Lunch
Vendor: Restaurant ABC
Amount: ₹1,500

Notes: Team meeting lunch expense
BILL

echo "✅ Test bill created"
echo ""
echo "📤 Uploading to system..."
echo ""

# Upload using curl
curl -X POST http://localhost:3000/api/upload \
  -F "bill=@test-bill.txt" \
  -F "category=food" \
  -F "notes=Test upload - team lunch" \
  | python3 -m json.tool

echo ""
echo "✅ Upload complete!"
echo ""
echo "📋 Fetching all documents..."
echo ""

# Get all documents
curl http://localhost:3000/api/documents | python3 -m json.tool

echo ""
