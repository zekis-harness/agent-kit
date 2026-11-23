---
name: ui-copy
description: Rules for the words in a user interface (headings, subtitles, helper text, empty states, status lines). Use whenever building or editing UI, so screens carry labels and data instead of explanations.
---

# UI copy

The interface shows data and actions. Text that explains, narrates or repeats what is already visible is noise, and on a phone it pushes the content below the fold.

## Cut

- Subtitles and eyebrows that restate the title or describe the page ("What your agents know", "Year, quarter, month, week" above a goals graph that shows exactly that).
- Lines that tell the user what a button or section is for ("Sort them into tasks, notes or the archive" under a Process button).
- Implementation details: where it runs, how it is stored or computed ("It runs on the server", "Saved, encrypted", "Estimate = balance plus rate / 365").
- Formula or rule explanations under a number ("Take-home minus your budget, or your spend once it passes it"). The label should carry the meaning; if it can't, rename the label.
- Counts that duplicate the list below them ("1 change in 1 item").
- Decorative metadata nobody acts on ("Week 47").
- Qualifiers on labels ("Owed today, estimated" becomes "Owed today").
- Usage hints over interactive views ("Tap a goal to open it, tap + to expand it"). Affordances should be obvious from the controls.
- Coaching and encouragement in empty states. "Nothing closed." is enough; skip the "Tasks you finish will show up here so you can..." tail.
- The same fact shown twice (a confirmed date in the header and on every row).

## Keep

- Warnings about consequences the user can't undo or might not expect (signs out other devices, codes shown once, a token that grants email access).
- Input syntax help the user needs while typing (quick-add tokens like `!1 #tag`).
- Error and failure text, and status that changes what the user should do ("Saved on this device only", with a Sync button).
- Security and consent text on auth screens.
- Content pages whose purpose is the explanation (a talk, a tax breakdown).

## Defaults

- One label per element. No sentence where a word works.
- Empty state: one short line, plus an action button if there is an obvious next step.
- Success status: one word ("Saved", "Logged").
- Before finishing UI work, read every new or changed string and ask: would the screen lose anything a user needs if this were gone? If not, delete it.
