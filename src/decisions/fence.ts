// src/decisions/fence.ts — untrusted-text fencing before text reaches a decision model.
//
// DEFENCE IN DEPTH, NOT A GUARANTEE. Pattern stripping cannot make prompt injection
// impossible, and a determined attacker can rephrase. The real containment is structural:
// the model can only RANK/PROPOSE (see port.ts) and every failure path goes to a human.
// This helper only removes the cheap, obvious carriers and bounds the length.

export const DEFAULT_MAX_STATE_CHARS = 2000

// Control chars except \n and \t, zero-width, and bidi override/isolate characters.
// eslint-disable-next-line no-control-regex
const HIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g
const CHAT_TEMPLATE_TOKENS = /<\|[^|>]{0,64}\|>|\[\/?INST\]|<<\/?SYS>>/gi
const ROLE_LINE = /^(\s*)(system|assistant|developer|user|human|ai)\s*:/gim
const INSTRUCTION_PHRASES =
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any)\b[^.\n]{0,40}\b(instructions?|rules?|prompts?|criteria)\b/gi
const CODE_FENCE = /`{3,}|~{3,}/g

export function fenceUntrustedText(text: string, maxChars: number = DEFAULT_MAX_STATE_CHARS): string {
  const cleaned = text
    .normalize('NFKC')
    .replace(HIDDEN_CHARS, '')
    .replace(CHAT_TEMPLATE_TOKENS, '[removed-token]')
    .replace(CODE_FENCE, '[fence]')
    .replace(ROLE_LINE, '$1[role]:')
    .replace(INSTRUCTION_PHRASES, '[removed-instruction-like-text]')
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned
}
