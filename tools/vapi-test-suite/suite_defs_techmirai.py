"""TechMirai AI (techmirai-ai) test scenarios, as DATA, for the VP-27 voice-quality parity work.

Same shapes and helpers as suite_defs.py (the Sakura set), so a TechMirai-aware builder can adopt them
unchanged. NOT yet wired into build_suite.py / run_suite.py: those are Sakura-only (client id, caller prompt,
tool mocks, the "SUITE " prune, one shared out/ folder). Generalising them touches live Vapi objects and
spending a run costs credit, so it needs Jamal's go-ahead; until then these scenarios are reviewed data and the
real-call checklist in docs/TECHMIRAI-REAL-CALL-CHECKLIST.md is the way to exercise them.

What a text Eval CAN and CANNOT prove (probed on the Sakura set, see README.md):
  * CAN: which reply comes after which caller line, whether a tool is called in that turn, tool arguments.
  * CANNOT: anything about audio — a "はい" said WHILE the assistant is still talking, interruptions, pauses
    between digits, speech recognition. Those are in the real-call checklist, not here.

Each scenario carries the work-order item it covers (M2 confirmation guard, M3 interruption, M4 name read-back,
M5 spoken number, CLEAN clinic-wording clean-up). Caller lines are Japanese; the id and `note` say what is tested.
Check `request_consultation` argument patterns against the first real run: Evals match a tool call's
arguments as a COMPLETE set.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from suite_defs import MORE, TR, U, ai, end, say, tool  # noqa: E402,F401

TOOL = "request_consultation"

# ---------- tool-result mocks: mirror src/routes/requestConsultation.ts ----------
SAVED_WITH_SMS = (
    "The consultation request was saved. Say staff will contact the caller to arrange a meeting, during the "
    "contact hours in your instructions. A text message has just been sent to the caller's number and should "
    "reach them shortly: you may mention it, as something that should arrive, not a guarantee."
)
SAVED_NO_SMS = (
    "The consultation request was saved. Say staff will contact the caller to arrange a meeting, during the "
    "contact hours in your instructions. No text message was sent (cooldown): do not mention a text message, "
    "and do not say why."
)
NO_CALLER_ID = (
    "There is no caller ID on this call, so nothing was saved. Ask the caller for a number they can be reached "
    'on, read it back digit by digit, and once they say yes call this tool again with phone_source "spoken".'
)

ASK_DEMO = "デモを見てみたいのですが、担当の方とお話しできますか？"  # "I'd like to see a demo; can I talk to someone?"
NAME = "マルクです。"  # "It's Marc."
YES = "はい、そうです。"  # "Yes, that's right."
OK_NUMBER = "はい、お願いします。"  # "Yes, please (use this number)."
ANOTHER_NUMBER = "いえ、別の番号でお願いします。"  # "No, please use a different number."
CALLER_ARGS = dict(contact_name=".*(マルク|Marc).*", phone_source="caller_id")

TM_EVALS = []


def tev(id_, cat, member, n, msgs, note=""):
    TM_EVALS.append({"id": id_, "category": cat, "member": member, "clock": "open", "n": n,
                     "messages": msgs, "note": note})


# M2 + M4: the name is read back as its own turn, and nothing is saved before two clear yeses ------------------
tev("TM01-consultation-full-flow", "consultation", "ja", 10,
    [U(ASK_DEMO), say("お名前"), U(NAME), say("マルク.*(様|よろしい)"), U(YES), say("番号|ご連絡"), U(OK_NUMBER),
     tool(TOOL, **CALLER_ARGS), TR(SAVED_WITH_SMS),
     ai("PASS only if the reply says staff will contact the caller to arrange a meeting, may say a text message "
        "should arrive shortly, and does NOT promise a specific time of day or say anything about a public holiday.")]
    + end("consultation|other", "resolved"),
    "M2+M4: name read-back is its own turn (no tool call, no contact question in it); then the contact question "
    "is its own turn (no tool call); only after the second yes is request_consultation called")
tev("TM02-name-correction-then-contact-question", "consultation", "ja", 5,
    [U(ASK_DEMO), say("お名前"), U(NAME), say("マルク.*(様|よろしい)"), U("いえ、マークです。"), say("マーク.*(様|よろしい)"),
     U(YES), say("番号|ご連絡")],
    "M4: a correction is fixed and READ BACK AGAIN before the contact-number question; no tool call meanwhile")
tev("TM03-unclear-answer-is-not-a-yes", "consultation", "ja", 10,
    [U(ASK_DEMO), say("お名前"), U(NAME), say("マルク.*(様|よろしい)"), U("えーと……"), say("(?s)."), U("あ、はい、そうです。"),
     say("番号|ご連絡")],
    "M2: silence/hesitation after the read-back is not a yes: no tool call, no jump to the next question as if "
    "it had been confirmed (the reply after 'えーと' must not be a tool call)")
tev("TM04-ack-after-contact-question-needs-real-yes", "consultation", "ja", 10,
    [U(ASK_DEMO), say("お名前"), U(NAME), say("マルク.*(様|よろしい)"), U(YES), say("番号|ご連絡"), U("うーん……"),
     say("(?s)."), U(OK_NUMBER), tool(TOOL, **CALLER_ARGS), TR(SAVED_NO_SMS),
     ai("PASS only if the reply does NOT mention a text message and does not say why none was sent.")],
    "M2 + SMS honesty: a hesitation is not consent; and with no SMS the assistant says nothing about a text")
tev("TM05-english-consultation-full-flow", "consultation", "en", 5,
    [U("I'd like a demo. Can I speak to someone?"), say("(?i)name"), U("It's Marc."),
     say("(?i)(confirm|correct).*marc|marc.*(correct|right)"), U("Yes, that's right."), say("(?i)number|contact"),
     U("Yes, that's fine."), tool(TOOL, contact_name="(?i).*marc.*", phone_source="caller_id"), TR(SAVED_WITH_SMS),
     say("(?i)staff.*contact|contact.*you")],
    "M2+M4 in English")

# M5: the spoken-number fallback --------------------------------------------------------------------------------
tev("TM06-withheld-number-asks-for-a-number", "spoken-number", "ja", 10,
    [U(ASK_DEMO), say("お名前"), U(NAME), say("マルク.*(様|よろしい)"), U(YES), say("番号|ご連絡"), U(OK_NUMBER),
     tool(TOOL, **CALLER_ARGS), TR(NO_CALLER_ID), say("電話番号|お伺い|教え")],
    "M5: the tool says there is no caller ID, so the assistant asks for a number (it must not say it saved anything)")
tev("TM07-spoken-number-read-back-then-save", "spoken-number", "ja", 10,
    [U(ASK_DEMO), say("お名前"), U(NAME), say("マルク.*(様|よろしい)"), U(YES), say("番号|ご連絡"), U(ANOTHER_NUMBER),
     say("電話番号|お伺い|教え"), U("ゼロ、ハチ、ゼロ、イチ、ニ、サン、ヨン、ゴ、ロク、ナナ、ハチです。"),
     ai("PASS only if the reply reads the number back with every digit spoken on its own (not as a combined number "
        "such as 'eighty'), asks whether it is correct, and calls NO tool in this turn."),
     U(YES), tool(TOOL, contact_name=".*(マルク|Marc).*", phone_source="spoken", spoken_phone=".*0.?8.?0.?1.?2.?3.?4.?5.?6.?7.?8.*"),
     TR(SAVED_NO_SMS)],
    "M5: spoken number is read back digit by digit as its own turn; saved only after a clear yes")
tev("TM08-number-with-kanji-numerals-and-midstop", "spoken-number", "ja", 10,
    [U(ASK_DEMO), say("お名前"), U(NAME), say("マルク.*(様|よろしい)"), U(YES), say("番号|ご連絡"), U(ANOTHER_NUMBER),
     say("電話番号|お伺い|教え"), U("080 123四。567八。"),
     ai("PASS only if the reply reads back ONE complete 11-digit number (080 then 1234 then 5678, digit by digit) "
        "and asks whether it is correct. FAIL if it says it could not hear / asks for the number again, or reads "
        "back fewer than 11 digits.")],
    "M5: the real Sakura failure (R22/R23): complete, correct digits split by a full stop mid-number were rejected")
tev("TM09-number-too-short-is-asked-again", "spoken-number", "ja", 5,
    [U(ASK_DEMO), say("お名前"), U(NAME), say("マルク.*(様|よろしい)"), U(YES), say("番号|ご連絡"), U(ANOTHER_NUMBER),
     say("電話番号|お伺い|教え"), U("080 1234 56です。"),
     ai("PASS only if the reply does NOT read the number back as if it were complete and instead asks for the "
        "number again (a Japanese mobile number has 11 digits) with no tool call.")],
    "M5: a short number is not accepted")

# CLEAN: no clinic behaviour on a line that takes no bookings -----------------------------------------------------
tev("TM10-no-booking-or-availability-offer", "cleanup", "ja", 10,
    [U("来週の水曜日の午前10時に予約できますか？"),
     ai("PASS only if the reply does NOT offer to book, does NOT check or promise availability or name a free time, "
        "and instead offers a consultation request / staff contact (or says it cannot book here).")],
    "CLEAN: the Limits line used to promise an availability check; TechMirai has no booking or availability tool")
tev("TM11-english-no-booking-or-availability-offer", "cleanup", "en", 5,
    [U("Can I book a slot next Wednesday at 10 a.m.?"),
     ai("PASS only if the reply does NOT offer to book, does NOT check or promise availability or name a free time, "
        "and instead offers a consultation request / staff contact (or says it cannot book here).")],
    "CLEAN, English")

# ---------- chat Simulations: (id, category, member, clock, runs, persona, instructions, criteria) ----------
TM_SIMS = [
    ("TM-S01-rushed-prospect", "adaptation", "ja", "open", 4, "ja",
     "You run a small shop and are in a hurry. Clipped replies of 1-4 words (「急いでるんで」). Goal: arrange a meeting "
     "about an AI phone agent. Name: マルク. When your name is read back say 「はい」 and when asked whether staff may "
     "use the number you are calling from say 「はい、お願いします」. After it is saved say 「ありがとう」 and end the call.",
     [("short_to_the_point", "True if the assistant's replies stayed short, with no chatty filler, once the caller was in a hurry."),
      ("name_read_back_and_contact_question_kept",
       "True if the assistant still read the name back and got a yes, and then separately asked whether staff may contact "
       "the caller's number, before saving. Brevity must not have skipped either."),
      ("no_booking_wording", "True if the assistant never offered to book an appointment or check availability.")]),
    ("TM-S02-hesitant-caller-dictates-a-number", "spoken-number", "ja", "open", 4, "ja",
     "You are elderly and speak slowly, with pauses (「えーと…」). Goal: arrange a meeting about an AI phone agent. Name: マルク. "
     "When asked whether staff may use the number you are calling from, say 「いえ、別の番号でお願いします」. Then give the number "
     "080 1234 5678 slowly, in three groups, pausing between groups, as Japanese digit words. Confirm the read-back with 「はい」. "
     "Then say 「ありがとう」 and end the call.",
     [("whole_number_heard", "True if the assistant read back the complete 11-digit number correctly, without cutting in "
       "after the first group and without asking for it again."),
      ("read_back_digit_by_digit", "True if the number was read back with each digit spoken on its own."),
      ("saved_only_after_yes", "True if the request was saved only after the caller confirmed the read-back.")]),
]


def check():
    """Offline structure check: `python3 tools/vapi-test-suite/suite_defs_techmirai.py`."""
    ids = [e["id"] for e in TM_EVALS] + [s[0] for s in TM_SIMS]
    assert len(ids) == len(set(ids)), "duplicate scenario id"
    for e in TM_EVALS:
        assert e["messages"] and e["messages"][0]["role"] == "user", e["id"]
        assert e["member"] in ("ja", "en") and e["n"] >= 1, e["id"]
        assert any(m["role"] == "assistant" for m in e["messages"]), e["id"]
    for s in TM_SIMS:
        assert len(s) == 8 and s[7], s[0]
    print("ok: %d evals, %d simulations" % (len(TM_EVALS), len(TM_SIMS)))


if __name__ == "__main__":
    check()
