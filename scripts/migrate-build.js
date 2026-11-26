import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const productionBranch = process.env.D1_MIGRATION_BRANCH || 'master';
if (process.env.WORKERS_CI !== '1' || process.env.WORKERS_CI_BRANCH !== productionBranch) {
  console.log(`Skipping remote D1 migrations outside Cloudflare Workers Builds for ${productionBranch}.`);
  process.exit(0);
}

const configPath = new URL('../wrangler.json', import.meta.url);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const database = config.d1_databases.find(({ binding }) => binding === 'DB');

function findDatabaseId(name) {
  const output = execFileSync('wrangler', ['d1', 'list', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(output).find((entry) => entry.name === name)?.uuid;
}

if (!database.database_id) {
  const name = database.database_name;
  let databaseId = findDatabaseId(name);
  if (!databaseId) {
    try {
      execFileSync('wrangler', ['d1', 'create', name, '--no-update-config'], { stdio: 'inherit' });
    } catch (error) {
      // Another build may have created the database after the lookup.
      databaseId = findDatabaseId(name);
      if (!databaseId) throw error;
    }
    databaseId ||= findDatabaseId(name);
    if (!databaseId) throw new Error(`Unable to resolve the ID of D1 database ${name}.`);
  }

  // The deploy step uses this same checkout and must bind the database we migrate.
  database.database_id = databaseId;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

console.log(`Applying D1 migrations for ${database.binding} (${database.database_name}, ${database.database_id}).`);
execFileSync('wrangler', ['d1', 'migrations', 'apply', database.binding, '--remote'], { stdio: 'inherit' });
console.log(`D1 migrations complete for ${database.binding}.`);
