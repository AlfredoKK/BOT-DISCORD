#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config();

const ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'supabase/migrations/202605150001_initial_business_schema.sql');

const TARGETS = {
  licall: 'SUPABASE_LICALL_DB_URL',
  secondary: 'SUPABASE_SECONDARY_DB_URL',
};

function usage(exitCode = 1) {
  console.error([
    'Usage:',
    '  node scripts/supabase-db.js check <licall|secondary>',
    '  node scripts/supabase-db.js migrate <licall|secondary>',
    '',
    'Required env:',
    '  SUPABASE_LICALL_DB_URL=postgresql://postgres:<password>@db.zvfhhcxsdzyubufmexng.supabase.co:5432/postgres',
    '  SUPABASE_SECONDARY_DB_URL=postgresql://postgres:<password>@<host>:5432/postgres',
  ].join('\n'));
  process.exit(exitCode);
}

function redact(url) {
  return String(url || '').replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

function requireUrl(target) {
  const envName = TARGETS[target];
  if (!envName) usage();

  const url = process.env[envName];
  if (!url || url.includes('[YOUR-PASSWORD]') || url.includes('[YOUR-HOST]')) {
    console.error(`Missing usable ${envName} in .env`);
    process.exit(1);
  }
  return { envName, url };
}

function runPsql(url, args) {
  const result = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', url, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status || 1);
}

function main() {
  const [command, target] = process.argv.slice(2);
  if (!command || !target || !['check', 'migrate'].includes(command)) usage();

  const { envName, url } = requireUrl(target);
  console.log(`[supabase-db] ${command} target=${target} env=${envName} url=${redact(url)}`);

  if (command === 'check') {
    runPsql(url, [
      '-c',
      "select current_database() as database, current_user as user_name, inet_server_addr() as server_addr, current_setting('server_version') as server_version;",
    ]);
    return;
  }

  if (!fs.existsSync(MIGRATION_PATH)) {
    console.error(`Migration not found: ${MIGRATION_PATH}`);
    process.exit(1);
  }

  runPsql(url, ['-f', MIGRATION_PATH]);
}

main();
