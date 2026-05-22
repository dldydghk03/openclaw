# Jokbo Explanation Manual

This manual defines how Anki Factory writes `@표준화 뉴족보` cards. It is public-safe: examples are synthetic and must not contain private lecture/APKG content.

## Goal

Jokbo cards are for recovered exam questions only. A good card lets a no-base learner understand why the answer is correct and why tempting wrong options are wrong.

## Source Priority

1. Matching previous-Anki APKG for the requested lecture.
2. 2025 or current-year question source for the same lecture.
3. Older jokbo PDF/text only as approved supplement or fallback.

Do not use unrelated reference decks as problem sources. 한상준, 이상훈, and 이원재 decks may inform explanation structure, not content copying.

## Required Card Shape

- `문제번호`: exact marker in parentheses, for example `(25-신장학-86)`.
- `본문`: first line must be course, professor, and lecture title, for example `신장내과 예시 교수님, 합성 강의`.
- `본문`: after the first line, include the recovered question stem and recovered options.
- `정답 및 해설`: answer first, then why it is correct, then option-level explanations for the main distractors.

## Lecture Support Classification

Every jokbo card must include `problem_classification`.

- `direct`: current lecture material is enough to answer and explain the problem.
- `partial`: main answer is supported, but one or more option details come from previous-Anki/jokbo/external memory. If that gap affects solving, the visible explanation must say `현재 강의록 내용만으로는 일부 세부 보기 판단이 어렵습니다.`
- `not_found`: current lecture material does not support solving the problem. The visible explanation must say `현재 강의록 내용으로 풀기는 어렵습니다.`

## Explanation Style

Use a direct, natural tutor tone.

- Start with `정답: ...`.
- Explain the solving reason in one short paragraph before option bullets.
- If options are visible, explain more than just the correct option.
- If an abbreviation appears, explain it in plain Korean before relying on it.
- If options are missing, write `보기 복원 없음` instead of inventing plausible options.

Preferred wording:

- `여기서는 ②를 고르면 됩니다.`
- `①은 원인 평가에는 도움이 되지만 첫 검사는 아닙니다.`
- `이름은 비슷하지만 서로 바꾸면 안 됩니다.`
- `현재 강의록 내용으로 풀기는 어렵습니다.`

Avoid:

- `정리하면`, `한 축이다`, `로 묶는다`, `관점`, `더 잘 맞다`, `충분합니다`.
- `단서가 나오면`, `떠올리세요`, `그쪽으로 생각하세요`, `쪽으로 간다`, `잡아두세요`.
- Repeated stiff endings such as `~한다. ~된다. ~이다.` in learner-visible explanations.
- Metadata labels such as `learning_intent`, `source_refs`, `candidate_id`, `problem_classification`, or `lecture_support`.

## Production Checklist

- The card is `standard_new_jokbo`.
- The deck path starts with `03. 족보` or approved formative source-question lane.
- The problem number matches `(YY-신장학-NNN)` or approved formative format.
- The body first line contains course, professor, and lecture title.
- Recovered options are present, or `보기 복원 없음` is visible.
- The explanation discusses multiple options when options are visible.
- Current-lecture support caveats are visible when required.
- The card passes `quality_gate.py` and APKG read-back before import.
