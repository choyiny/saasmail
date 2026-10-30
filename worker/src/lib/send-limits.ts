// Per-message limits every send path enforces. They are Cloudflare Email
// Service's, the strictest provider saasmail supports, so a message accepted
// here is accepted by every provider.
// https://developers.cloudflare.com/email-service/api/send-emails/workers-api/

/** Recipients per message, To, Cc and Bcc combined. */
export const MAX_RECIPIENTS = 50;

/** Cc entries next to the single To of a composed, replied or JMAP message. */
export const MAX_CC_ENTRIES = MAX_RECIPIENTS - 1;

/** Attachments per message, inline parts included. */
export const MAX_SEND_ATTACHMENTS = 32;
