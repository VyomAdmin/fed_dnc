-- National DNC daily-sync schema. Target: AWS RDS Postgres.
-- See .scratch/National_DNC_daily.md for the spec this implements.

CREATE TABLE IF NOT EXISTS dnc_numbers (
    area_code   CHAR(3) NOT NULL,
    number      CHAR(7) NOT NULL,
    added_at    DATE NOT NULL DEFAULT CURRENT_DATE,
    PRIMARY KEY (area_code, number)
);

CREATE TABLE IF NOT EXISTS sync_log (
    run_id           SERIAL PRIMARY KEY,
    run_date         TIMESTAMPTZ NOT NULL DEFAULT now(),
    area_code        CHAR(3) NOT NULL,
    file_type        TEXT NOT NULL CHECK (file_type IN ('full', 'change')),
    records_added    INT NOT NULL DEFAULT 0,
    records_removed  INT NOT NULL DEFAULT 0,
    status           TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed', 'stale')),
    notes            TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_log_area_code_run_date ON sync_log (area_code, run_date DESC);
CREATE INDEX IF NOT EXISTS idx_sync_log_status ON sync_log (status) WHERE status != 'success';
