#!/usr/bin/env python3
"""
Parse EMSolutions.md (+ syllabus marks + insights hints) into em-prep/data/content.json.
Source of truth remains the Markdown files — this only normalizes for the app.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOLUTIONS = ROOT / "EMSolutions.md"
SYLLABUS = ROOT / "Syllabus" / "EM.md"
INSIGHTS = ROOT / "insights" / "ENEX-254-EM" / "Insights.md"
OUT = Path(__file__).resolve().parents[1] / "data" / "content.json"

# Exam marks by chapter (Syllabus/EM.md)
CHAPTER_MARKS = {1: 5, 2: 20, 3: 12, 4: 6, 5: 12, 6: 5}
CHAPTER_HOURS = {1: 4, 2: 15, 3: 9, 4: 4, 5: 9, 6: 4}

# Foundation importance (0–1) — Ch1/vector ops underpin later chapters
FOUNDATION = {
    "coordinate": 0.95,
    "vector": 0.9,
    "coulomb": 0.95,
    "gauss": 1.0,
    "divergence": 0.9,
    "potential": 0.85,
    "boundary": 0.9,
    "maxwell": 1.0,
    "faraday": 0.95,
    "displacement": 0.85,
    "wave": 0.9,
    "poynting": 0.8,
    "transmission": 0.75,
    "biot": 0.9,
    "ampere": 0.95,
    "curl": 0.85,
    "laplace": 0.8,
    "poisson": 0.8,
    "dipole": 0.7,
    "reflection": 0.75,
    "swr": 0.7,
}

WHY_MATTERS = {
    1: "Coordinate transforms appear every year; errors here cascade into E/H field problems.",
    2: "Largest exam weight (~20 marks). Gauss, potential, boundaries, and Laplace dominate.",
    3: "High weight (~12). Biot–Savart, Ampere, and curl/Stokes are staples.",
    4: "Moderate weight (~6) but Maxwell/Faraday link statics to waves — high leverage.",
    5: "High weight (~12). Plane waves, Poynting, skin depth, reflection/SWR are frequent.",
    6: "Smaller weight (~5) but short numericals on Zin/Γ/SWR are easy marks if practiced.",
}


def slug(s: str) -> str:
    s = s.lower().replace("’", "'")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:80]


def sid(*parts: str) -> str:
    raw = "|".join(parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def priority_level(score: float) -> str:
    if score >= 90:
        return "P1"
    if score >= 75:
        return "P2"
    if score >= 50:
        return "P3"
    return "P4"


def exam_importance(chapter: int) -> float:
    return CHAPTER_MARKS.get(chapter, 5) / 20.0  # normalize to Ch2 = 1.0


def foundation_score(title: str) -> float:
    t = title.lower()
    best = 0.55
    for key, val in FOUNDATION.items():
        if key in t:
            best = max(best, val)
    if "reference formulas" in t:
        best = max(best, 0.88)
    return best


def mark_efficiency(chapter: int, n_questions: int) -> float:
    marks = CHAPTER_MARKS.get(chapter, 5)
    # more questions ⇒ practiceable ⇒ better marks/time if studied
    q_factor = min(1.0, 0.35 + 0.05 * n_questions)
    return min(1.0, (marks / 20.0) * 0.6 + q_factor * 0.4)


def count_exam_mentions(text: str) -> int:
    # years like 2083 Baishakh, 2075 Chaitra
    return len(re.findall(r"20\d{2}\s+\w+", text))


def extract_formulas(block: str) -> list[str]:
    formulas = []
    for m in re.finditer(r"\$\$(.+?)\$\$", block, re.S):
        f = m.group(1).strip()
        if f and len(f) < 500:
            formulas.append(f)
    # also prominent inline boxed
    for m in re.finditer(r"\\boxed\{([^}]+)\}", block):
        formulas.append(m.group(1).strip())
    return formulas[:40]


def extract_formula_tables(block: str) -> list[dict]:
    """Pull lettered reference tables (e.g. differential elements) for the formula sheet."""
    tables = []
    if not block:
        return tables
    # Ensure first lettered heading is detectable
    text = "\n" + block.strip().replace("\r\n", "\n").replace("\r", "\n")
    parts = re.split(r"\n(?=\*\*\([A-Z]\)\s+)", text)
    for part in parts:
        part = part.strip()
        if not part.startswith("**("):
            continue
        hm = re.match(r"\*\*\(([A-Z])\)\s+(.+?)\*\*", part, re.S)
        if not hm:
            continue
        letter = hm.group(1)
        title = re.sub(r"\s+", " ", hm.group(2)).strip()
        # Collect contiguous markdown table rows (include last row without trailing newline)
        rows: list[str] = []
        for line in part.splitlines():
            if re.match(r"^\|.+\|\s*$", line):
                rows.append(line.rstrip())
            elif rows:
                break
        if len(rows) < 3:
            continue
        md = "\n".join(rows)
        tables.append(
            {
                "id": letter.lower(),
                "code": letter,
                "title": f"({letter}) {title}",
                "markdown": md,
            }
        )
    return tables[:20]


def extract_definitions(block: str) -> list[dict]:
    defs = []
    # sentences that look like definitions
    for m in re.finditer(
        r"(?:^|\n)([A-Z][^.\n]{10,120}?)\s+is\s+([^.\n]{15,200}\.)",
        block,
    ):
        defs.append({"term": m.group(1).strip(), "text": m.group(2).strip()})
        if len(defs) >= 8:
            break
    return defs


def parse_marks_line(line: str) -> dict:
    info = {"marksRaw": line.strip(), "years": [], "marksHint": None}
    years = re.findall(r"20\d{2}\s+[A-Za-z]+", line)
    info["years"] = years
    mm = re.search(r"\[([^\]]+)\]", line)
    if mm:
        info["marksHint"] = mm.group(1)
    return info


def split_question_body(body: str) -> dict:
    """Split question text / solution / answer from a question block."""
    text = body.strip()
    answer = ""
    solution = ""
    question = text

    am = re.search(r"\*\*Answer:\*\*\s*(.+)$", text, re.S | re.M)
    if am:
        answer = am.group(1).strip()
        text = text[: am.start()].rstrip()

    sm = re.search(r"\*\*Solution\*\*\s*", text)
    if sm:
        question = text[: sm.start()].rstrip()
        solution = text[sm.end() :].strip()
    else:
        question = text

    # peel marks line from question
    lines = question.splitlines()
    meta = {"marksRaw": "", "years": [], "marksHint": None}
    q_lines = []
    for i, line in enumerate(lines):
        if i == 0 and (line.startswith("**[") or re.match(r"^\*\*\[", line)):
            meta = parse_marks_line(line.strip("* ").strip("*"))
            # also handle **[1+4] ...**
            meta = parse_marks_line(re.sub(r"^\*\*|\*\*$", "", line).strip())
            continue
        if i == 0 and line.startswith("**") and "[" in line:
            meta = parse_marks_line(line.strip("*"))
            continue
        q_lines.append(line)
    question = "\n".join(q_lines).strip()

    # difficulty heuristic
    difficulty = "medium"
    hint = (meta.get("marksHint") or "")
    try:
        nums = [int(x) for x in re.findall(r"\d+", hint)]
        total = sum(nums) if nums else 5
        if total <= 3:
            difficulty = "easy"
        elif total >= 8:
            difficulty = "hard"
    except Exception:
        pass

    return {
        "question": question,
        "solution": solution,
        "answer": answer,
        "meta": meta,
        "difficulty": difficulty,
    }


def parse_solutions(md: str) -> dict:
    chapters: list[dict] = []
    topics: list[dict] = []
    questions: list[dict] = []

    # strip contents section before first ## Chapter
    m0 = re.search(r"^## Chapter\s+\d+", md, re.M)
    body = md[m0.start() :] if m0 else md

    chap_parts = re.split(r"(?=^## Chapter\s+\d+)", body, flags=re.M)
    for part in chap_parts:
        part = part.strip()
        if not part.startswith("## Chapter"):
            continue
        cm = re.match(r"^## Chapter\s+(\d+)\s+[—\-]\s+(.+)$", part.splitlines()[0])
        if not cm:
            continue
        ch_num = int(cm.group(1))
        ch_title = cm.group(2).strip()
        ch_id = f"ch{ch_num}"
        chapters.append(
            {
                "id": ch_id,
                "number": ch_num,
                "title": ch_title,
                "marks": CHAPTER_MARKS.get(ch_num, 5),
                "hours": CHAPTER_HOURS.get(ch_num, 4),
                "whyMatters": WHY_MATTERS.get(ch_num, ""),
                "topicIds": [],
            }
        )

        # split topics by ###
        topic_chunks = re.split(r"(?=^### )", part, flags=re.M)
        for tchunk in topic_chunks:
            if not tchunk.startswith("### "):
                continue
            tlines = tchunk.splitlines()
            ttitle = tlines[0][4:].strip()
            tbody = "\n".join(tlines[1:]).strip()
            is_ref = "reference formulas" in ttitle.lower()
            tid = f"{ch_id}-{slug(ttitle)}"

            # split questions
            q_parts = re.split(r"(?=^#### Question\s+\d+)", tbody, flags=re.M)
            preamble = ""
            topic_qids: list[str] = []
            first = True
            for qp in q_parts:
                if first and not qp.startswith("#### Question"):
                    preamble = qp.strip()
                    first = False
                    continue
                first = False
                qm = re.match(r"^#### Question\s+(\d+)\s*\n(.*)$", qp, re.S)
                if not qm:
                    continue
                qn = int(qm.group(1))
                parsed = split_question_body(qm.group(2))
                qid = f"{tid}-q{qn}"
                freq = count_exam_mentions(parsed["meta"].get("marksRaw", "") + " " + parsed["question"])
                questions.append(
                    {
                        "id": qid,
                        "topicId": tid,
                        "chapterId": ch_id,
                        "number": qn,
                        "text": parsed["question"],
                        "solution": parsed["solution"],
                        "answer": parsed["answer"],
                        "marksRaw": parsed["meta"].get("marksRaw", ""),
                        "years": parsed["meta"].get("years", []),
                        "marksHint": parsed["meta"].get("marksHint"),
                        "difficulty": parsed["difficulty"],
                        "examMentions": freq,
                        "source": "EMSolutions.md",
                        "type": "long" if (parsed["meta"].get("marksHint") or "").count("+") or (sum(int(x) for x in re.findall(r"\d+", parsed["meta"].get("marksHint") or "5") or [5]) >= 6) else "numerical",
                    }
                )
                topic_qids.append(qid)

            formulas = extract_formulas(preamble)
            formula_tables = extract_formula_tables(preamble)
            if is_ref:
                # keep preamble eqs + body eqs (reference blocks often mix both)
                seen_f = set(formulas)
                for f in extract_formulas(tbody)[:30]:
                    if f not in seen_f:
                        formulas.append(f)
                        seen_f.add(f)
                # merge lettered tables from preamble + body (dedupe by code)
                seen_t = {t.get("code") for t in formula_tables}
                for tb in extract_formula_tables(tbody):
                    if tb.get("code") not in seen_t:
                        formula_tables.append(tb)
                        seen_t.add(tb.get("code"))
            else:
                # topic preambles may also hold essential tables (e.g. dS / dL)
                if not formula_tables:
                    formula_tables = extract_formula_tables(tbody)
            formulas = formulas[:40]

            nq = len(topic_qids)
            # frequency score from question years
            total_mentions = sum(
                next(q["examMentions"] for q in questions if q["id"] == qid)
                for qid in topic_qids
            ) if topic_qids else (3 if is_ref else 1)
            freq_score = min(1.0, total_mentions / max(8, nq * 2) if nq else 0.4)

            ei = exam_importance(ch_num)
            fi = foundation_score(ttitle)
            me = mark_efficiency(ch_num, max(nq, 3 if is_ref else 1))
            # weakness default 0.5 (unknown)
            weakness = 0.5
            # base priority without live weakness (weakness applied in app)
            base = (
                ei * 0.30
                + freq_score * 0.25
                + weakness * 0.20
                + fi * 0.15
                + me * 0.10
            ) * 100

            # boost P1 for high-mark chapters' main topics
            if ch_num == 2 and not is_ref:
                base = max(base, 92)
            if ch_num == 2 and is_ref:
                base = max(base, 90)
            if ch_num in (3, 5) and not is_ref:
                base = max(base, 88)
            if ch_num in (3, 5) and is_ref:
                base = max(base, 82)
            if "maxwell" in ttitle.lower() or "gauss" in ttitle.lower() or "faraday" in ttitle.lower():
                base = max(base, 94)
            if "ampere" in ttitle.lower() or "biot" in ttitle.lower():
                base = max(base, 91)
            if is_ref and ch_num not in (2, 3, 5):
                base = max(base, 72)

            est = 25
            if is_ref:
                est = 20
            elif nq >= 10:
                est = 45
            elif nq >= 6:
                est = 35
            elif nq >= 3:
                est = 30
            else:
                est = 25
            if ch_num == 2:
                est += 5

            topic = {
                "id": tid,
                "chapterId": ch_id,
                "chapterNumber": ch_num,
                "title": ttitle,
                "isReference": is_ref,
                "preamble": preamble,
                "formulas": formulas,
                "formulaTables": formula_tables,
                "definitions": extract_definitions(preamble),
                "questionIds": topic_qids,
                "priorityBase": round(base, 1),
                "priorityLevel": priority_level(base),
                "estimatedMinutes": est,
                "examImportance": round(ei, 3),
                "frequencyScore": round(freq_score, 3),
                "foundationScore": round(fi, 3),
                "markEfficiency": round(me, 3),
                "whyMatters": WHY_MATTERS.get(ch_num, ""),
                "keyPoints": [],
                "commonMistakes": [],
                "recallPrompts": [],
            }

            # key points from preamble bullets / short paras
            for line in preamble.splitlines():
                s = line.strip()
                if s.startswith("- ") or s.startswith("* "):
                    topic["keyPoints"].append(s[2:].strip())
                elif re.match(r"^\*\*[A-Z(]", s) and len(s) < 200:
                    topic["keyPoints"].append(re.sub(r"^\*\*|\*\*$", "", s))
                if len(topic["keyPoints"]) >= 10:
                    break

            # common mistakes heuristics
            low = ttitle.lower()
            if "coordinate" in low or "vector" in low:
                topic["commonMistakes"] = [
                    "Wrong quadrant for φ (use signs of x,y or cosφ=x/ρ).",
                    "Transforming the vector at the wrong point.",
                    "Forgetting magnitude check after transformation.",
                ]
            elif "gauss" in low or "coulomb" in low:
                topic["commonMistakes"] = [
                    "Wrong Gaussian surface for the symmetry.",
                    "Mixing E and D (forget ε).",
                    "Sign/direction errors on line/sheet fields.",
                ]
            elif "boundary" in low:
                topic["commonMistakes"] = [
                    "Swapping normal vs tangential conditions.",
                    "Wrong normal direction â_n.",
                ]
            elif "maxwell" in low or "faraday" in low:
                topic["commonMistakes"] = [
                    "Missing minus sign in Faraday’s law.",
                    "Confusing transformer vs motional EMF.",
                ]
            elif "wave" in low or "poynting" in low or "reflection" in low:
                topic["commonMistakes"] = [
                    "Using wrong η or α/β formulas for the medium.",
                    "Forgetting units on skin depth / SWR.",
                ]
            elif "transmission" in low or "impedance" in low or "line" in low:
                topic["commonMistakes"] = [
                    "Mixing lossless vs general Zin formulas.",
                    "Wrong βℓ or electrical length.",
                ]
            else:
                topic["commonMistakes"] = [
                    "Skipping units on the final answer.",
                    "Using the wrong governing law for the geometry.",
                ]

            # recall prompts
            topic["recallPrompts"] = [
                {
                    "id": f"{tid}-r1",
                    "kind": "definition",
                    "prompt": f"In one sentence, what is the core idea of «{ttitle}»?",
                    "answer": (preamble[:400] + "…") if len(preamble) > 400 else (preamble or topic["whyMatters"]),
                },
                {
                    "id": f"{tid}-r2",
                    "kind": "formula",
                    "prompt": f"Write the most important formula(s) for «{ttitle}».",
                    "answer": "$$\n" + "\n".join(formulas[:3]) + "\n$$" if formulas else "Review reference formulas for this chapter.",
                },
                {
                    "id": f"{tid}-r3",
                    "kind": "concept",
                    "prompt": f"List 3 exam traps for «{ttitle}».",
                    "answer": "\n".join(f"- {m}" for m in topic["commonMistakes"]),
                },
            ]

            topics.append(topic)
            chapters[-1]["topicIds"].append(tid)

    # Attach question IDs to chapters for chapter-wise practice
    for ch in chapters:
        ch["questionIds"] = [q["id"] for q in questions if q["chapterId"] == ch["id"]]
        ch["totalQuestions"] = len(ch["questionIds"])

    return {"chapters": chapters, "topics": topics, "questions": questions}


def parse_insights_enrichment(md: str) -> dict[str, dict]:
    """Map syllabus-like subtopics to intro/formulas from Insights.md."""
    enrich: dict[str, dict] = {}
    if not md:
        return enrich
    parts = re.split(r"(?=^###\s+\d+\.\d+)", md, flags=re.M)
    for part in parts:
        m = re.match(r"^###\s+(\d+\.\d+)\s+(.+)$", part.splitlines()[0] if part.strip() else "")
        if not m:
            continue
        code, title = m.group(1), m.group(2).strip()
        intro = ""
        im = re.search(r"\*\*Introduction\.\*\*\s*(.+?)(?=\*\*Key formulas|\*\*Numerical|\n### |\Z)", part, re.S)
        if im:
            intro = im.group(1).strip()
        formulas = extract_formulas(part)[:15]
        enrich[code] = {"title": title, "intro": intro, "formulas": formulas}
    return enrich


def generate_mcqs(topics: list[dict], questions: list[dict]) -> list[dict]:
    """Generate practice MCQs from topic formulas and question answers (no source MCQs)."""
    mcqs: list[dict] = []
    by_topic = {t["id"]: t for t in topics}

    # Formula identification MCQs
    for t in topics:
        for i, f in enumerate(t.get("formulas") or []):
            if i >= 3:
                break
            if len(f) < 8:
                continue
            mid = f"{t['id']}-mcq-f{i}"
            # distractors from other formulas in same chapter
            others = []
            for ot in topics:
                if ot["chapterId"] != t["chapterId"] or ot["id"] == t["id"]:
                    continue
                others.extend(ot.get("formulas") or [])
            distractors = [d for d in others if d != f][:3]
            while len(distractors) < 3:
                distractors.append("Not defined for this medium")
            options = [f"$${f}$$"] + [f"$${d}$$" if d.startswith("\\") or "^" in d or "_" in d else d for d in distractors[:3]]
            # shuffle deterministically
            order = sorted(range(4), key=lambda k: sid(mid, str(k)))
            # rebuild so correct is at position of 0 after shuffle mapping
            raw = options[:4]
            while len(raw) < 4:
                raw.append("None of these")
            shuffled = [raw[k] for k in order]
            # find where original correct (index 0) went
            # Actually order permutes indices of raw; shuffled[j]=raw[order[j]]
            # correct was raw[0]; find j where order[j]==0
            correct = order.index(0) if 0 in order else 0
            # Fix: order as sort key of indices — recompute properly
            idxs = list(range(4))
            idxs.sort(key=lambda k: sid(mid, f"opt{k}"))
            shuffled = [raw[k] for k in idxs]
            correct = idxs.index(0)

            mcqs.append(
                {
                    "id": mid,
                    "topicId": t["id"],
                    "chapterId": t["chapterId"],
                    "question": f"Which expression belongs to «{t['title']}»?",
                    "options": shuffled,
                    "correctAnswer": correct,
                    "explanation": f"Core formula from {t['title']}.",
                    "difficulty": "medium",
                    "source": "generated-from-formulas",
                }
            )

    # Answer-spotting MCQs from numerical answers
    for q in questions:
        if not q.get("answer"):
            continue
        if q["number"] % 3 != 1:  # subsample
            continue
        ans = q["answer"]
        # strip boxed
        ans_clean = re.sub(r"^\$\\boxed\{|\}\$$", "", ans).strip()
        if len(ans_clean) < 8:
            continue
        topic = by_topic.get(q["topicId"])
        if not topic:
            continue
        # distractors: other answers in topic
        siblings = [
            re.sub(r"^\$\\boxed\{|\}\$$", "", qq["answer"]).strip()
            for qq in questions
            if qq["topicId"] == q["topicId"] and qq["id"] != q["id"] and qq.get("answer")
        ]
        distractors = siblings[:3]
        while len(distractors) < 3:
            distractors.append("Insufficient data / undefined")
        raw = [ans] + distractors[:3]
        mid = f"{q['id']}-mcq"
        idxs = list(range(4))
        idxs.sort(key=lambda k: sid(mid, f"a{k}"))
        shuffled = [raw[k] for k in idxs]
        correct = idxs.index(0)
        # Prefer a clean stem: strip display math, avoid mid-expression truncation
        stem_src = re.sub(r"\$\$[\s\S]+?\$\$", " ", q["text"])
        stem_src = re.sub(r"\s+", " ", stem_src).strip()
        if len(stem_src) > 160:
            cut = stem_src[:160]
            # don't end inside $...$
            if cut.count("$") % 2 == 1:
                cut = cut.rsplit("$", 1)[0]
            stem_src = cut.rstrip(" ,;:") + "…"
        mcqs.append(
            {
                "id": mid,
                "topicId": q["topicId"],
                "chapterId": q["chapterId"],
                "question": f"For the exam problem: {stem_src}\n\nPick the correct final result.",
                "options": shuffled,
                "correctAnswer": correct,
                "explanation": f"From EMSolutions.md — {topic['title']} Question {q['number']}.",
                "difficulty": q.get("difficulty", "medium"),
                "source": "generated-from-answers",
                "linkedQuestionId": q["id"],
            }
        )

    # Conceptual MCQs for key chapters
    bank = [
        ("ch2", "Gauss’s law in differential form is", ["$\\nabla\\cdot\\mathbf{D}=\\rho_v$", "$\\nabla\\times\\mathbf{E}=-\\partial\\mathbf{B}/\\partial t$", "$\\nabla\\cdot\\mathbf{B}=0$", "$\\nabla\\times\\mathbf{H}=\\mathbf{J}$"], 0, "Gauss: divergence of D equals volume charge density."),
        ("ch3", "Ampere’s circuital law (magnetostatics) states", ["$\\oint\\mathbf{H}\\cdot d\\mathbf{L}=I_{\\mathrm{enc}}$", "$\\oint\\mathbf{E}\\cdot d\\mathbf{L}=-d\\Phi_B/dt$", "$\\nabla\\cdot\\mathbf{D}=\\rho_v$", "$\\mathbf{B}=\\mu_0\\mathbf{H}+\\mathbf{M}$"], 0, "Ampere: circulation of H equals enclosed current."),
        ("ch4", "Faraday’s law (point form) is", ["$\\nabla\\times\\mathbf{E}=-\\partial\\mathbf{B}/\\partial t$", "$\\nabla\\times\\mathbf{H}=\\mathbf{J}+\\partial\\mathbf{D}/\\partial t$", "$\\nabla\\cdot\\mathbf{B}=0$", "$\\nabla\\cdot\\mathbf{D}=\\rho_v$"], 0, "Curl of E equals negative rate of change of B."),
        ("ch5", "Intrinsic impedance of free space η₀ is approximately", ["$377\\,\\Omega$", "$50\\,\\Omega$", "$120\\pi\\times10^{-7}\\,\\Omega$", "$3\\times10^8\\,\\Omega$"], 0, "η₀ = √(μ₀/ε₀) ≈ 377 Ω."),
        ("ch6", "For a lossless line, SWR = 1 means", ["Matched load ($Z_L=Z_0$)", "Open circuit load", "Short circuit load", "Purely reactive load"], 0, "SWR=1 ⟺ no reflection ⟺ matched load."),
        ("ch1", "Cylindrical radius ρ equals", ["$\\sqrt{x^2+y^2}$", "$\\sqrt{x^2+y^2+z^2}$", "$z$", "$x/y$"], 0, "ρ is the projection onto the xy-plane."),
    ]
    for ch, prompt, opts, correct, expl in bank:
        # attach to first non-ref topic in chapter
        t = next((x for x in topics if x["chapterId"] == ch and not x["isReference"]), topics[0])
        mcqs.append(
            {
                "id": f"{ch}-concept-{sid(prompt)}",
                "topicId": t["id"],
                "chapterId": ch,
                "question": prompt,
                "options": opts,
                "correctAnswer": correct,
                "explanation": expl,
                "difficulty": "easy",
                "source": "curated-concept",
            }
        )

    return mcqs


def build_revision_cards(topics: list[dict]) -> list[dict]:
    cards = []
    for t in topics:
        if t.get("formulas"):
            cards.append(
                {
                    "id": f"{t['id']}-card-f",
                    "topicId": t["id"],
                    "chapterId": t["chapterId"],
                    "kind": "formula",
                    "front": f"Key formulas — {t['title']}",
                    "back": "$$\n" + "\\\\\n".join(t["formulas"][:5]) + "\n$$",
                }
            )
        for i, m in enumerate(t.get("commonMistakes") or []):
            cards.append(
                {
                    "id": f"{t['id']}-card-m{i}",
                    "topicId": t["id"],
                    "chapterId": t["chapterId"],
                    "kind": "mistake",
                    "front": f"Common trap — {t['title']}",
                    "back": m,
                }
            )
        if t.get("whyMatters"):
            cards.append(
                {
                    "id": f"{t['id']}-card-why",
                    "topicId": t["id"],
                    "chapterId": t["chapterId"],
                    "kind": "concept",
                    "front": f"Why study {t['title']}?",
                    "back": t["whyMatters"],
                }
            )
    return cards


def tokenize(title: str) -> set[str]:
    s = slug(title)
    stop = {
        "and", "or", "of", "the", "a", "an", "in", "on", "to", "for", "with",
        "its", "their", "from", "by", "as", "at", "into", "via", "law", "laws",
    }
    return {w for w in s.split("-") if w and w not in stop and len(w) > 1}


def parse_syllabus(md: str) -> dict:
    """Parse Syllabus/EM.md Course Contents into chapters + numbered topics."""
    chapters: list[dict] = []
    topics: list[dict] = []

    # Course Contents section only
    m = re.search(r"## Course Contents\s*(.*?)(?=\n## |\Z)", md, re.S)
    body = m.group(1) if m else md

    chap_blocks = re.split(r"(?=^###\s+\d+\.)", body, flags=re.M)
    for block in chap_blocks:
        cm = re.match(
            r"^###\s+(\d+)\.\s+(.+?)\s*\((\d+)\s*hours?\)\s*$",
            block.splitlines()[0].strip() if block.strip() else "",
        )
        if not cm:
            continue
        num = int(cm.group(1))
        title = cm.group(2).strip()
        hours = int(cm.group(3))
        ch_id = f"syl-ch{num}"
        topic_ids: list[str] = []
        for line in block.splitlines()[1:]:
            tm = re.match(r"^(\d+\.\d+)\s+(.+?)\s*$", line.strip())
            if not tm:
                continue
            code = tm.group(1)
            ttitle = tm.group(2).strip().rstrip(".")
            tid = f"syl-{code.replace('.', '-')}"
            topic_ids.append(tid)
            topics.append(
                {
                    "id": tid,
                    "code": code,
                    "chapterId": ch_id,
                    "chapterNumber": num,
                    "title": ttitle,
                    "description": ttitle,
                    "hoursHint": None,
                    "estimatedMinutes": max(20, min(45, 12 + len(ttitle.split()) * 2)),
                    "studyTopicIds": [],
                    "questionIds": [],
                    "mcqIds": [],
                    "priorityBase": round(50 + CHAPTER_MARKS.get(num, 5) * 2.2, 1),
                    "priorityLevel": priority_level(50 + CHAPTER_MARKS.get(num, 5) * 2.2),
                    "hasStudyMaterial": False,
                    "hasQuestions": False,
                    "hasMcqs": False,
                }
            )
        chapters.append(
            {
                "id": ch_id,
                "number": num,
                "title": title,
                "hours": hours,
                "marks": CHAPTER_MARKS.get(num, 5),
                "studyChapterId": f"ch{num}",
                "topicIds": topic_ids,
                "whyMatters": WHY_MATTERS.get(num, ""),
            }
        )

    # boost P1 for high-mark chapter topics
    for t in topics:
        if t["chapterNumber"] == 2:
            t["priorityBase"] = max(t["priorityBase"], 92)
            t["priorityLevel"] = priority_level(t["priorityBase"])
        elif t["chapterNumber"] in (3, 5):
            t["priorityBase"] = max(t["priorityBase"], 84)
            t["priorityLevel"] = priority_level(t["priorityBase"])
        # named critical
        low = t["title"].lower()
        if any(k in low for k in ("gauss", "maxwell", "ampere", "faraday", "biot")):
            t["priorityBase"] = max(t["priorityBase"], 94)
            t["priorityLevel"] = "P1"

    return {"chapters": chapters, "topics": topics}


def map_syllabus_to_study(syllabus: dict, study_topics: list[dict], questions: list[dict], mcqs: list[dict]) -> None:
    """Attach studyTopicIds / questionIds / mcqIds onto syllabus topics via chapter + keyword overlap."""
    study_by_ch: dict[int, list[dict]] = {}
    for st in study_topics:
        study_by_ch.setdefault(st.get("chapterNumber") or int(st["chapterId"].replace("ch", "")), []).append(st)

    for syl in syllabus["topics"]:
        chn = syl["chapterNumber"]
        candidates = study_by_ch.get(chn, [])
        sw = tokenize(syl["title"])
        scored: list[tuple[float, dict]] = []
        for st in candidates:
            if st.get("isReference"):
                continue
            tw = tokenize(st["title"])
            if not tw:
                continue
            inter = len(sw & tw)
            union = len(sw | tw) or 1
            jacc = inter / union
            # boost if any significant keyword hits
            hit = inter / (len(sw) or 1)
            score = jacc * 0.55 + hit * 0.45
            # special compound topics: allow multiple matches
            if score >= 0.18 or inter >= 2:
                scored.append((score, st))
        scored.sort(key=lambda x: -x[0])
        limit = 4 if len(sw) >= 5 else 2
        chosen = [st for sc, st in scored if sc >= 0.12][:limit]
        if not chosen and candidates:
            # fallback: non-reference topics in chapter (safe weak link)
            chosen = [c for c in candidates if not c.get("isReference")][:1]

        syl["studyTopicIds"] = [c["id"] for c in chosen]
        qids: list[str] = []
        for c in chosen:
            qids.extend(c.get("questionIds") or [])
        # de-dupe preserve order
        seen = set()
        uniq = []
        for qid in qids:
            if qid not in seen:
                seen.add(qid)
                uniq.append(qid)
        syl["questionIds"] = uniq
        mids = [m["id"] for m in mcqs if m.get("topicId") in set(syl["studyTopicIds"])]
        syl["mcqIds"] = mids
        syl["hasStudyMaterial"] = bool(chosen)
        syl["hasQuestions"] = bool(uniq)
        syl["hasMcqs"] = bool(mids)

    # reverse index on study topics
    reverse: dict[str, list[str]] = {}
    for syl in syllabus["topics"]:
        for sid in syl["studyTopicIds"]:
            reverse.setdefault(sid, []).append(syl["id"])
    for st in study_topics:
        st["syllabusTopicIds"] = reverse.get(st["id"], [])


def main() -> None:
    sol = SOLUTIONS.read_text(encoding="utf-8")
    parsed = parse_solutions(sol)
    insights = INSIGHTS.read_text(encoding="utf-8") if INSIGHTS.exists() else ""
    enrich = parse_insights_enrichment(insights)

    # attach insights intros to closest topic by keyword overlap
    for t in parsed["topics"]:
        best = None
        best_score = 0
        twords = set(slug(t["title"]).split("-"))
        for code, info in enrich.items():
            iwords = set(slug(info["title"]).split("-"))
            score = len(twords & iwords)
            if score > best_score:
                best_score = score
                best = info
        if best and best_score >= 1:
            t["examDefinition"] = best.get("intro", "")
            if best.get("formulas") and not t["formulas"]:
                t["formulas"] = best["formulas"]
            elif best.get("formulas"):
                # merge unique
                seen = set(t["formulas"])
                for f in best["formulas"]:
                    if f not in seen:
                        t["formulas"].append(f)
                        seen.add(f)

    mcqs = generate_mcqs(parsed["topics"], parsed["questions"])
    cards = build_revision_cards(parsed["topics"])

    syl_md = SYLLABUS.read_text(encoding="utf-8") if SYLLABUS.exists() else ""
    syllabus = parse_syllabus(syl_md) if syl_md else {"chapters": [], "topics": []}
    if syllabus["topics"]:
        map_syllabus_to_study(syllabus, parsed["topics"], parsed["questions"], mcqs)

    content = {
        "meta": {
            "subject": "Electromagnetics",
            "code": "ENEX 254",
            "title": "EM — 4-Day Exam Survival",
            "sourceFiles": ["EMSolutions.md", "Syllabus/EM.md", "insights/ENEX-254-EM/Insights.md"],
            "syllabusSource": "Syllabus/EM.md",
            "questionsSource": "EMSolutions.md",
            "totalMarks": 60,
            "defaultExamDays": 4,
            "chapterMarks": CHAPTER_MARKS,
            "generatedNote": "Syllabus hierarchy from Syllabus/EM.md; questions/solutions from EMSolutions.md. Rebuild after editing either.",
        },
        "chapters": parsed["chapters"],
        "topics": parsed["topics"],
        "questions": parsed["questions"],
        "mcqs": mcqs,
        "revisionCards": cards,
        "syllabus": syllabus,
        "checklistTemplate": [
            "Understand concept",
            "Memorize definition",
            "Learn formulas",
            "Understand derivation",
            "Study example",
            "Solve exam questions",
            "Attempt MCQs",
            "Review mistakes",
            "Perform active recall",
            "Mark topic mastered",
        ],
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
    mapped = sum(1 for t in syllabus["topics"] if t["hasStudyMaterial"])
    with_q = sum(1 for t in syllabus["topics"] if t["hasQuestions"])
    print(
        f"Wrote {OUT}\n"
        f"  study: chapters={len(content['chapters'])} topics={len(content['topics'])} "
        f"questions={len(content['questions'])} mcqs={len(content['mcqs'])}\n"
        f"  syllabus: chapters={len(syllabus['chapters'])} topics={len(syllabus['topics'])} "
        f"mapped={mapped} withQuestions={with_q}"
    )


if __name__ == "__main__":
    main()
