-- Migration 048: Seed default admin_pin in site_settings

INSERT INTO site_settings (key, value)
VALUES ('admin_pin', '1234')
ON CONFLICT (key) DO NOTHING;
