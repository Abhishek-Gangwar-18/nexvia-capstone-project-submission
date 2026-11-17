import mongoose from 'mongoose';

/**
 * Every webhook event received, keyed by the provider's event id, so a redelivered event is recognised
 * and skipped. Kept for 30 days for support.
 */
const webhookEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  receivedAt: { type: Date, default: Date.now },
  processedAt: Date,
  error: String,
});

webhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const WebhookEvent = mongoose.model('WebhookEvent', webhookEventSchema);
