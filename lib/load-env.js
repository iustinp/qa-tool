/**
 * Load configuration from this package directory only (standalone repo).
 * Does not read parent monorepo .env files.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

/** Absolute path to tools/page-pair-diff (package root). */
const TOOL_ROOT = path.resolve(__dirname, '..');

function normalizeEnvValues() {
  const bearer = 'AWS_BEARER_TOKEN_BEDROCK';
  if (process.env[bearer]) {
    process.env[bearer] = process.env[bearer].trim().replace(/^\uFEFF/, '');
  }
  for (const key of ['AWS_REGION', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY']) {
    if (process.env[key]) {
      process.env[key] = process.env[key].trim().replace(/^\uFEFF/, '');
    }
  }
}

/**
 * Load .env from the package root (and optional .env.local).
 * File values override existing shell env (override: true).
 */
function loadEnv() {
  const candidates = [
    path.join(TOOL_ROOT, '.env'),
    path.join(TOOL_ROOT, '.env.local'),
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override: true });
    }
  }
  normalizeEnvValues();
  return TOOL_ROOT;
}

module.exports = {
  loadEnv,
  TOOL_ROOT,
  normalizeEnvValues,
};
