# Japanese wording — flagged for native-speaker review

The project owner cannot read Japanese (see CLAUDE.md's Reporting section). This file collects
Japanese script/prompt strings where the open question is **tone, formality, or warmth** — not
technical accuracy — because that's a judgment call for a native speaker, not something to guess
at in code. Every string below is quoted with its English gloss.

Do not resolve an item here by guessing at a "better" phrasing in code. Resolve it by getting a
native speaker's actual opinion, then update `client.yaml` and check this item off with a note on
what changed and why.

---

## Open items

### 1. `callbackSaved` / `callbackFailed` (ja) — worth a warmth/formality check (2026-09-23)

Raised during VP-6 while checking whether Vapi's Azure voice integration could make these lines
*sound* warmer via a speaking-style setting (confirmed it can't — see `docs/VAPI-FACTS.md` VP-6
R6, no such setting exists for Azure in Vapi). Since tone can't be adjusted at the voice layer, the
wording itself is the only lever — and that's worth a second look from a native speaker
specifically for warmth and formality, not just correctness.

**`callbackSaved.ja`** (`clients/sakura-seikotsuin/client.yaml`):
> ありがとうございます。スタッフにお伝えいたしますので、折り返しのご連絡をお待ちください。

Gloss: "Thank you. I will pass this along to staff, so please wait for a return contact."

**`callbackFailed.ja`**:
> 申し訳ございません。システムの不具合により、お客様の情報を保存できませんでした。
> お手数ですが、当院（[[clinicPhone]]）まで直接お電話ください。

Gloss: "We apologize. Due to a system malfunction, we were unable to save your information. We're
sorry for the trouble, but please call our clinic directly at [[clinicPhone]]."

**Question for a native speaker:** as written, do these read as appropriately warm/apologetic for
a phone receptionist, or does the formal/technical register ("システムの不具合" — "system
malfunction") land as flatter or more bureaucratic than intended, especially right after telling a
caller their information wasn't saved? No change made — this needs a real opinion, not a guess.

**Status:** open, not yet reviewed.
