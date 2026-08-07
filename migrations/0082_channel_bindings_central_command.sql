-- migration 0082_channel_bindings_central_command.sql
-- Binds central-command Telegram channel (-5317747241) to squad-core.

INSERT OR IGNORE INTO departments (id, slug, name)
VALUES ('dept-core', 'core', 'Dept Core');

INSERT OR IGNORE INTO squads (id, department_id, slug, name)
VALUES ('squad-core', 'dept-core', 'core', 'Squad Core');

INSERT OR IGNORE INTO channel_bindings (id, platform, external_channel_id, squad_id, max_capability)
VALUES ('central-command-telegram', 'telegram', '-5317747241', 'squad-core', 'member');
