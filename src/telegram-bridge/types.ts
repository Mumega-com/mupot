// Native Telegram Webhook Ingress Types for Mupot
// Edge-native Cloudflare workerd types for POST /api/webhooks/telegram

export interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
  caption?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
  edited_channel_post?: TelegramMessage
}

export interface TelegramIngressResult {
  action: 'dispatched' | 'ignored_group_unmentioned' | 'invalid_secret' | 'empty_payload'
  chatId?: number
  sender?: string
  text?: string
  messageId?: number
}
