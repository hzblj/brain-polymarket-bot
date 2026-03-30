import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as relations from './relations';
import * as schema from './schema';

export type DbClient = ReturnType<typeof createDb>;

export function createDb(dbPath: string) {
  const sqlite = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  sqlite.pragma('journal_mode = WAL');
  // FK enforcement disabled: each service has its own SQLite DB,
  // so cross-table FKs (e.g. price_ticks → market_windows) are never satisfiable.
  sqlite.pragma('foreign_keys = OFF');

  const db = drizzle(sqlite, {
    schema: { ...schema, ...relations },
  });

  // Auto-create tables
  ensureTables(sqlite);

  return db;
}

function ensureTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS markets (
      id TEXT PRIMARY KEY,
      condition_id TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS market_windows (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL REFERENCES markets(id),
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      start_price REAL NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'unknown',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_ticks (
      id TEXT PRIMARY KEY,
      window_id TEXT NOT NULL REFERENCES market_windows(id),
      source TEXT NOT NULL,
      price REAL NOT NULL,
      bid REAL NOT NULL,
      ask REAL NOT NULL,
      event_time INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS book_snapshots (
      id TEXT PRIMARY KEY,
      window_id TEXT NOT NULL REFERENCES market_windows(id),
      up_bid REAL NOT NULL,
      up_ask REAL NOT NULL,
      down_bid REAL NOT NULL,
      down_ask REAL NOT NULL,
      spread_bps REAL NOT NULL,
      depth_score REAL NOT NULL,
      imbalance REAL NOT NULL,
      event_time INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feature_snapshots (
      id TEXT PRIMARY KEY,
      window_id TEXT NOT NULL REFERENCES market_windows(id),
      payload TEXT NOT NULL,
      event_time INTEGER NOT NULL,
      processed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_decisions (
      id TEXT PRIMARY KEY,
      window_id TEXT NOT NULL REFERENCES market_windows(id),
      agent_type TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      event_time INTEGER NOT NULL,
      processed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS risk_decisions (
      id TEXT PRIMARY KEY,
      window_id TEXT NOT NULL REFERENCES market_windows(id),
      agent_decision_id TEXT NOT NULL REFERENCES agent_decisions(id),
      approved INTEGER NOT NULL,
      approved_size_usd REAL NOT NULL DEFAULT 0,
      rejection_reasons TEXT NOT NULL,
      event_time INTEGER NOT NULL,
      processed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      window_id TEXT NOT NULL REFERENCES market_windows(id),
      risk_decision_id TEXT NOT NULL REFERENCES risk_decisions(id),
      side TEXT NOT NULL,
      mode TEXT NOT NULL,
      size_usd REAL NOT NULL,
      entry_price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      polymarket_order_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fills (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      fill_price REAL NOT NULL,
      fill_size_usd REAL NOT NULL,
      filled_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS replays (
      id TEXT PRIMARY KEY,
      from_time INTEGER NOT NULL,
      to_time INTEGER NOT NULL,
      config TEXT NOT NULL,
      results TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_health_logs (
      id TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT NOT NULL,
      checked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_configs (
      id TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS risk_configs (
      id TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      kill_switch_active INTEGER NOT NULL DEFAULT 0,
      trading_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS market_configs (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      asset TEXT NOT NULL,
      market_type TEXT NOT NULL,
      window_sec INTEGER NOT NULL,
      resolver_type TEXT NOT NULL,
      resolver_symbol TEXT NOT NULL,
      default_enabled INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategy_versions (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL REFERENCES strategies(id),
      version INTEGER NOT NULL,
      config_json TEXT NOT NULL,
      checksum TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategy_assignments (
      id TEXT PRIMARY KEY,
      market_config_id TEXT NOT NULL REFERENCES market_configs(id),
      strategy_version_id TEXT NOT NULL REFERENCES strategy_versions(id),
      priority INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategy_runs (
      id TEXT PRIMARY KEY,
      strategy_version_id TEXT NOT NULL REFERENCES strategy_versions(id),
      market_config_id TEXT NOT NULL REFERENCES market_configs(id),
      decision_id TEXT,
      replay_id TEXT,
      mode TEXT NOT NULL DEFAULT 'paper',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trade_analyses (
      id TEXT PRIMARY KEY,
      window_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      pnl_usd REAL NOT NULL,
      pnl_bps REAL NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL NOT NULL,
      side TEXT NOT NULL,
      size_usd REAL NOT NULL,
      regime_at_entry TEXT NOT NULL,
      edge_direction_at_entry TEXT NOT NULL,
      edge_magnitude_at_entry REAL NOT NULL,
      supervisor_confidence REAL NOT NULL,
      edge_accurate INTEGER NOT NULL,
      confidence_calibration TEXT NOT NULL,
      misleading_signals TEXT NOT NULL,
      correct_signals TEXT NOT NULL,
      improvement_suggestions TEXT NOT NULL,
      llm_reasoning TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_reports (
      id TEXT PRIMARY KEY,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      total_trades INTEGER NOT NULL,
      total_pnl_usd REAL NOT NULL,
      win_rate REAL NOT NULL,
      avg_edge_magnitude REAL NOT NULL,
      max_drawdown_usd REAL NOT NULL,
      performance_by_regime TEXT NOT NULL,
      performance_by_hour TEXT NOT NULL,
      agent_accuracy TEXT NOT NULL,
      risk_metrics TEXT NOT NULL,
      patterns TEXT NOT NULL,
      suggestions TEXT NOT NULL,
      executive_summary TEXT NOT NULL,
      llm_reasoning TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}
