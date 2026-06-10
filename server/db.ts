/**
 * db.ts — Shared SQLite connection
 *
 * Single source-of-truth for the database path.
 * Railway: mount a Volume at /data and set RAILWAY_VOLUME_MOUNT_PATH=/data
 * Local dev: falls back to data.db in process.cwd()
 *
 * ALL modules import { getDb } from './db' — never open their own Database().
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

function resolveDbPath(): string {
  // Railway persistent volume
  const railwayVol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (railwayVol) {
    if (!fs.existsSync(railwayVol)) {
      fs.mkdirSync(railwayVol, { recursive: true });
    }
    return path.join(railwayVol, 'data.db');
  }
  // Fallback — local dev / no volume
  return path.resolve(process.cwd(), 'data.db');
}

export const DB_PATH = resolveDbPath();

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('busy_timeout = 5000');
    console.log(`[db] SQLite opened: ${DB_PATH}`);
  }
  return _db;
}
