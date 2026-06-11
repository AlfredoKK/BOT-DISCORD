#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_INPUT = '/private/tmp/discord-support-supabase-import.sql';
const DEFAULT_OUTPUT_DIR = path.join(__dirname, '../supabase/imports/sheets-import');
const DEFAULT_MAX_BYTES = 450 * 1024;

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = {
    input: DEFAULT_INPUT,
    outputDir: DEFAULT_OUTPUT_DIR,
    maxBytes: DEFAULT_MAX_BYTES,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage(0);
    } else if (arg === '--input') {
      parsed.input = argv[++i];
    } else if (arg === '--output-dir') {
      parsed.outputDir = argv[++i];
    } else if (arg === '--max-bytes') {
      parsed.maxBytes = Number(argv[++i]);
      if (!Number.isInteger(parsed.maxBytes) || parsed.maxBytes < 10000) usage();
    } else {
      usage();
    }
  }

  return parsed;
}

function usage(exitCode = 1) {
  console.error([
    'Usage:',
    '  node scripts/split-sql-import.js [--input /private/tmp/discord-support-supabase-import.sql] [--output-dir supabase/imports/sheets-import] [--max-bytes 460800]',
    '',
    'Output files contain customer data and are ignored by git.',
  ].join('\n'));
  process.exit(exitCode);
}

function stripSqlLineComments(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();
}

function statementKind(statement) {
  const clean = stripSqlLineComments(statement).replace(/\s+/g, ' ').trim().toLowerCase();
  if (clean === 'begin;') return 'transaction_control';
  if (clean === 'commit;') return 'transaction_control';
  if (clean === 'set local statement_timeout = 0;') return 'transaction_control';
  return 'statement';
}

function splitStatements(sql) {
  const statements = [];
  let start = 0;
  let inSingleQuote = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "'") {
      if (inSingleQuote && next === "'") {
        i += 1;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === ';' && !inSingleQuote) {
      const statement = sql.slice(start, i + 1).trim();
      if (statement && statementKind(statement) === 'statement') {
        statements.push(statement);
      }
      start = i + 1;
    }
  }

  return statements;
}

function chunkHeader(index, total = null) {
  const totalText = total ? `/${String(total).padStart(3, '0')}` : '';
  return [
    `-- Sheets import chunk ${String(index).padStart(3, '0')}${totalText}`,
    '-- Run chunks in numerical order in Supabase SQL editor.',
    '-- Contains customer data. Do not commit.',
    '',
    'begin;',
    'set local statement_timeout = 0;',
    '',
  ].join('\n');
}

function chunkFooter() {
  return '\ncommit;\n';
}

function renderChunk(statements, index, total = null) {
  return `${chunkHeader(index, total)}${statements.join('\n\n')}${chunkFooter()}`;
}

function main() {
  if (!fs.existsSync(args.input)) {
    console.error(`Input not found: ${args.input}`);
    process.exit(1);
  }

  fs.rmSync(args.outputDir, { recursive: true, force: true });
  fs.mkdirSync(args.outputDir, { recursive: true });

  const sql = fs.readFileSync(args.input, 'utf8');
  const statements = splitStatements(sql);
  const chunks = [];
  let current = [];

  for (const statement of statements) {
    const candidate = current.concat(statement);
    const candidateBytes = Buffer.byteLength(renderChunk(candidate, chunks.length + 1), 'utf8');

    if (current.length > 0 && candidateBytes > args.maxBytes) {
      chunks.push(current);
      current = [statement];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);

  const readme = [
    '# Sheets Import Chunks',
    '',
    'Run these SQL files in Supabase SQL editor in numerical order.',
    '',
    `Source: ${args.input}`,
    `Chunks: ${chunks.length}`,
    `Max bytes per chunk target: ${args.maxBytes}`,
    '',
    'These files contain customer data and are ignored by git.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(args.outputDir, 'README.md'), readme);

  chunks.forEach((chunk, index) => {
    const fileName = `${String(index + 1).padStart(3, '0')}_sheets_import.sql`;
    fs.writeFileSync(path.join(args.outputDir, fileName), renderChunk(chunk, index + 1, chunks.length));
  });

  console.log(`Wrote ${chunks.length} chunks to ${args.outputDir}`);
}

main();
