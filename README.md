# EM — 4-Day Exam Survival System

Exam command center for **ENEX 254 Electromagnetics**.

## Two sources of truth

| File | Role |
|------|------|
| [`../Syllabus/EM.md`](../Syllabus/EM.md) | Official syllabus → Coverage / what's left |
| [`../EMSolutions.md`](../EMSolutions.md) | Solved questions → Question bank / chapter practice |
| [`../insights/ENEX-254-EM/Insights.md`](../insights/ENEX-254-EM/Insights.md) | Formula / definition enrichment |

```bash
python em-prep/tools/build_content.py
python -m http.server 8080
```

Open: http://localhost:8080/em-prep/

## Local user progress (IndexedDB)

- First visit creates `local_<UUID>` and empty progress
- Progress is **per user** (`users` + `progress` object stores)
- Survives refresh / restart
- **Settings → Reset Progress** requires typing `RESET`
- Export / Import are user-scoped; Import asks for confirmation
- Official completion (studied / mastered / revised) requires a confirmation card

## Features

- Syllabus coverage tree (35 topics from `Syllabus/EM.md`)
- Chapter-wise **Formula sheet** + PDF download (print → Save as PDF)
- Coverage vs mastery (separate metrics)
- What's left + estimated remaining study time
- Chapter-wise question practice (177 Q from `EMSolutions.md`)
- Dashboard next-best-action uses syllabus gaps
- Mistake book, MCQs, revision, mock
# ENEX-254
