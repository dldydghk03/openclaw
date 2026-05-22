# Anki Factory Architecture Spec v0.1

## Executable Agent Specs

- Agent profile: `profiles/anki-factory-agent.v0.1.profile.json`
- Workflow runbook: `workflows/anki-factory-agent.v0.1.workflow.md`
- State machine: `workflows/anki-factory-agent.v0.1.state-machine.json`

## Goal

Build Anki decks from lecture notes, jokbo, and t-check material while preserving the standardized Anki v1.6 format. The system should learn from high-quality reference APKGs by 한상준, 이상훈, and 이원재, but it must never invent or mutate card templates.

The primary learning goal is no-base comprehension: a learner with little prior context should be able to flip through the cards and understand the part, not just memorize unexplained words. If a card would force rote memorization of a difficult term, add a short bridge explanation or split it.

## Non-Negotiable Format Rules

- Generated cards must use only `@표준화 Basic`, `@표준화 Cloze`, or `@표준화 뉴족보`.
- The agent must not create a new note type.
- The agent must not rename fields.
- The agent must not alter CSS, qfmt, afmt, field order, or template count.
- Content may be rewritten freely inside allowed fields.
- Operational metadata such as `learning_intent`, `likely_confusion`, `exam_relevance`, `source_refs`, `candidate_id`, schema labels, or review status must not appear in user-facing card fields.
- APKG export must fail if the format gate detects a non-standard note type with notes.
- `@표준화 Cloze` must be selected by canonical contract fingerprint when possible because the standard APKG contains a second Cloze sample marked as not for use.

## Required Inputs

Every run creates a `source_bundle` before any card writing.

- `lecture`: required unless the run is explicitly tagged as reference-only.
- `previous_anki`: required for the jokbo subdeck when a matching lecture APKG exists in the 딸깍단 Drive `이전안키` folder. The matching APKG provides the base recovered questions for that lecture.
- `current_year_jokbo`: required for exam-production mode when a 2025 or current-year question file exists. These questions are appended to the previous-Anki question set, not mixed into generic JBL concept cards.
- `jokbo`: older PDF/text recovered question sources. Use as a fallback or supplement when previous-Anki/current-year sources are incomplete.
- `tcheck`: optional. If present, t-check cards stay visible as t-check-derived material and must not be silently merged into generic JBL cards.
- `jokbo_style_references`: 한상준/이원재 jokbo subdeck cards used only to learn explanation structure. They are not a direct source of problem content unless they are the matching previous-Anki APKG for the requested lecture.
- `deck_direction`: optional user steering such as density, emphasis, weak areas, preferred explanation style, and exam date pressure.

## Resource Roles

- OpenClaw: receives commands, queues jobs, asks for approval, reports results.
- Hermes/LangGraph: keeps state, routes phases, pauses at approval gates, resumes after approval.
- Mac mini: performs local parsing, APKG profiling, deterministic quality checks, export, and read-back.
- Codex/ChatGPT: writes difficult cards, rewrites AI-smell content, reviews medical explanation quality.
- Copilot: maintains code, schemas, fixtures, tests, PR review, dashboard code, and gate scripts.
- Gemini/Drive: stores source files and produces large-document source digest when needed.
- Perplexity: collects external evidence only when lecture/jokbo sources are insufficient.
- Obsidian/Hostinger: stores run reports, playbook candidates, quality dashboards, and approval artifacts.

## Workflow

```text
Source Intake
-> Source Bundle Contract
-> Reference APKG Style Profile
-> Deck Direction Merge
-> Deck Architect
-> Card Candidate Writer
-> Local Format Gate
-> Local AI-Smell Scan
-> Human Tutor Rewriter
-> Source Fidelity Judge
-> Coverage/Dedupe Gate
-> Preview Pack
-> Approval Gate
-> APKG Export
-> APKG Read-back
-> Dashboard/Obsidian Report
```

## Reference Learning Policy

Reference APKGs from 한상준, 이상훈, and 이원재 are used to create style profiles, not to modify note types.

The profiler extracts:

