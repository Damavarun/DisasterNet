import { z } from 'zod';

export const roomId = z.string().regex(/^[a-z0-9-]{1,48}$/);
export const categories = ['Medical', 'Trapped', 'Evacuation', 'Food & water', 'Other'];
export const messageInput = z.object({
  roomId: roomId.default('general'),
  senderName: z.string().trim().min(1).max(60),
  body: z.string().trim().min(1).max(2000),
  kind: z.enum(['chat', 'sos']).default('chat'),
  category: z.enum(categories).optional(),
  location: z.string().trim().max(160).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'sos' && !value.category) ctx.addIssue({ code: 'custom', path: ['category'], message: 'Choose an emergency category' });
});

export const wireMessage = z.object({
  id: z.uuid(),
  roomId,
  senderId: z.string().min(10).max(128),
  senderName: z.string().trim().min(1).max(60),
  body: z.string().trim().min(1).max(2000),
  kind: z.enum(['chat', 'sos']),
  category: z.enum(categories).optional(),
  location: z.string().max(160).optional(),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
}).strict().superRefine((value, ctx) => {
  if (value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > 7 * 86400000) {
    ctx.addIssue({ code: 'custom', message: 'Invalid message lifetime' });
  }
  if (value.createdAt > Date.now() + 300000) ctx.addIssue({ code: 'custom', message: 'Message timestamp is too far in the future' });
  if (value.kind === 'sos' && !value.category) ctx.addIssue({ code: 'custom', message: 'Missing SOS category' });
});

export function toWire(message) {
  return wireMessage.parse(Object.fromEntries(
    ['id', 'roomId', 'senderId', 'senderName', 'body', 'kind', 'category', 'location', 'createdAt', 'expiresAt']
      .filter(key => message[key] != null).map(key => [key, message[key]]),
  ));
}
