/**
 * Encrypt environment variables for Phala TEE deployment
 *
 * Usage: node scripts/encrypt-env.mjs <app-id>
 */

import { encryptEnvVars } from '@phala/dstack-sdk';
import { readFileSync } from 'fs';

const APP_ID = process.argv[2];

if (!APP_ID) {
  console.error('Usage: node scripts/encrypt-env.mjs <app-id>');
  console.error('Get your app-id from the Phala Cloud dashboard after creating the CVM');
  process.exit(1);
}

// Load Firebase credentials
const firebaseCreds = readFileSync('C:\\Users\\james\\Downloads\\hivemind-476519-d174ae36378a.json', 'utf-8');

// Environment variables to encrypt
const envVars = [
  { key: 'FIREBASE_SERVICE_ACCOUNT', value: firebaseCreds.replace(/\n/g, '').replace(/\s+/g, ' ') }
];

async function main() {
  console.log('Fetching encryption public key from Phala KMS...');

  // Get public key from Phala KMS
  const response = await fetch('https://cloud-api.phala.network/api/v1/cvms/app-env-encrypt-pubkey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID })
  });

  if (!response.ok) {
    // Try alternate endpoint
    const altResponse = await fetch(`https://cloud-api.phala.network/prpc/GetAppEnvEncryptPubKey?json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APP_ID })
    });

    if (!altResponse.ok) {
      console.error('Failed to get encryption public key');
      console.error('Response:', await altResponse.text());
      process.exit(1);
    }

    const data = await altResponse.json();
    console.log('Got public key:', data.public_key?.substring(0, 20) + '...');

    const encrypted = await encryptEnvVars(envVars, data.public_key);
    console.log('\n=== ENCRYPTED ENV VARS ===');
    console.log(encrypted);
    console.log('========================\n');
    console.log('Use this encrypted payload when deploying to Phala Cloud');
    return;
  }

  const data = await response.json();
  console.log('Got public key:', data.public_key?.substring(0, 20) + '...');

  const encrypted = await encryptEnvVars(envVars, data.public_key);
  console.log('\n=== ENCRYPTED ENV VARS ===');
  console.log(encrypted);
  console.log('========================\n');
  console.log('Use this encrypted payload when deploying to Phala Cloud');
}

main().catch(console.error);