- note type usage
- field length distribution
- deck/subdeck naming
- cloze density
- jokbo card structure
- t-check deck separation
- explanation density
- human tutor signals such as contrast, why-correct, why-wrong, and likely-confusion wording
- AI-smell pattern counts

The agent uses those profiles to tune rubrics:

- how long explanations should usually be
- when Basic beats Cloze
- when a jokbo card needs option-level explanation
- when a card is too dense
- when a card sounds like a generic AI summary

The profiles do not authorize copying content or changing templates.

## Reference-Derived Production Rules

The 2026-05-22 reference pass inspected 74 APKGs from 한상준, 이상훈, and 이원재: 5,703 notes, 6,515 cards, and no profiler errors. The useful pattern is not a single writing style. It is a source-separated deck structure with enough explanation for a no-base learner and enough option-level detail for exam cards.

Apply these additional rules:

- Keep source lanes visibly separated. Use orientation/background cards before JBL or reference-summary cards; keep t-check, formative assessment, jokbo, and old-jokbo/gobo cards in their own subdecks when those sources exist.
- A single lecture deck usually starts around 35-70 notes. Go above that only when there are many recovered problems, visual diagnosis/procedure content, or a user-approved exam cram mode. Do not inflate card count with generic summary cards.
- Image density should follow the lecture type. Visual/procedure/imaging decks can legitimately have many image cards; text-heavy medical concept decks should use images only when the image lowers cognitive load. Every supporting image still needs a caption and typed searchable explanation.
- Use the first few cards to build a learner path: what the lecture is about, the first discriminator, and the vocabulary needed before harder JBL/jokbo cards. Do not throw a no-base learner directly into a dense gene list, drug list, or old exam option set.
- For `@표준화 뉴족보`, visible options require visible option-level explanation. The best cards explain the answer first, then why the main wrong options are wrong. If options are missing from the recovered source, write `보기 복원 없음` instead of inventing them.
- For t-check or formative-assessment material, preserve source identity in deck path and `source_refs`; do not silently convert it into generic JBL.
- Reference decks may contain strong learning patterns but also contain legacy note types, custom Image Occlusion, and occasional stiff or AI-like wording. Copy the structure and judgment standard, not the template, prose, or unrelated problem content.
- `Image Occlusion`-style learning can be simulated only inside allowed standardized cards, and only when visual recall is genuinely the point. Do not introduce an Image Occlusion note type.
- Prefer compact but meaningful titles. The title should tell what the card is doing, such as `ADPKD 위험도 비교`, `임신 중 금기 항생제`, or `전자간증 진단 기준`, not a full paragraph or hidden metadata.

## Card Type Policy

### `@표준화 Basic`

Use for concept understanding, mechanisms, comparisons, clinical reasoning, and tutor-style explanations.

Required shape:

- `Front`: uses a compact title, not a long question. Prefer forms like `X 정리`, `X 비교`, `X 감별`, `X 적응증`.
- `Back`: answers directly first, then explains why it matters.
- If the answer includes unfamiliar abbreviations or disease names, include one no-base bridge sentence in a natural tutor tone, for example “A라는 뜻으로 보면 됩니다”, “여기서는 A를 고르면 됩니다”, or “A와 B를 이렇게 구분하면 편합니다.”

Avoid:

- broad summary prompts
- one-line glossary cards without context
- “중요하다” without explaining why
- phrases such as “한 축이다” or “로 묶는다”
- stiff tutor register such as “먼저 봅니다”, “관점”, “충분합니다”, “이 조합”, or “더 잘 맞다”
- directional advice such as “떠올리세요”, “떠오른다”, “그쪽으로 생각하세요”, “쪽으로 간다”, “잡아야 한다”, or “잡아두세요”. Prefer direct answer wording such as “X에서는 Y를 고르면 됩니다” or “A라면 B에 해당합니다.”
- difficult terms without a plain-language bridge. For example, do not introduce `표재화/전위` before saying “깊은 정맥을 피부 가까이 올리는 수술”.

Human-tone rewrite rule:

