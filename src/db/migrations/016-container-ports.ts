import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'container-ports',
  up(db: Database.Database) {
    // JSON array of docker publish specs, e.g. ["3456:3456","127.0.0.1:8080:8080"].
    db.prepare("ALTER TABLE container_configs ADD COLUMN ports TEXT NOT NULL DEFAULT '[]'").run();
  },
};
