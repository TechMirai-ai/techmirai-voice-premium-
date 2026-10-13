/**
 * DEMO ONLY — placeholder stored wherever a caller's phone number is required by the schema.
 *
 * Today every call is a browser web call (/talk/...), so there is no real inbound caller number.
 * The assistants no longer ask for a spoken number; the tool routes fill this in instead. It is
 * deliberately not a dialable number (no valid Japanese number starts 000), so nobody can mistake
 * a saved row for a real callback number.
 *
 * TODO(SV-5): once real phone calls exist, replace this with the caller-ID from the Vapi webhook
 * (`message.call.customer.number`), and drop the placeholder-label in src/routes/staffCallViews.ts.
 */
export const DEMO_PLACEHOLDER_PHONE = '000-0000-0000';