- Do not write prompt-like guidance that tells the learner where to think. Replace it with the clinical or exam judgment itself.
- “손 냉감, 감각 이상, 궤양/괴사가 나오면 그쪽으로 생각하세요” -> “손 냉감, 감각 이상, 궤양/괴사가 같이 있으면 steal syndrome을 고르면 됩니다.”
- “중심정맥 협착 쪽으로 가는 게 자연스럽습니다” -> “팔 전체가 붓고 투석압이 올라가면 중심정맥 협착을 고르면 됩니다.”
- “전체 graft 제거 쪽으로 잡아두세요” -> “감염이 graft 전체로 번졌다면 전체 graft 제거를 고르면 됩니다.”
- “혈관 크기는 vein 2.5, artery 2로 묶어두면 충분합니다” -> “혈관 크기는 정맥 2.5 mm, 동맥 2 mm로 외우면 됩니다.”
- “A는 B로 잡는다/떠오른다” -> “A라면 B에 해당합니다.”
- Avoid a run of stiff plain-form endings such as “~한다. ~된다. ~이다.” in learner-visible fields. Prefer a calm, conversational explanation that still stays precise: “여기서는 A를 고르면 됩니다”, “B라고 보면 됩니다”, “C와 D를 구분하면 편합니다.”
- The target voice is not casual slang. It should feel like a friend explaining exam logic clearly, with enough context for a no-base learner to follow the card.

### `@표준화 Cloze`

Use only when blank deletion improves recall.

Required shape:

- `Text`: includes at least one `{{cN::...}}`.
- `Back Extra`: explains the confusion point or source context if useful.
- Ambiguous polarity, category, or choice recall should use Anki hint syntax, for example `{{c1::answer::category/choice/choice}}`.
- When the cloze hides a difficult abbreviation, `Back Extra` must unpack the term in plain language before adding exam nuance.

Avoid:

- clozing the answer number only
- clozing vague words such as “중요”
- making the sentence unreadable after deletion
- clozing wrong statements as if they were facts; wrong options belong in Back Extra or jokbo explanation

### Comparison Tables

Use a table when several related concepts must be distinguished by mechanism, diagnosis, test direction, treatment clue, or trap.

Required shape:

- Use the standardized readable table opening:
  `<table border="1" style="border-collapse:collapse;width:100%;text-align:center" cellpadding="5">`
- Use a visually separated header row, usually:
  `<tr style="background-color:#f2f2f2">...</tr>`
- Use enough cell padding so text does not touch borders.
- Prefer `@표준화 Cloze` when the table itself is a recall target.
- Cloze only high-yield cells such as key mechanism, diagnosis, test direction, or treatment discriminator. Do not blank the whole row or whole table.

Avoid:

- comparison prose that is harder to scan than a table
- table HTML without borders, collapsed borders, full width, center alignment, or padding
- cloze deletions on low-yield labels that simply test table position

### Image Assets

Use lecture images only when they reduce cognitive load: imaging findings, procedural anatomy, visual algorithms, pathology examples, or dense criteria tables.

Required shape:

- If the card asks the learner to identify the image itself, keep the caption minimal so it does not give away the answer.
- If the image is only supporting explanation, always add a short caption under the image that says what the image explains.
- Preferred caption style: `ADPKD에서 양쪽 콩팥에 낭종이 많이 보이는 모습을 설명하는 이미지입니다.`
- Avoid vague captions such as `그림`, `예시`, `참고`, or captions that merely repeat the filename.

### Humor And Mnemonics

Do not add joke, meme, or forced-funny mnemonic hooks to generated cards.

Reason:

- Forced humor is more likely to feel AI-generated than helpful.
- Medical cards should stay clear, calm, and easy to trust.
- If a memory aid is genuinely useful, write it as a plain explanation inside the answer, not as `암기훅`, `드립`, `농담`, or meme-style language.

### `@표준화 뉴족보`

Use for recovered exam questions only.

Problem source priority:

1. Matching lecture APKG from 딸깍단 Drive `이전안키`.
2. 2025/current-year question file for the same lecture, if available.
3. Older jokbo PDF/text only as supplemental coverage or fallback.

Problem classification rule:

