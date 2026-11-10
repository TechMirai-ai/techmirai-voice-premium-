/** The plain identifiers the model calls — shared by the prompt, the tool definitions and the webhook routes. */
export const REQUEST_CALLBACK_FUNCTION_NAME = 'request_callback';
export const LOG_CALL_TOPIC_FUNCTION_NAME = 'log_call_topic';
/** Vapi's built-in end-call tool — fixed function name, not ours to choose (docs.vapi.ai/tools/default-tools). */
export const END_CALL_FUNCTION_NAME = 'endCall';
/** VP-8 demo reservation tools. */
export const CHECK_AVAILABILITY_FUNCTION_NAME = 'check_availability';
export const LOOKUP_PATIENT_FUNCTION_NAME = 'lookup_patient';
export const BOOK_APPOINTMENT_FUNCTION_NAME = 'book_appointment';
/** VP-25: cancel or reschedule a booking the caller made, for clients with `reservationFlow.changes`. */
export const FIND_MY_APPOINTMENTS_FUNCTION_NAME = 'find_my_appointments';
export const CANCEL_APPOINTMENT_FUNCTION_NAME = 'cancel_appointment';
export const RESCHEDULE_APPOINTMENT_FUNCTION_NAME = 'reschedule_appointment';
/** VP-26: the caller's last visit (date + service only), for clients with `reservationFlow.recall`. */
export const RECALL_LAST_VISIT_FUNCTION_NAME = 'recall_last_visit';
/** VP-20: postal code → prefecture / city / town, for clients that collect a service address. */
export const LOOKUP_POSTAL_CODE_FUNCTION_NAME = 'lookup_postal_code';
/**
 * VP-24: our own function tool for a live transfer to staff. It is NOT Vapi's native `transferCall`
 * tool: the server checks hours and volume first, then starts the transfer through Live Call
 * Control (docs/VAPI-FACTS.md VP-24 R7).
 */
export const TRANSFER_TO_STAFF_FUNCTION_NAME = 'transfer_to_staff';
/** VP-16: the silence-escalation hook's tool — speaks the ending announcement and hangs up via Live Call Control. */
export const SILENCE_END_CALL_FUNCTION_NAME = 'silence_end_call';
