/**
 * DEMO ONLY — placeholder stored wherever a caller's phone number is required by the schema.
 *
 * Today every call is a browser web call (/talk/...), so there is no real inbound caller number.
 * The assistants no longer ask for a spoken number; the tool routes fill this in instead. It is
 * deliberately not a dialable number (no valid Japanese number starts 000), so nobody can mistake
 * a saved row for a real callback number.
 *
 * Since VP-15 the /talk page collects a caller-typed number and the tool routes use that; this
 * placeholder remains only for calls that carry no number (older rows, the internal test pages).
 * TODO(SV-5): once real phone calls exist, make `callerPhoneFromCall` (src/vapi/callVariables.ts)
 * read the caller-ID (`call.customer.number`), and drop the placeholder-label in
 * src/routes/staffCallViews.ts.
 */
export const DEMO_PLACEHOLDER_PHONE = '000-0000-0000';
