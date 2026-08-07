-- 0082_channel_bindings_central_command.sql
-- mumega-com#722: bind the central-command Telegram group (-5317747241) to squad-core.

INSERT OR IGNORE INTO channel_bindings (id, platform, external_channel_id, squad_id, max_capability)
SELECT 'central-command-telegram', 'telegram', '-5317747241', id, 'member'
FROM squads WHERE slug = 'core';

INSERT OR IGNORE INTO channel_bindings (id, platform, external_channel_id, squad_id, max_capability)
SELECT 'central-command-telegram', 'telegram', '-5317747241', id, 'member'
FROM squads WHERE slug = 'squad-core'
  AND NOT EXISTS (SELECT 1 FROM channel_bindings WHERE id = 'central-command-telegram');
