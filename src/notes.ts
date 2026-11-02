// What agents are told in a hand-off, as fixed text: the stage briefs, the rules for advice and reviews, the checks notes.

export const FEASIBILITY =
  "Feasibility: note it only for a concept that could kill the idea or force a different one, and that isn't plainly known (work nobody here has done before, an assumption about how parts fit, a solution assumed to exist). Swappable mechanics (how a model or service is connected, which parser or file format, storage, configuration) get no feasibility note and no options: one line, \"left to the how stage\". In a code project, code facts count: what language, standard, build system, interface or platform the code where the feature goes supports, quoted with `path:line`."

export const ANALYST_WHAT = [
  "Stage: WHAT. This stage decides what to build and how it behaves as a process, independent of code: no files, functions, interfaces, storage, flags or tests. The implementation plan comes later, after the user approves the what-document.",
  "Read every file the request names in full first, then what they connect to (material, code). Read to understand the problem; code matters here only where it rules a behaviour in or out.",
  "The Planner has no file access: your brief and your later answers are all it knows. Quote, don't paraphrase.",
  [
    "Write `content` in two parts. First `## Concept brief` (the user may read it before the Planner writes):",
    "- **Concerns**: the concepts that decide whether the result is good. The ones the user named or stressed first, in their framing; then ones they didn't mention but should consider. The user's material is a starting point, not the boundary: think beyond it. For each: why it matters (with the source when the user's material says so), and 2-3 approaches with what each trades off; your pick goes in the section's closing Recommended line.",
    `- ${FEASIBILITY}`,
    "- **Assumptions**: defaults you'd take where nothing settles a point, each marked as assumed.",
    "Then `## Excerpts`: the verbatim passages (with `path:line` or file and heading) the Planner needs, grouped by concern. Nothing else: don't restate the request, the Planner gets it.",
  ].join("\n"),
].join("\n\n")

export const ADVICE_RULES = [
  "Read the user's comments across all rounds: what do they keep asking for that the draft still doesn't give? Think independently: the user's material and examples are a starting point, not the boundary. Look for concerns, approaches, edge cases and failure modes nobody has named yet.",
  "You have no file access: when you need a fact from the code or the user's files, ask Analyst first (ASK).",
].join("\n\n")

export const ANALYST_ASK = "Questions for the user: at most 4, most important first; put anything with a sensible default in the brief as an assumption."

export const ANALYST_CODE = [
  "Workflow: code. Decide TRIVIAL or ESCALATE (see your instructions). For ESCALATE, set `what`:",
  "- **settled**: the request already fixes the behaviour (\"add a --upper flag that uppercases the output\"); only the implementation is open. Write the how brief below, starting with `## Why the behaviour is settled` (one or two lines). The plan will start with a short Behaviour section instead of a separate what-document.",
  "- **open**: what the feature should do, as a process, is still to decide (a new feature, several valid behaviours). Write the what brief below. The user approves the behaviour before anyone plans code.",
  "When unsure, it is open.",
].join("\n")

export const HOW_BRIEF = [
  "Stage: HOW. Brief the Planner for the change plan. The Planner has no file access: your brief and your later answers are all it knows, so have the Intern search (NEED_INFO) until every place the change touches can be shown.",
  [
    "Write `content` with:",
    "- `## Code`: each location that will change, as `path:start-end` with the current code excerpt (exact lines), and the patterns or analogous features the change should follow.",
    "- `## Impact`: for each location, what depends on it: callers, users of the interface, build files, tests, other modules, found by the Intern's searches and listed with `path:line`. Say \"no other users\" only after the Intern searched for them.",
    "- `## Constraints`: code facts that limit the change (language and standard, build system, platform, public interfaces).",
    "Don't restate the request or the what-document; the Planner gets both.",
  ].join("\n"),
].join("\n\n")

export const ANALYST_INFEASIBLE = "If a decision of the what-document can't work in this code, say so (INFEASIBLE); don't quietly plan around it."

export const ANALYST_REVISION = [
  "MODE: revision. The user commented on the {doc} below. Don't rewrite it; brief the Planner, who revises it.",
  "Where the comments give examples, treat them as examples: find every place in the document with the same problem, not only the ones named. Check the files the request names, and the code or material they connect to, where the comments need it.",
  "The Planner has no file access: quote what it needs (`path:line`, excerpt). Don't repeat what your earlier brief and answers already hold; point to them.",
  "Report ESCALATE with the revision brief: each change, with the section it applies to, what is wrong and what it should become; the places you found beyond the ones named; and what must stay as it is. QUESTIONS only if a comment leaves open a decision that belongs to the user.",
].join("\n\n")

