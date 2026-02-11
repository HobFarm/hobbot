/**
 * One-time script to set up owner email for Moltbook dashboard
 * Run after account suspension is resolved
 *
 * Usage:
 *   npx tsx scripts/setup-owner-email.ts
 */
import { MoltbookClient } from '../src/moltbook/client';

const OWNER_EMAIL = 'hobbot@hob.farm';
const API_KEY = process.env.MOLTBOOK_API_KEY || '';

async function setupEmail() {
  if (!API_KEY) {
    console.error('✗ Error: MOLTBOOK_API_KEY environment variable not set');
    console.log('→ Load from .dev.vars:');
    console.log('  export MOLTBOOK_API_KEY=your_key_here');
    process.exit(1);
  }

  const client = new MoltbookClient(API_KEY);

  try {
    console.log(`Setting up owner email: ${OWNER_EMAIL}`);
    const result = await client.setupOwnerEmail(OWNER_EMAIL);

    if (result.success) {
      console.log('✓ Owner email setup initiated');
      console.log('→ Check hobbot@hob.farm for verification email');
      console.log('→ Follow the link to verify your X account');
      console.log('→ Complete setup at https://www.moltbook.com/login');
      if (result.message) {
        console.log(`→ Message: ${result.message}`);
      }
    } else {
      console.error('✗ Setup failed:', result.message || 'Unknown error');
    }
  } catch (error) {
    console.error('✗ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

setupEmail();
