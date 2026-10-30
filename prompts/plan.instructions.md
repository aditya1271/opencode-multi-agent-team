## The what-document

The what-document decides **what gets built and how it behaves**, as a process the user can picture, before anyone plans code. It is independent of code: no files, functions, classes, interfaces, storage, flags, libraries or tests. The how stage turns it into a change plan later, from this document alone, so everything decided here must be in it.

Write for the user. Keep their framing and their words for the concepts they named; add what they didn't mention but should consider, marked as such.

### Sections

1. **What it does**: in a few lines, what the user gets and why. Then **Non-goals**: what it deliberately doesn't do.
2. **The process**: what happens, step by step, from the user's point of view or the data's: inputs, what is done to them, outputs, what the user sees and decides along the way. Number the steps.
3. **When it happens**: what triggers it, how often, and what happens on failure or on input it can't handle (as behaviour, not error codes).
4. **Choices**: for each concept that decides whether the result is good, the two or three real approaches, what each trades off, and which one is chosen and why. The concepts the user stressed come first. When there is genuinely one sensible way, say so in one line.
5. **Feasibility**: only for a concept that could kill the idea or force a different one and isn't plainly known (work nobody has done before, an assumption about how parts fit, a solution assumed to exist): what is uncertain, what the brief or answers show, and what happens if it fails. Swappable mechanics (how a model or service is connected, which file format or parser, storage, configuration) get no feasibility note and no options: one line, "left to the how stage". In a code project, code facts count where they rule a behaviour in or out (what the language, platform or module supports), with the evidence.
6. **Decisions**: one line each: the decision, the reason, and whose it is: **yours** (only when the user said it, in the request or their answers), **from your material** (the user's files say so; name the file), or **assumed** (the team's default, which the user can reject). Every default goes here: a default the user never heard is one they couldn't reject.
7. **Risks and open questions**: what could make the result disappoint, and anything neither the request, the answers nor the material settles, each with the recommended answer.

Leave out a section that doesn't apply (say so in one line). Scale to the request: a small feature gets a short document that covers the same points in a line or two each.

### Self-review before you report

1. **Coverage**: every requirement, constraint and user answer is handled somewhere. Add what is missing.
2. **Code-free**: no file, function, interface, storage or test names. Move such details out; they belong to the how stage.
3. **Decision scan**: every line decides something or states a fact. "TBD", "handle edge cases", "as appropriate" are failures.
4. **Evidence**: every claim about the user's material or the code is backed by the brief or Analyst's answers.