- Before writing any `@표준화 뉴족보` card, read the matching lecture APKG in `이전안키` to decide which recovered problems belong to that lecture.
- Then compare each problem against the current lecture notes or the local hydrated text equivalent.
- Each jokbo card must include `problem_classification` metadata with `source_assignment`, `lecture_support`, `lecture_evidence`, `missing_or_external_points`, and `visible_caveat_required`.
- `lecture_support=direct`: the current lecture note is enough to answer the problem and explain the correct option.
- `lecture_support=partial`: the main answer is supported, but one or more option-level details come only from previous-Anki/jokbo/external memory. If that gap affects solving, the visible explanation must say `현재 강의록 내용만으로는 일부 세부 보기 판단이 어렵습니다.`
- `lecture_support=not_found`: the current lecture note does not support solving the problem. The visible explanation must say `현재 강의록 내용으로 풀기는 어렵습니다.` and should avoid pretending the fact was taught in the current lecture.

Explanation style reference:

- Use 한상준/이원재 jokbo subdecks to learn answer-first structure, option-level explanation density, and no-base-friendly wording.
- Do not copy their unrelated problem content into a new lecture deck.

Required shape:

- `문제번호`: exact recovered exam marker in parentheses, for example `(25-신장학-86)`.
- `본문`: first line must be course + professor + lecture name, for example `신장내과 예시 교수님, 합성 강의`. After that, include the recovered question stem and recovered options.
- `정답 및 해설`: answer first, then why correct, then why common distractors are wrong. If the option set contains unfamiliar abbreviations, explain the category in plain Korean before or during the distractor explanation.

Avoid:

- putting JBL concept cards, trend summaries, or non-question explanations into the jokbo subdeck
- screenshot-only jokbo if a typed version can be reconstructed
- “복원불완전” without a repair note
- duplicate questions across years without merged year markers
- showing options without option-level explanation
- inventing missing choices. If the matching previous-Anki source does not contain the options, write `보기 복원 없음` instead of generating plausible options.

## Quality Gates

### Format Gate

Blocks export when:

- a note with cards uses a non-standard note type
- required fields are missing or empty
- `@표준화 Cloze` has no cloze deletion
- a generated APKG changes canonical field order
- a generated APKG contains notes using default `Basic` or default `Cloze`

### AI-Smell Gate

Flags or blocks:

- “~의 한 축이다”
- “~로 묶는다”
- “~에 기반한다”
- “~측면에서 중요하다”
- “정리하면”
- repeated stiff plain-form endings such as “~한다. ~된다. ~이다.” in Back, Back Extra, or `정답 및 해설`
- content that only says something is important but not why
- compressed lecture prose with no student-facing explanation

### Source Fidelity Gate

Blocks:

- unsupported medical claims
- external-source claims presented as lecture/jokbo facts
- cards without `source_refs`
- jokbo cards missing answer/explanation mapping
- `@표준화 뉴족보` cards that lack a previous-Anki APKG, current-year jokbo, or approved jokbo source
- using 한상준/이원재 style-reference cards as direct problem sources for unrelated lectures
- awkward directional advice such as “단서가 나오면 떠올린다”, “그쪽으로 생각한다”, “잡아두세요”, or “쪽으로 간다”

### Coverage Gate

Reports:

- lecture sections covered
- jokbo items covered
- t-check items covered
- rejected facts and rejection reasons
- duplicate merges
- cards requiring manual review

### Ddalkkak Drive Quality Gate

Adds checks derived from the shared `기타자료모음` guidance:

- `@표준화 뉴족보` body should reserve the hidden first line for professor/course context.
- Jokbo cards with option markers must explain the displayed options, not just the answer.
- Cloze cards with polarity or choice ambiguity should include a hint/category.
- Operational metadata labels must not leak into visible card fields.
- Comparison tables should use `border="1"`, `border-collapse:collapse`, `width:100%`, `text-align:center`, `cellpadding="5"`, and a gray header row.
- Comparison-table cloze cards should hide only targeted high-yield cells, not entire rows or broad prose.
- Deck names should expose exam mode and hierarchy, such as `JBL::과목::주제`.
- Full production decks should separate orientation/background, JBL, jokbo, and t-check or important-lecture material when sources exist.
- Reference-derived deck structure should preserve separate lanes for orientation/background, JBL or 참공, t-check or formative assessment, jokbo, and old-jokbo/gobo when those sources exist.
- Jokbo subdeck problem stems should be populated from the matching `이전안키` APKG first, then supplemented with 2025/current-year questions.
- 2025/current-year questions must be marked in source refs so they can be audited separately from older recovered questions.
- Jokbo cards with recovered options must include option-level explanation in `정답 및 해설`; answer-only explanations are not enough for production.
- Compact card titles are required for `@표준화 Basic`; long question-like titles should be rewritten unless the card intentionally asks an image-identification question.
- Visual decks may have high image density, but image cards still need typed text and captions unless the answer depends on identifying the image itself.

