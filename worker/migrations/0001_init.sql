CREATE TABLE IF NOT EXISTS suppressions(
  key TEXT PRIMARY KEY,
  type TEXT,
  reason TEXT,
  source TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS survey_responses(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_id TEXT,
  needs TEXT,
  timing TEXT,
  contact_pref TEXT,
  company TEXT,
  contact TEXT,
  consent INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS send_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tax_id TEXT,
  to_email TEXT,
  resend_id TEXT,
  status TEXT,
  error TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS email_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resend_id TEXT,
  type TEXT,
  email TEXT,
  created_at TEXT
);