export const ANALYST_ANSWER =
  "MODE: answer. {asker} has no file access and asks you the questions below. Look up what you need (have the Intern search first when you need new facts), then report ANSWER."

export const ANALYST_RESEARCH = [
  "Workflow: research. The deliverable is a findings report, not code: nobody edits files in this task, and there is no build or test.",
  "Read every file the request names in full first, then have the Intern search (NEED_INFO) to see where the answer lives.",
  "Size the research (`depth`):\n- **quick**: one focused question with one direct path to the answer.\n- **breadth**: splits into distinct, independent sub-questions.\n- **depth**: one question that needs several angles or sources.",
  [
    "Write `content` in two parts. First `## Research brief`, phrased from the user's point of view:",
    "- the question, and the sub-questions that together answer it",
    "- every detail and preference the user gave; dimensions they didn't state are open-ended, not invented",
    "- mode: **descriptive** (document what exists; the default) or **evaluative** (compare and recommend; only when the user asked to compare, choose or recommend)",
    "- where to look (paths, the user's files, the web) and what is out of scope",
    "Then `## Findings so far`: what you found, with `path:line` or the URL and short verbatim excerpts.",
  ].join("\n"),
  "When the question reaches beyond the code (libraries, APIs, standards, other projects, anything on the web), have the Operator search the web and open the pages (RUN, when offered) and put what you use in Findings so far, with the URL and a verbatim excerpt: the agents after you search only the code.",
  "Report ESCALATE with `depth`. Report QUESTIONS (one round at most) only when the question itself is unclear: unknown terms or acronyms, or a choice only the user can make. Don't ask for what the user already gave.",
].join("\n\n")

export const INTERN_RESEARCH =
  "MODE: research search for the Planner. Return evidence, not prose. For each query, a list of records: **claim** (one fact), **source** (`path:line`, the file, or the URL), **excerpt** (the few lines, verbatim; don't paraphrase or summarize them). \"Not found\" is a finding: say what you searched. When sources conflict, give both. When a source speculates (\"could\", \"may\", plans), say so. Stop a query when your last two searches added nothing new. Report FOUND, or NOT_FOUND with what you searched."

export const REVIEW_PLAN = [
  "Part 1, can it be built as written. Check that each reference the document makes is backed by the brief, Analyst's answers or the user's words, and says what the document claims. Simulate building 2-3 representative parts as a capable builder who cannot talk to the author: where would you have to guess, and would a wrong guess matter (more than about 10% guesswork)? Check that every requirement and constraint in the request maps to a decision and to a verification, that acceptance criteria are observable, and that names and interfaces are consistent. Skip anything the document explicitly leaves to the builder, anything a builder could reasonably decide alone, and wording nitpicks.",
  "Part 2, is it the right design. Were the strongest alternative and \"use what exists\" weighed? Is anything built that the request doesn't need (layers, options, future-proofing)? Are the risks named, and are the assumed decisions reasonable defaults? Here you may disagree with the approach: say concretely what you would do instead and why.",
].join("\n\n")

export const REVIEW_RESEARCH = [
  "Part 1, the evidence. Spot-check the key references against the findings and the brief: are they there, and do they say what is claimed? Every sub-question of the brief is answered or listed under Gaps; no claim goes beyond its source; conflicts are reported, not hidden; speculation is flagged; descriptive mode has no recommendations.",
  "Part 2, is it the right answer. Are there sources or angles it missed that would change the conclusion? In evaluative mode, does the recommendation follow from the evidence?",
].join("\n\n")

export const checksText = (commands: string) =>
  [
    "# Build and test commands",
    "Only Developer runs them; the other agents don't build or test, they put these commands into the instruction or plan as check commands. Use only these; don't look for other ways to build or test. If they don't cover what is needed, the planner asks the user (QUESTIONS) and Developer reports BLOCKED.",
    commands,
  ].join("\n\n")

export const SKIP_CHECKS = [
  "# Build and test: skipped",
  "The user chose to skip build and test for this task. Don't build, don't run tests, and don't look for how to.",
  "Plans and the trivial instruction give `none` as the check. Developer reports DONE once the edits are made (checkCommand `none`).",
].join("\n\n")