### No-Base Understanding Gate

Blocks or rewrites cards when:

- multiple difficult abbreviations appear without a visible plain-language bridge
- a cloze card asks for an acronym before `Back Extra` explains what the acronym means
- a jokbo card lists obscure options but only says which one is correct
- a Basic card gives a named disease list without teaching the first discriminator a novice should use
- “떠올리면/잡아두세요/그쪽으로 생각” phrasing that sounds like prompt scaffolding rather than a human-written explanation

Positive signals:

- the card tells the learner what to look at first, such as age, family history, dialysis history, organ system, or drug target
- difficult names are unpacked in the same card field, not hidden only in metadata
- tables compare concepts by beginner-visible clues, not only by gene names
- the card says why a tempting wrong path is wrong

### Self-Review Pipeline

Before the user sees a preview queue, candidates must pass local self-review:

```text
card-candidates.preview.json
-> mechanical_format_gate
-> reference_style_judge
-> ai_smell_judge
-> source_fidelity_judge
-> exam_utility_judge
-> novice_understanding_judge
-> routing_gate
```

The output is:

- `self-review-report.json`
- `rewrite-requests.json`
- `user-review-queue.json`
- `self-review-summary.md`

Routing policy:

- `auto_pass`: strong format/source/style scores and no AI smell.
- `rewrite`: fixable wording, explanation, cloze, or style defects.
- `reject`: hard format/schema failure or not worth carding.
- `user_review`: only borderline or source-ambiguous cards.

The user should review only the `user_review` queue after deterministic gates and LLM rewrite attempts have already reduced the workload.

## Approval Gate

No APKG is imported or applied automatically. A run must produce:

- `preview.md`
- `coverage.json`
- `quality-report.json`
- `export-manifest.json`
- `approval_record.json`

Only after approval may the exporter create the APKG. The APKG must then be read back and validated before being presented as usable.

## First Implementation Target

1. `standardized-anki-contract.json`
2. JSON schemas under `schemas/`
3. `scripts/apkg_profiler.py`
4. `scripts/quality_gate.py`
5. Reference corpus generated from 한상준 and 이원재 APKGs
6. A dry-run report showing the gate can reject non-standard note types

## Criteria Collection Artifacts

The first reference collection pass writes:

- `profiles/reference-style-corpus.primary.json`: deck-level and note-type-level metrics from 한상준/이원재 decks.
- `profiles/reference-style-corpus.primary.summary.md`: readable summary of the initial style corpus.
- `profiles/deep-audit/reference-deep-audit.json`: card-level archetype metrics and signal rates.
- `profiles/deep-audit/style-rubric.v1.json`: initial judge rubric derived from reference decks.
- `profiles/deep-audit/reference-card-samples.json`: local-only card samples for manual review and prompt tuning.
- `profiles/deep-audit/bad-pattern-corpus.json`: rewrite/reject examples and blocked wording patterns.
- `profiles/deep-audit/good-deck-criteria.v1.md`: concise human-readable criteria.
- `profiles/source-alignment-candidates.json`: filename/token-based source candidate map for later source-to-card alignment.

These artifacts are inputs to the writer/judge. They are not permission to copy legacy templates or bypass the standardized note type contract.

## Success Criteria

- The system can inspect standard APKG v1.6 and identify canonical note types.
- The system can scan 한상준/이원재 APKGs and produce style metrics.
- The system can reject APKGs containing non-standard note types with notes.
- The system can validate candidate card JSON before export.
- The system can run without paid API calls for profiling and local quality checks.
