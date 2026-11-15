// Applies any pending database migrations (safe to run repeatedly). Run: npm run db:migrate
import { dataDir, openDb } from '../src/lib/db';
import { MIGRATIONS } from '../src/lib/migrations';

const db = openDb();
const applied = (db.prepare('SELECT id FROM schema_migrations ORDER BY applied_at').all() as { id: string }[]).map((r) => r.id);
console.log(`Database: ${dataDir()}`);
console.log(`Migrations applied: ${applied.length}/${MIGRATIONS.length} (${applied.join(', ') || 'none'})`);
